/**
 * Interactive "Placing and coloring one Hexel" (theory.html, hexel_anatomy): one Hexel placed by
 * P(u, v) = p + s_u t_u u + s_v t_v v and colored by c^sp(u, v) = c_0 + u g_u + v g_v, over a faint grid of constant
 * u and v. Dragging the tip of the arrow s_u t_u or s_v t_v stretches the Hexel along that axis and turns it (t_u and
 * t_v stay orthogonal). Dragging the color ring turns the color change around p and makes it stronger or weaker, while
 * c_0 stays fixed; sliders do the same. The dots at p and at the arrow tips and the swatches on the right carry the
 * colors c_0, c_0 + g_u and c_0 + g_v of the field there, as in the animation.
 *
 * The math, constants, colors and layout are those of anatomy_frame() and draw_hexel_anatomy() in
 * tools/make_theory_animations.py. The color change is the animation's: g_u = m (cos(phi) G_u + sin(phi) G_v) and
 * g_v = m (cos(phi) G_v - sin(phi) G_u), with G_u and G_v the paper's hero Hexel, the turn phi and the strength m. The
 * default state is the poster frame (loop phase 0.70): s_u = 1.03, s_v = 0.83, t_u at -18 degrees, phi = 180 degrees
 * and m = 1, so g_u = (-0.30, 0.10, 0.20) and g_v = (-0.04, -0.14, 0.06). The ring sits at m R_RING along the
 * direction in which the color changes most (the field's leading singular direction), so it holds on to the warm side
 * of the field as it turns.
 */
import {
  COLORS,
  FONT,
  HEX_VERTICES,
  PT,
  arrow,
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
  planeAxes,
  polygonPath,
  readout,
  rgb,
  signed,
  slider,
  snap,
} from "./core.js";

export const hint = "Drag the arrow tips to stretch and turn the Hexel, and the ring to turn its colors.";

const SQRT3 = Math.sqrt(3);

// tools/make_theory_animations.py, section 1 (hexel_anatomy).
const C0 = [0.63, 0.72, 0.73]; // ANATOMY_C0
const G_U = [0.3, -0.1, -0.2]; // ANATOMY_GU
const G_V = [0.04, 0.14, -0.06]; // ANATOMY_GV
const LABEL_UV = { u: [0.45, -0.48], v: [-0.42, 0.45] }; // ANATOMY_LABEL_UV
const GRID_U = [-0.8, -0.4, 0.0, 0.4, 0.8];
const GRID_V = [-0.5, 0.0, 0.5];
const DOT = 14.0; // ANATOMY_DOT: diameter in points of the dots at p and the arrow tips
const AXES = planeAxes([0, 0, 400, 405], [0.0, 0.0], 2.0);
const X0 = 404; // left edge of the formulas, values and swatches
const ROWS = { formula: flip(334), scales: flip(287), swatch: flip(192), names: flip(152), color: flip(80) };
const SWATCH_RADIUS = 17;
const GRID_COLOR = mix(COLORS.guide, "#ffffff", 0.7); // the grid once the field is shown
const ARROW = { lw: 2.1, head: 17.0, halo: 3.2 }; // arrow(): width, mutation scale, extra width of the white halo (pt)
const FORMULA_RIGHT = 714; // the formulas end inside the canvas, a STIX Two Text label is a little wider than STIXGeneral

// The poster frame and the ranges of the controls. The ring lies at m R_RING (in u, v) from p.
const REST = { su: 1.03, sv: 0.83, angle: -18, turn: 180, strength: 1 };
// Keeps the Hexel inside the left panel at any turn; below 0.7 (the animation's smallest scale is 0.72) the arrow
// labels, the dots and the ring would crowd together.
const SCALE_RANGE = [0.7, 1.6];
const STRENGTH_MAX = 1.5;
const R_RING = 0.7;
const HANDLE = { halo: 15, ring: 9, core: 4.5 };

// The direction (in u, v) along which the hero color field changes most: the leading right singular vector of
// [G_u G_v]. The ring holds the color c_0 + m^2 R_RING [G_u G_v] lead there, a warm tone, wherever it is turned.
const LEAD = (() => {
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const [a, b, c] = [dot(G_U, G_U), dot(G_U, G_V), dot(G_V, G_V)];
  const top = (a + c) / 2 + Math.hypot((a - c) / 2, b);
  const norm = Math.hypot(top - c, b);
  return [(top - c) / norm, b / norm];
})();
const LEAD_ANGLE = Math.atan2(LEAD[1], LEAD[0]);

const radians = (degrees) => (degrees * Math.PI) / 180;
const degrees = (angle) => (angle * 180) / Math.PI;
const triple = (color) => `(${color.map((value) => signed(value, 2)).join(", ")})`;

/** The state as the animation draws it: frame, Jacobian, color change and the handles, in layout units. */
function frameOf(state) {
  const theta = radians(state.angle);
  const tu = [Math.cos(theta), Math.sin(theta)];
  const tv = [-Math.sin(theta), Math.cos(theta)];
  const phi = radians(state.turn);
  const m = state.strength;
  const gu = G_U.map((value, i) => m * (Math.cos(phi) * value + Math.sin(phi) * G_V[i]));
  const gv = G_U.map((value, i) => m * (-Math.sin(phi) * value + Math.cos(phi) * G_V[i]));
  const world = ([u, v]) => [state.su * tu[0] * u + state.sv * tv[0] * v, state.su * tu[1] * u + state.sv * tv[1] * v];
  const layout = (uv) => {
    const [x, y] = world(uv);
    return [AXES.x(x), AXES.y(y)];
  };
  const ringAngle = LEAD_ANGLE - phi;
  const ringUv = [m * R_RING * Math.cos(ringAngle), m * R_RING * Math.sin(ringAngle)];
  const color = ([u, v]) => C0.map((value, i) => value + u * gu[i] + v * gv[i]);
  return {
    tu,
    tv,
    gu,
    gv,
    layout,
    color,
    center: layout([0, 0]),
    tips: { u: layout([1, 0]), v: layout([0, 1]) },
    ring: layout(ringUv),
    ringColor: color(ringUv),
    vertices: HEX_VERTICES.map(layout),
  };
}

/** Layout point to (u, v) in the Hexel's frame. */
function toUv(state, [x, y]) {
  const theta = radians(state.angle);
  const wx = (x - AXES.x(0)) / AXES.unit;
  const wy = (AXES.y(0) - y) / AXES.unit;
  return [
    (Math.cos(theta) * wx + Math.sin(theta) * wy) / state.su,
    (-Math.sin(theta) * wx + Math.cos(theta) * wy) / state.sv,
  ];
}

const clip01 = (color) => color.map((value) => clamp(value, 0, 1));

function circle(ctx, [x, y], radius) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
}

/** Width of a label at a font size, for fitting the long formulas. */
const scratch = document.createElement("canvas").getContext("2d");
function fittedSize(text, size, room) {
  const { width } = canvasText(scratch, text, 0, 0, { size, alpha: 0 });
  return width > room ? (size * room) / width : size;
}

export function mount(container, { stage, controls }) {
  const state = { ...REST };
  const select = cssVar("--hx-select") || "#5d70ae";
  const ink = rgb(COLORS.ink);
  const field = document.createElement("canvas");
  const fieldContext = field.getContext("2d");
  let image = null;
  let hovered = null; // "u", "v" or "ring"
  let dragged = null;
  let focused = null; // the handle whose sliders have focus or the pointer

  const view = canvasStage(stage, draw);

  /** The color field over the Hexel: c_0 + u g_u + v g_v per device pixel, clipped to [0, 1], inside the outline. */
  function paintField(ctx, frame) {
    const { a: rx, d: ry } = ctx.getTransform();
    const xs = frame.vertices.map(([x]) => x);
    const ys = frame.vertices.map(([, y]) => y);
    const left = Math.floor(Math.min(...xs) * rx) - 1;
    const top = Math.floor(Math.min(...ys) * ry) - 1;
    const width = Math.ceil(Math.max(...xs) * rx) + 1 - left;
    const height = Math.ceil(Math.max(...ys) * ry) + 1 - top;
    if (field.width !== width || field.height !== height || !image) {
      field.width = width;
      field.height = height;
      image = fieldContext.createImageData(width, height);
    }
    // The field is affine in layout units: c = c_0 + dx (x - p_x) + dy (y - p_y).
    const theta = radians(state.angle);
    const [cos, sin] = [Math.cos(theta), Math.sin(theta)];
    const dx = C0.map((_, i) => (frame.gu[i] * cos / state.su - frame.gv[i] * sin / state.sv) / AXES.unit);
    const dy = C0.map((_, i) => (-frame.gu[i] * sin / state.su - frame.gv[i] * cos / state.sv) / AXES.unit);
    const [px, py] = frame.center;
    const data = image.data;
    let k = 0;
    for (let j = 0; j < height; j += 1) {
      const y = (top + j + 0.5) / ry - py;
      const row = C0.map((value, i) => value + dy[i] * y);
      for (let i = 0; i < width; i += 1) {
        const x = (left + i + 0.5) / rx - px;
        data[k] = 255 * (row[0] + dx[0] * x);
        data[k + 1] = 255 * (row[1] + dx[1] * x);
        data[k + 2] = 255 * (row[2] + dx[2] * x);
        data[k + 3] = 255;
        k += 4;
      }
    }
    fieldContext.putImageData(image, 0, 0);
    ctx.save();
    polygonPath(ctx, frame.vertices);
    ctx.clip();
    ctx.drawImage(field, left / rx, top / ry, width / rx, height / ry);
    ctx.restore();
  }

  function paintHalo(ctx, key, point) {
    const active = dragged === key ? 0.28 : hovered === key || focused === key ? 0.18 : 0;
    if (!active) return;
    ctx.save();
    ctx.globalAlpha = active;
    ctx.fillStyle = select;
    circle(ctx, point, HANDLE.halo);
    ctx.fill();
    ctx.restore();
  }

  function draw(ctx) {
    const frame = frameOf(state);

    // The Hexel: tint, color field, grid of constant u and v, outline.
    polygonPath(ctx, frame.vertices);
    ctx.fillStyle = rgb(COLORS.tint);
    ctx.fill();
    paintField(ctx, frame);
    ctx.save();
    ctx.strokeStyle = rgb(GRID_COLOR);
    ctx.lineWidth = 0.9 * PT;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const u0 of GRID_U) {
      const reach = Math.min(1, 2 - SQRT3 * Math.abs(u0));
      ctx.moveTo(...frame.layout([u0, -reach]));
      ctx.lineTo(...frame.layout([u0, reach]));
    }
    for (const v0 of GRID_V) {
      const reach = (2 - Math.abs(v0)) / SQRT3;
      ctx.moveTo(...frame.layout([-reach, v0]));
      ctx.lineTo(...frame.layout([reach, v0]));
    }
    ctx.stroke();
    // The ring's guide: a faint dashed line from p, the direction of the strongest color change.
    ctx.strokeStyle = ink;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.0 * PT;
    ctx.setLineDash([3 * PT, 2.5 * PT]);
    ctx.beginPath();
    ctx.moveTo(...frame.center);
    ctx.lineTo(...frame.ring);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    polygonPath(ctx, frame.vertices);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2.2 * PT;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();

    // The arrows s_u t_u and s_v t_v, then the dots at p and the tips in the field's colors there.
    const fieldColors = [C0, frame.color([1, 0]), frame.color([0, 1])].map(clip01);
    arrow(ctx, frame.center, frame.tips.u, rgb(COLORS.tangent.u), { ...ARROW, shrink: DOT / 2 });
    arrow(ctx, frame.center, frame.tips.v, rgb(COLORS.tangent.v), { ...ARROW, shrink: DOT / 2 });
    paintHalo(ctx, "u", frame.tips.u);
    paintHalo(ctx, "v", frame.tips.v);
    [[frame.tips.u, fieldColors[1], "u"], [frame.tips.v, fieldColors[2], "v"], [frame.center, fieldColors[0], null]].forEach(([point, color, key]) => {
      circle(ctx, point, (DOT / 2) * PT);
      ctx.fillStyle = rgb(color);
      ctx.fill();
      ctx.lineWidth = 1.2 * PT;
      ctx.strokeStyle = key && (dragged === key || hovered === key) ? select : ink;
      ctx.stroke();
    });

    // Labels beside the arrows and p.
    for (const key of ["u", "v"]) {
      const [x, y] = frame.layout(LABEL_UV[key]);
      canvasText(ctx, `$s_${key}\\mathbf{t}_${key}$`, x, y, { size: FONT.formula, anchor: "middle", align: "middle", color: COLORS.tangent[key], halo: true });
    }
    const away = [-(frame.tu[0] + frame.tv[0]), -(frame.tu[1] + frame.tv[1])];
    const norm = Math.hypot(...away);
    canvasText(ctx, "$\\mathbf{p}$", AXES.x((0.3 * away[0]) / norm), AXES.y((0.3 * away[1]) / norm), { size: FONT.formula, anchor: "middle", align: "middle", halo: true });

    // The formulas, the scales and the swatches c_0, c_0 + g_u and c_0 + g_v.
    const placement = "$P(u,v)=\\mathbf{p}+s_u\\mathbf{t}_u\\,u+s_v\\mathbf{t}_v\\,v$";
    const coloring = "$\\mathbf{c}^{\\rm sp}(u,v)=\\mathbf{c}_0+u\\,\\mathbf{g}_u+v\\,\\mathbf{g}_v$";
    canvasText(ctx, placement, X0, ROWS.formula, { size: fittedSize(placement, FONT.formula, FORMULA_RIGHT - X0), align: "middle" });
    canvasText(ctx, `$s_u=${state.su.toFixed(2)}$`, X0, ROWS.scales, { size: FONT.label, align: "middle", color: COLORS.tangent.u });
    canvasText(ctx, `$s_v=${state.sv.toFixed(2)}$`, X0 + 150, ROWS.scales, { size: FONT.label, align: "middle", color: COLORS.tangent.v });
    const names = ["$\\mathbf{c}_0$", "$\\mathbf{c}_0+\\mathbf{g}_u$", "$\\mathbf{c}_0+\\mathbf{g}_v$"];
    fieldColors.forEach((color, k) => {
      const cx = X0 + 46 + 108 * k;
      circle(ctx, [cx, ROWS.swatch], SWATCH_RADIUS);
      ctx.fillStyle = rgb(color);
      ctx.fill();
      ctx.lineWidth = 1.3 * PT;
      ctx.strokeStyle = ink;
      ctx.stroke();
      canvasText(ctx, names[k], cx, ROWS.names, { size: FONT.label, anchor: "middle", align: "middle" });
    });
    canvasText(ctx, coloring, X0, ROWS.color, { size: fittedSize(coloring, FONT.formula, FORMULA_RIGHT - X0), align: "middle" });

    // The color ring, above everything: a white ring around the field's color at its place.
    paintHalo(ctx, "ring", frame.ring);
    circle(ctx, frame.ring, HANDLE.ring);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 1.2 * PT;
    ctx.strokeStyle = dragged === "ring" || hovered === "ring" ? select : ink;
    ctx.stroke();
    circle(ctx, frame.ring, HANDLE.core);
    ctx.fillStyle = rgb(clip01(frame.ringColor));
    ctx.fill();
  }

  /* Controls: the shape (scales and turn of the frame) and the color change (turn and strength). */
  const format = {
    scale: (value) => value.toFixed(2),
    angle: (value) => `${signed(value, 0)}°`,
    strength: (value) => `${value.toFixed(2)}×`,
  };
  const sliders = {
    su: slider({
      label: "$s_u$",
      name: "Scale s_u along the tangent t_u",
      value: state.su,
      min: SCALE_RANGE[0],
      max: SCALE_RANGE[1],
      format: format.scale,
      accent: COLORS.tangent.u,
      onInput: (value) => change({ su: value }),
    }),
    sv: slider({
      label: "$s_v$",
      name: "Scale s_v along the tangent t_v",
      value: state.sv,
      min: SCALE_RANGE[0],
      max: SCALE_RANGE[1],
      format: format.scale,
      accent: COLORS.tangent.v,
      onInput: (value) => change({ sv: value }),
    }),
    angle: slider({
      label: "$\\theta$",
      name: "Turn of the tangent t_u, in degrees",
      value: state.angle,
      min: -180,
      max: 180,
      step: 1,
      format: format.angle,
      accent: COLORS.ink,
      onInput: (value) => change({ angle: value }),
    }),
    turn: slider({
      label: "$\\phi$",
      name: "Turn of the color change, in degrees",
      value: state.turn,
      min: 0,
      max: 360,
      step: 1,
      format: format.angle,
      onInput: (value) => change({ turn: value }),
    }),
    strength: slider({
      label: "$m$",
      name: "Strength of the color change, times the animation's",
      value: state.strength,
      min: 0,
      max: STRENGTH_MAX,
      format: format.strength,
      onInput: (value) => change({ strength: value }),
    }),
  };
  const shape = group({ legend: "Shape: scales and turn $\\theta$ of $\\mathbf{t}_u$" }, [sliders.su.element, sliders.sv.element, sliders.angle.element]);
  const coloring = group({ legend: "Color change: turn $\\phi$, strength $m$" }, [sliders.turn.element, sliders.strength.element]);
  const summary = readout();
  controls.append(shape, coloring, summary);
  controls.style.setProperty("--hx-fig-grid", "repeat(2, minmax(0, 1fr))");
  // Pointing at or focusing a slider lights up the handle it moves.
  const handleOf = { su: "u", sv: "v", angle: null, turn: "ring", strength: "ring" };
  for (const [key, control] of Object.entries(sliders)) {
    const light = (on) => {
      focused = on ? handleOf[key] : null;
      view.redraw();
    };
    control.element.addEventListener("pointerenter", () => light(true));
    control.element.addEventListener("pointerleave", () => light(false));
    control.input.addEventListener("focus", () => light(true));
    control.input.addEventListener("blur", () => light(false));
  }

  function change(values) {
    Object.assign(state, values);
    update();
  }

  /** Readout and description for the current state, then one redraw. */
  function update() {
    const frame = frameOf(state);
    summary.replaceChildren(
      el("span", { className: "hx-fig-readout-main" }, [icon("circle-info"), " V1 Hexel: 20 parameters, 9 for color."]),
      el("span", { className: "hx-fig-readout-note" }, [
        htmlLabel(`$\\mathbf{c}_0=${triple(C0)}$, $\\mathbf{g}_u=${triple(frame.gu)}$, $\\mathbf{g}_v=${triple(frame.gv)}$`),
      ]),
    );
    view.canvas.setAttribute(
      "aria-label",
      `One Hexel with scales s_u ${state.su.toFixed(2)} and s_v ${state.sv.toFixed(2)}, its tangent t_u turned ` +
        `${signed(state.angle, 0)} degrees, colored ${triple(C0)} at its center p and changing by g_u ${triple(frame.gu)} ` +
        `and g_v ${triple(frame.gv)} per unit step along its axes.`,
    );
    view.redraw();
  }

  /* Direct manipulation: the arrow tips and the color ring. */
  const drag = dragHandles(view.canvas, {
    hit(point) {
      const frame = frameOf(state);
      const candidates = [
        ["ring", frame.ring, HANDLE.ring],
        ["u", frame.tips.u, (DOT / 2) * PT],
        ["v", frame.tips.v, (DOT / 2) * PT],
      ].map(([key, at, radius]) => ({ key, at, distance: Math.hypot(point.x - at[0], point.y - at[1]) - radius }));
      const best = candidates.reduce((a, b) => (b.distance < a.distance ? b : a));
      if (best.distance > point.slop) return null;
      return { key: best.key, offset: [best.at[0] - point.x, best.at[1] - point.y] };
    },
    start(handle) {
      dragged = handle.key;
      view.redraw();
    },
    move(handle, point) {
      const target = [point.x + handle.offset[0], point.y + handle.offset[1]];
      if (handle.key === "ring") {
        const [u, v] = toUv(state, target);
        state.strength = snap(clamp(Math.hypot(u, v) / R_RING, 0, STRENGTH_MAX), 0.01);
        if (Math.hypot(u, v) > 1e-6) state.turn = snap((((degrees(LEAD_ANGLE - Math.atan2(v, u)) % 360) + 360) % 360), 1) % 360;
        sliders.turn.set(state.turn);
        sliders.strength.set(state.strength);
      } else {
        const wx = (target[0] - AXES.x(0)) / AXES.unit;
        const wy = (AXES.y(0) - target[1]) / AXES.unit;
        const length = snap(clamp(Math.hypot(wx, wy), ...SCALE_RANGE), 0.01);
        if (Math.hypot(wx, wy) > 1e-6) {
          const angle = degrees(Math.atan2(wy, wx)) - (handle.key === "v" ? 90 : 0);
          state.angle = snap(((((angle + 180) % 360) + 360) % 360) - 180, 1);
          if (state.angle === -180) state.angle = 180;
        }
        state[handle.key === "u" ? "su" : "sv"] = length;
        sliders[handle.key === "u" ? "su" : "sv"].set(length);
        sliders.angle.set(state.angle);
      }
      update();
    },
    end() {
      dragged = null;
      view.redraw();
    },
    hover(handle) {
      const key = handle?.key ?? null;
      if (key === hovered) return;
      hovered = key;
      view.redraw();
    },
    cursor: () => "grab",
  });

  update();
  return {
    reset() {
      Object.assign(state, REST);
      for (const [key, control] of Object.entries(sliders)) control.set(state[key]);
      update();
    },
    destroy() {
      drag.destroy();
      view.destroy();
    },
  };
}
