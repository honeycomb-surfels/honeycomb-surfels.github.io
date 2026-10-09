/**
 * Interactive "Sharpness without moving the edge" (theory.html, hexel_sharpness): the support weight
 * K(u, v) = sigma(-beta d(u, v)) of one Hexel as a heat map with its dashed K = 1/2 outline, the sharpness beta on a
 * log-scale slider from 2 to 32, and the profile K(0, v) along the slice u = 0: faint curves for beta = 2, 8 and 32,
 * the current beta bold, and open circles at v = -1 and 1, where K = 1/2 for every beta. The knob of the figure's own
 * slider drags, and its labels 2, 8 and 32 jump to their beta; an HTML slider does the same. Pointing at the heat map
 * or the profile (or tapping it) reads K there and marks the point of the slice with the same distance d.
 *
 * The math, constants, colors and layout are those of hex_boundary(), hex_support(), beta_color() and
 * draw_hexel_sharpness() in tools/make_theory_animations.py, and the heat map uses the script's SUPPORT_MAP with its
 * 256 levels. The default state is the poster frame (loop phase 0.24): beta = 8.
 */
import {
  COLORS,
  FONT,
  HEX_VERTICES,
  PT,
  canvasStage,
  canvasText,
  clamp,
  cssVar,
  dragHandles,
  el,
  flip,
  group,
  htmlLabel,
  icon,
  mix,
  readout,
  rgb,
  signed,
  slider,
  snap,
  textColor,
  toRgb,
} from "./core.js";

export const hint = "Drag the β knob or click 2, 8 or 32; point at the heat map to read K.";
const TOUCH_HINT = "Drag the β knob or tap 2, 8 or 32; tap the heat map to read K.";

const SQRT3 = Math.sqrt(3);

// tools/make_theory_animations.py, section 2 (hexel_sharpness), in layout units (origin top left).
const EXTENT = 2.4; // SHARP_EXTENT: the heat map and the slice cover [-2.4, 2.4]
const HEAT = { left: 14, top: flip(30 + 320), size: 320 }; // px_rect(14, 30, 320, 320)
const BAR = { left: 344, top: flip(112 + 150), width: 12, height: 150 }; // the colorbar, px_rect(344, 112, 12, 150)
const PLOT = { left: 482, top: flip(96 + 168), width: 226, height: 168, ymax: 1.04 }; // px_rect(482, 96, 226, 168)
const TRACK = { left: 548, right: 698, y: flip(330), tick: 5, label: flip(318), knob: 7 }; // the beta slider
const BETA_RANGE = [2, 32];
const BETAS = [2, 8, 32];
const BETA_STYLES = { 2: [4, 2], 8: [1, 1.6], 32: null }; // BETA_STYLES: dashes in points, before scaling by lw
const SUPPORT_LOW = toRgb(COLORS.support[0]);
const SUPPORT_HIGH = toRgb(COLORS.support[1]);
const LEVELS = 256; // SUPPORT_MAP's lookup table
// SUPPORT_MAP's 256 colors as bytes, three per level.
const LEVEL_COLORS = Uint8ClampedArray.from({ length: 3 * LEVELS }, (_, n) => {
  const [level, channel] = [Math.floor(n / 3), n % 3];
  return Math.round(255 * (SUPPORT_LOW[channel] + (level / (LEVELS - 1)) * (SUPPORT_HIGH[channel] - SUPPORT_LOW[channel])));
});
const DISTANCE_BINS = 16384; // the table over d: K moves by less than a quarter level between bins at beta = 32
const REST_BETA = 8; // the poster frame
const TICK = { length: 3 * PT, width: 0.8 * PT, gap: (3 + 2.5) * PT }; // format_axis(): tick length, width, pad
const BAR_TICK = { length: 2.5 * PT, gap: (2.5 + 2) * PT };
const PROBE_GAP = { x: 12, y: 8, clear: 10 }; // from the point read to its label, and the room kept around K = 1/2

/** hex_boundary(): d(u, v), negative inside the canonical hexagon, 0 on it. */
function boundary(u, v) {
  return Math.max(Math.abs(v), Math.abs((SQRT3 / 2) * u + v / 2), Math.abs((SQRT3 / 2) * u - v / 2)) - 1;
}

/** hex_support(): K(u, v) = sigma(-beta d(u, v)). */
function support(u, v, beta) {
  return 1 / (1 + Math.exp(beta * boundary(u, v)));
}

/** beta_color(): the paper's beta colors interpolated in log2(beta). */
function betaColor(beta) {
  const x = Math.log2(beta);
  return x <= 3 ? mix(COLORS.beta[2], COLORS.beta[8], (x - 1) / 2) : mix(COLORS.beta[8], COLORS.beta[32], (x - 3) / 2);
}

// Layout coordinates of the panels.
const heatX = (u) => HEAT.left + ((u + EXTENT) / (2 * EXTENT)) * HEAT.size;
const heatY = (v) => HEAT.top + HEAT.size - ((v + EXTENT) / (2 * EXTENT)) * HEAT.size;
const plotX = (v) => PLOT.left + ((v + EXTENT) / (2 * EXTENT)) * PLOT.width;
const plotY = (k) => PLOT.top + PLOT.height - (k / PLOT.ymax) * PLOT.height;
const trackX = (beta) => TRACK.left + ((TRACK.right - TRACK.left) * (Math.log2(beta) - 1)) / 4;
const inHeat = ({ x, y }) => x >= HEAT.left && x <= HEAT.left + HEAT.size && y >= HEAT.top && y <= HEAT.top + HEAT.size;
const inPlot = ({ x, y }) => x >= PLOT.left && x <= PLOT.left + PLOT.width && y >= PLOT.top && y <= PLOT.top + PLOT.height;

const scratch = document.createElement("canvas").getContext("2d");

/** A tick label with matplotlib's va = "center_baseline": its anchor halfway between the top of its box and the baseline. */
function centerBaselineText(ctx, text, x, y, options) {
  const box = canvasText(scratch, text, 0, 0, { ...options, alpha: 0 });
  return canvasText(ctx, text, x, y + (box.height - box.depth) / 2, { ...options, align: "baseline" });
}

function line(ctx, points) {
  ctx.beginPath();
  points.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
}

function circle(ctx, x, y, radius) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
}

/** The slice K(0, v) across the plot, at every half layout unit. */
function slicePoints(beta) {
  const points = [];
  const steps = Math.ceil(2 * PLOT.width);
  for (let i = 0; i <= steps; i += 1) {
    const v = -EXTENT + (2 * EXTENT * i) / steps;
    points.push([plotX(v), plotY(support(0, v, beta))]);
  }
  return points;
}

export function mount(container, { stage, controls, setHint }) {
  const state = { beta: REST_BETA };
  const select = cssVar("--hx-select") || "#5d70ae";
  const ink = rgb(COLORS.ink);
  const guide = rgb(COLORS.guide);
  const heat = document.createElement("canvas");
  const heatContext = heat.getContext("2d");
  let heatKey = "";
  let distances = null; // d(u, v) per pixel of the heat map: { width, height, values, low, high }
  let image = null;
  let probe = null; // { u, v } of the point being read, or null
  let hovered = false; // the knob
  let dragging = false;
  let lastPointer = "mouse";

  const view = canvasStage(stage, draw);

  /**
   * The heat map of K at device resolution, recomputed only when beta or the canvas size changes. K depends on d(u, v)
   * alone, so d is kept per pixel for the canvas size, and each beta maps it to a color level through a table over d.
   */
  function paintHeat(ctx) {
    const { a: rx, d: ry } = ctx.getTransform();
    const left = Math.round(HEAT.left * rx);
    const top = Math.round(HEAT.top * ry);
    const width = Math.round((HEAT.left + HEAT.size) * rx) - left;
    const height = Math.round((HEAT.top + HEAT.size) * ry) - top;
    const key = `${state.beta}:${width}x${height}`;
    if (key !== heatKey) {
      if (distances?.width !== width || distances?.height !== height) {
        const values = new Float32Array(width * height);
        let [low, high] = [Infinity, -Infinity];
        for (let j = 0; j < height; j += 1) {
          const v = EXTENT - (2 * EXTENT * (j + 0.5)) / height;
          for (let i = 0; i < width; i += 1) {
            const d = boundary(-EXTENT + (2 * EXTENT * (i + 0.5)) / width, v);
            values[j * width + i] = d;
            low = Math.min(low, d);
            high = Math.max(high, d);
          }
        }
        distances = { width, height, values, low, high };
        heat.width = width;
        heat.height = height;
        image = heatContext.createImageData(width, height);
      }
      const { values, low, high } = distances;
      const perBin = DISTANCE_BINS / (high - low);
      const levels = new Uint16Array(DISTANCE_BINS + 1);
      for (let bin = 0; bin <= DISTANCE_BINS; bin += 1) {
        const value = 1 / (1 + Math.exp(state.beta * (low + bin / perBin)));
        levels[bin] = 3 * Math.min(Math.floor(value * LEVELS), LEVELS - 1);
      }
      const data = image.data;
      for (let n = 0, k = 0; n < values.length; n += 1, k += 4) {
        const level = levels[Math.round((values[n] - low) * perBin)];
        data[k] = LEVEL_COLORS[level];
        data[k + 1] = LEVEL_COLORS[level + 1];
        data[k + 2] = LEVEL_COLORS[level + 2];
        data[k + 3] = 255;
      }
      heatContext.putImageData(image, 0, 0);
      heatKey = key;
    }
    ctx.drawImage(heat, left / rx, top / ry, width / rx, height / ry);
  }

  function draw(ctx) {
    const beta = state.beta;
    const color = rgb(betaColor(beta));

    /* The heat map, its dashed K = 1/2 hexagon, the slice u = 0 and its frame. */
    paintHeat(ctx);
    ctx.save();
    ctx.lineJoin = "round";
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.5 * PT;
    ctx.setLineDash([3 * 1.5 * PT, 2.4 * 1.5 * PT]);
    line(ctx, [...HEX_VERTICES, HEX_VERTICES[0]].map(([u, v]) => [heatX(u), heatY(v)]));
    ctx.stroke();
    ctx.strokeStyle = guide;
    ctx.lineWidth = 1.1 * PT;
    ctx.setLineDash([1 * 1.1 * PT, 2.4 * 1.1 * PT]);
    line(ctx, [[heatX(0), heatY(-EXTENT)], [heatX(0), heatY(EXTENT)]]);
    ctx.stroke();
    ctx.restore();
    canvasText(ctx, "$K=$½", heatX(0.62), heatY(1.1), { size: FONT.label, align: "bottom", halo: true });
    ctx.strokeStyle = guide;
    ctx.lineWidth = 0.9 * PT;
    ctx.strokeRect(HEAT.left, HEAT.top, HEAT.size, HEAT.size);

    /* The colorbar with its ticks 0, 1/2 and 1. */
    const ramp = ctx.createLinearGradient(0, BAR.top + BAR.height, 0, BAR.top);
    ramp.addColorStop(0, rgb(SUPPORT_LOW));
    ramp.addColorStop(1, rgb(SUPPORT_HIGH));
    ctx.fillStyle = ramp;
    ctx.fillRect(BAR.left, BAR.top, BAR.width, BAR.height);
    ctx.strokeStyle = guide;
    ctx.lineWidth = 0.8 * PT;
    ctx.strokeRect(BAR.left, BAR.top, BAR.width, BAR.height);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 0.8 * PT;
    ["0", "½", "1"].forEach((label, k) => {
      const y = BAR.top + BAR.height * (1 - k / 2);
      line(ctx, [[BAR.left + BAR.width, y], [BAR.left + BAR.width + BAR_TICK.length, y]]);
      ctx.stroke();
      centerBaselineText(ctx, label, BAR.left + BAR.width + BAR_TICK.gap, y, { size: FONT.small });
    });
    canvasText(ctx, "$K$", 350, flip(272), { size: FONT.label, anchor: "middle", align: "bottom" });

    /* The formula, beta, and the log-scale slider of the animation. */
    canvasText(ctx, "$K(u,v)=\\sigma(-\\beta\\, d(u,v))$", 566, flip(386), { size: FONT.formula, anchor: "middle", align: "top" });
    canvasText(ctx, `$\\beta=${beta.toFixed(1)}$`, 420, flip(326), { size: FONT.big, align: "middle", color: textColor(betaColor(beta)) });
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = guide;
    ctx.lineWidth = 1.6 * PT;
    line(ctx, [[TRACK.left, TRACK.y], [TRACK.right, TRACK.y]]);
    ctx.stroke();
    for (const b of BETAS) {
      ctx.strokeStyle = rgb(COLORS.beta[b]);
      line(ctx, [[trackX(b), TRACK.y + TRACK.tick], [trackX(b), TRACK.y - TRACK.tick]]);
      ctx.stroke();
      canvasText(ctx, String(b), trackX(b), TRACK.label, { size: FONT.small, anchor: "middle", align: "top", color: textColor(COLORS.beta[b]) });
    }
    ctx.restore();
    const knob = trackX(beta);
    if (hovered || dragging) {
      ctx.save();
      ctx.globalAlpha = dragging ? 0.28 : 0.18;
      ctx.fillStyle = select;
      circle(ctx, knob, TRACK.y, 15);
      ctx.fill();
      ctx.restore();
    }
    circle(ctx, knob, TRACK.y, TRACK.knob);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.4 * PT;
    ctx.stroke();

    /* The profile K(0, v): faint beta = 2, 8, 32, the current beta bold, the fixed points at v = -1 and 1. */
    ctx.save();
    ctx.strokeStyle = guide;
    ctx.lineWidth = 0.9 * PT;
    ctx.setLineDash([2 * 0.9 * PT, 2 * 0.9 * PT]);
    for (const v of [-1, 1]) {
      line(ctx, [[plotX(v), PLOT.top], [plotX(v), PLOT.top + PLOT.height]]);
      ctx.stroke();
    }
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(PLOT.left, PLOT.top, PLOT.width, PLOT.height);
    ctx.clip();
    ctx.lineJoin = "round";
    for (const b of BETAS) {
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = rgb(COLORS.beta[b]);
      ctx.lineWidth = 1.5 * PT;
      ctx.setLineDash(BETA_STYLES[b] ? BETA_STYLES[b].map((dash) => dash * 1.5 * PT) : []);
      ctx.lineCap = BETA_STYLES[b] ? "butt" : "round";
      line(ctx, slicePoints(b));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.lineCap = "round";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.8 * PT;
    line(ctx, slicePoints(beta));
    ctx.stroke();
    ctx.restore();
    // Axes: left and bottom spines, ticks and their labels, the axis labels.
    ctx.strokeStyle = guide;
    ctx.lineWidth = 0.9 * PT;
    line(ctx, [[PLOT.left, PLOT.top], [PLOT.left, PLOT.top + PLOT.height], [PLOT.left + PLOT.width, PLOT.top + PLOT.height]]);
    ctx.stroke();
    ctx.strokeStyle = ink;
    ctx.lineWidth = TICK.width;
    for (const v of [-2, -1, 0, 1, 2]) {
      line(ctx, [[plotX(v), PLOT.top + PLOT.height], [plotX(v), PLOT.top + PLOT.height + TICK.length]]);
      ctx.stroke();
      canvasText(ctx, signed(v, 0), plotX(v), PLOT.top + PLOT.height + TICK.gap, { size: FONT.small, anchor: "middle", align: "top" });
    }
    ["0", "½", "1"].forEach((label, k) => {
      const y = plotY(k / 2);
      line(ctx, [[PLOT.left, y], [PLOT.left - TICK.length, y]]);
      ctx.stroke();
      centerBaselineText(ctx, label, PLOT.left - TICK.gap, y, { size: FONT.small, anchor: "end" });
    });
    const ticks = canvasText(scratch, "−2", 0, 0, { size: FONT.small, alpha: 0 });
    canvasText(ctx, "$v$  (slice $u=0$)", plotX(0), PLOT.top + PLOT.height + TICK.gap + ticks.height + 1 * PT, { size: FONT.label, anchor: "middle", align: "top" });
    const half = canvasText(scratch, "½", 0, 0, { size: FONT.small, alpha: 0 });
    ctx.save();
    ctx.translate(PLOT.left - TICK.gap - half.width - 3 * PT, PLOT.top + PLOT.height / 2);
    ctx.rotate(-Math.PI / 2);
    canvasText(ctx, "$K(0,v)$", 0, 0, { size: FONT.label, anchor: "middle", align: "bottom" });
    ctx.restore();
    for (const v of [-1, 1]) {
      circle(ctx, plotX(v), plotY(support(0, v, beta)), (Math.sqrt(46) / 2) * PT);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.2 * PT;
      ctx.stroke();
    }

    /* The point being read: a ring on the heat map with its K, and the point of the slice with the same d. */
    if (probe) {
      const d = boundary(probe.u, probe.v);
      const value = support(probe.u, probe.v, beta);
      const [x, y] = [heatX(probe.u), heatY(probe.v)];
      const slice = (probe.v < 0 ? -1 : 1) * (1 + d); // the point of the slice u = 0 with the same d, when it is on the plot
      const marks = Math.abs(slice) <= EXTENT ? [[x, y], [plotX(slice), plotY(value)]] : [[x, y]];
      for (const [px, py] of marks) {
        circle(ctx, px, py, 5.5);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.4 * PT;
        ctx.stroke();
        circle(ctx, px, py, 5.5 + 0.7 * PT);
        ctx.strokeStyle = ink;
        ctx.lineWidth = 0.8 * PT;
        ctx.stroke();
      }
      // The reading goes to the first corner around the point (above right, above left, below right, below left)
      // that stays on the heat map and off the label K = 1/2.
      const text = `$K=${value.toFixed(2)}$`;
      const box = canvasText(scratch, text, 0, 0, { size: FONT.small, alpha: 0 });
      const label = canvasText(scratch, "$K=$½", 0, 0, { size: FONT.label, alpha: 0 });
      const fixed = [heatX(0.62), heatY(1.1) - label.height, heatX(0.62) + label.width, heatY(1.1)];
      const corners = [[1, -1], [-1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
        const left = sx > 0 ? x + PROBE_GAP.x : x - PROBE_GAP.x - box.width;
        const top = sy < 0 ? y - PROBE_GAP.y - box.height : y + PROBE_GAP.y;
        const rect = [left, top, left + box.width, top + box.height];
        const inside = rect[0] >= HEAT.left + 2 && rect[2] <= HEAT.left + HEAT.size - 2 && rect[1] >= HEAT.top + 2 && rect[3] <= HEAT.top + HEAT.size - 2;
        const m = PROBE_GAP.clear;
        const clear = rect[2] < fixed[0] - m || rect[0] > fixed[2] + m || rect[3] < fixed[1] - m || rect[1] > fixed[3] + m;
        return { sx, sy, inside, clear };
      });
      const place = corners.find((corner) => corner.inside && corner.clear) ?? corners.find((corner) => corner.inside) ?? corners[0];
      canvasText(ctx, text, x + place.sx * PROBE_GAP.x, y + place.sy * PROBE_GAP.y, {
        size: FONT.small,
        anchor: place.sx > 0 ? "start" : "end",
        align: place.sy < 0 ? "bottom" : "top",
        halo: true,
      });
    }
  }

  /* Controls: beta on a log scale (the slider holds log2 beta), and the readout. */
  const formatBeta = (exponent) => (2 ** exponent).toFixed(1);
  const betaSlider = slider({
    label: "$\\beta$",
    name: "Sharpness beta, on a log scale from 2 to 32",
    value: Math.log2(state.beta),
    min: 1,
    max: 5,
    step: 0.01,
    format: formatBeta,
    accent: betaColor(state.beta),
    onInput: (exponent) => setBeta(2 ** exponent),
  });
  const summary = readout();
  controls.append(group({ legend: "Sharpness $\\beta$ (log scale)" }, [betaSlider.element]), summary);
  controls.style.setProperty("--hx-fig-grid", "minmax(0, 1fr)");
  if (window.matchMedia("(hover: none)").matches) setHint(TOUCH_HINT);

  function setBeta(beta) {
    state.beta = clamp(beta, ...BETA_RANGE);
    update();
  }

  function update() {
    const beta = state.beta;
    betaSlider.element.style.setProperty("--hx-fig-accent", rgb(betaColor(beta)));
    const note = probe
      ? `At $(u,v)=(${signed(probe.u, 2)},${signed(probe.v, 2)})$: $d=${signed(boundary(probe.u, probe.v), 2)}$, so $K=${support(probe.u, probe.v, beta).toFixed(2)}$.`
      : `$K=${support(0, 0, beta).toFixed(2)}$ at the center and $${support(0, 1.5, beta).toFixed(2)}$ at $v=\\pm 1.5$, outside the edge.`;
    summary.replaceChildren(
      el("span", { className: "hx-fig-readout-main" }, [icon("circle-check"), " ", htmlLabel(`$K(0,{\\pm}1)=$½ at $\\beta=${beta.toFixed(1)}$: the edge stays where $d=0$.`)]),
      el("span", { className: "hx-fig-readout-note" }, [htmlLabel(note)]),
    );
    view.canvas.setAttribute(
      "aria-label",
      `Heat map of one Hexel's support weight K at sharpness beta ${beta.toFixed(1)}, with its profile along the slice ` +
        `u = 0: K is ${support(0, 0, beta).toFixed(2)} at the center and one half on the hexagon's edge at v = −1 and 1.` +
        (probe ? ` At u ${signed(probe.u, 2)}, v ${signed(probe.v, 2)}, K is ${support(probe.u, probe.v, beta).toFixed(2)}.` : ""),
    );
    view.redraw();
  }

  /** The point read at a layout position: anywhere on the heat map, or on the slice u = 0 of the profile. */
  function probeAt(point) {
    if (inHeat(point)) {
      const u = -EXTENT + ((point.x - HEAT.left) / HEAT.size) * 2 * EXTENT;
      const v = EXTENT - ((point.y - HEAT.top) / HEAT.size) * 2 * EXTENT;
      return { u, v };
    }
    if (inPlot(point)) return { u: 0, v: -EXTENT + ((point.x - PLOT.left) / PLOT.width) * 2 * EXTENT };
    return null;
  }

  function setProbe(next) {
    const same = (next === null && probe === null) || (next && probe && next.u === probe.u && next.v === probe.v);
    if (same) return;
    probe = next;
    update();
  }

  /** Beta from a layout x on the track, snapped to the slider's step in log2 beta. */
  function dragTo(x) {
    const exponent = snap(clamp(1 + (4 * (x - TRACK.left)) / (TRACK.right - TRACK.left), 1, 5), 0.01);
    betaSlider.set(exponent);
    setBeta(2 ** exponent);
  }

  // The knob, the track and the labels 2, 8 and 32 move beta sideways only (axis "x"): on a touch screen an up or
  // down swipe that starts on them scrolls the page, a tap jumps, and a finger gets a slimmer band around the track,
  // which keeps the formula above it out.
  const drag = dragHandles(view.canvas, {
    hit(point) {
      const knob = trackX(state.beta);
      if (Math.hypot(point.x - knob, point.y - TRACK.y) <= TRACK.knob + point.slop) return { kind: "knob", axis: "x", offset: knob - point.x };
      for (const b of BETAS) {
        if (Math.abs(point.x - trackX(b)) <= 14 + point.slop / 2 && point.y >= TRACK.label - 2 && point.y <= TRACK.label + 26) return { kind: "knob", axis: "x", offset: 0, preset: b };
      }
      const onTrack = point.x >= TRACK.left - point.slop && point.x <= TRACK.right + point.slop;
      const band = TRACK.knob + (point.pointerType === "touch" ? 0.4 : 1) * point.slop;
      if (onTrack && Math.abs(point.y - TRACK.y) <= band) return { kind: "knob", axis: "x", offset: 0, jump: true };
      if (point.pointerType !== "touch") {
        const at = probeAt(point);
        if (at) return { kind: "probe", at };
      }
      return null;
    },
    start(handle, point) {
      if (handle.kind === "probe") {
        setProbe(handle.at);
        return;
      }
      dragging = true;
      if (handle.preset) {
        betaSlider.set(Math.log2(handle.preset));
        setBeta(handle.preset);
      } else if (handle.jump) {
        dragTo(point.x);
      }
      view.redraw();
    },
    move(handle, point) {
      if (handle.kind === "probe") setProbe(probeAt(point));
      else dragTo(point.x + handle.offset);
    },
    end() {
      dragging = false;
      view.redraw();
    },
    hover(handle) {
      const knob = handle?.kind === "knob";
      if (knob !== hovered) {
        hovered = knob;
        view.redraw();
      }
      setProbe(handle?.kind === "probe" ? handle.at : null);
    },
    cursor: (handle) => (handle.kind === "probe" ? "crosshair" : handle.preset ? "pointer" : "grab"),
  });

  // A tap on the heat map or the profile reads K there; a tap elsewhere clears it (touch has no hover).
  const remember = (event) => {
    lastPointer = event.pointerType;
  };
  const tap = (event) => {
    if (lastPointer !== "touch") return;
    const rect = view.canvas.getBoundingClientRect();
    const point = { x: ((event.clientX - rect.left) * 720) / rect.width, y: ((event.clientY - rect.top) * 405) / rect.height };
    setProbe(probeAt(point));
  };
  view.canvas.addEventListener("pointerdown", remember);
  view.canvas.addEventListener("click", tap);

  update();
  return {
    reset() {
      probe = null;
      betaSlider.set(Math.log2(REST_BETA));
      setBeta(REST_BETA);
    },
    destroy() {
      drag.destroy();
      view.canvas.removeEventListener("pointerdown", remember);
      view.canvas.removeEventListener("click", tap);
      view.destroy();
    },
  };
}
