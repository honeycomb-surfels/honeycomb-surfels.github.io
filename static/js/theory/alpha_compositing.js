/**
 * Interactive "How Hexel errors reach the pixel" (theory.html, alpha_compositing): a pixel's ray passes three Hexels
 * and then the background b. Sliders set each Hexel's opacity o_i and support weight K_i, so that
 * alpha_i = min(o_i K_i, 0.99), and the three handles on the weight bar drag its dividers, which sets the opacity of
 * the Hexel before each divider. As in the animation, the stacked weights w_1, w_2, w_3 and T fill [0, 1], the pixel
 * color I sits next to the target f, and the pixel error ||I - f|| (the largest RGB-channel error) is drawn under the
 * bound sum_i w_i ||C_i - f|| + T ||b - f||, whose background term is hatched; a readout confirms the bound for every
 * setting.
 *
 * The math, constants, colors and layout are those of composite_frame(), draw_ray(), draw_weight_bar() and
 * draw_error_bars() in tools/make_theory_animations.py. The default state is the poster frame (loop phase 0.62):
 * alpha = 0.60, 0.50 and 0.70 (o_i = alpha_i, K_i = 1), so T = 0.06, the pixel error is 0.040 and the bound 0.081,
 * of which the background term is 0.035. The animation's bars use 3600 layout units per unit of error; when the
 * bound grows past the room on the canvas, both error bars share a smaller scale.
 */
import {
  COLORS,
  FONT,
  HEX_VERTICES,
  PT,
  clamp,
  cssVar,
  dragHandles,
  el,
  flip,
  group,
  icon,
  htmlLabel,
  planeAxes,
  readout,
  rgb,
  slider,
  svgEl,
  svgHatch,
  svgStage,
  svgText,
} from "./core.js";

export const hint = "Drag the handles on the weight bar, or use the sliders.";

// tools/make_theory_animations.py, section 8 (alpha_compositing).
const TARGET = [0.8, 0.47, 0.33]; // f
const HEXEL_COLORS = [[0.83, 0.49, 0.3], [0.78, 0.42, 0.4], [0.7, 0.56, 0.38]]; // C_1, C_2, C_3
const BACKGROUND = [0.86, 0.9, 0.92]; // b
const BASE_ALPHAS = [0.6, 0.5, 0.7]; // ALPHA_BASE, the alphas of the poster frame
const DEPTH = [2.6, 4.85, 7.1]; // Hexel positions along the ray
const LIFT = [0.3, -0.25, 0.18]; // Hexel centers off the ray
const HEXEL_SHAPE = { width: 0.64, height: 1.78, perspective: 0.16 }; // ALPHA_HEXEL: W, H, G
const PIXEL_X = 0.7;
const BACK_X = 9.1;
const RAY_AXES = [[0, 82, 470, 310], [4.85, 0.0], 4.85]; // plane_axes(fig, rect, center, half_width) of draw_ray
const BAR = { left: 490, middle: 330, width: 208, half: 13 }; // ALPHA_BAR
const LABEL_RAMP = [8, 14]; // ALPHA_LABEL_RAMP
const ERROR_LEFT = 150;
const ERROR_SCALE = 3600;
const ERROR_ROWS = { bound: 56, error: 21 };
const ERROR_HALF = 9;
const ERROR_INK = "#5a6c73"; // ALPHA_ERROR_INK
const ALPHA_CAP = 0.99; // the renderer's clamp
// The largest RGB-channel errors ||C_i - f|| and ||b - f||: 0.03, 0.07, 0.10 and 0.59.
const PART_ERRORS = [...HEXEL_COLORS, BACKGROUND].map((color) => maxChannelError(color, TARGET));

// Widget layout beyond the animation: the room for the error bars before they share a smaller scale (their numbers
// then still end inside the canvas), the divider handles on the weight bar and their hover halo.
const ERROR_ROOM = 470;
const HANDLE = { width: 7, overhang: 3, halo: 15 };
const DIVIDER_TIE = 0.75; // dividers closer than this (layout units) are one grab; the drag direction picks one
const REST = { opacity: [...BASE_ALPHAS], support: [1, 1, 1] };

function maxChannelError(a, b) {
  return Math.max(...a.map((value, channel) => Math.abs(value - b[channel])));
}

/** The script's linear(): progress of value through [start, end], clamped to [0, 1]. */
function ramp(value, [start, end]) {
  return clamp((value - start) / (end - start), 0, 1);
}

/**
 * composite_frame() for given opacities and support weights: front-to-back weights w_i = alpha_i prod_{j<i}
 * (1 - alpha_j), the transmittance T, the pixel I = sum_i w_i C_i + T b, its error and the four bound terms.
 */
function composite(opacity, support) {
  const alphas = opacity.map((o, i) => Math.min(o * support[i], ALPHA_CAP));
  const weights = [];
  let transmittance = 1;
  for (const alpha of alphas) {
    weights.push(alpha * transmittance);
    transmittance *= 1 - alpha;
  }
  const image = [0, 1, 2].map(
    (channel) => weights.reduce((sum, weight, i) => sum + weight * HEXEL_COLORS[i][channel], 0) + transmittance * BACKGROUND[channel],
  );
  const terms = [...weights, transmittance].map((weight, i) => weight * PART_ERRORS[i]);
  return {
    alphas,
    weights,
    transmittance,
    image,
    error: maxChannelError(image, TARGET),
    terms,
    bound: terms.reduce((sum, term) => sum + term, 0),
  };
}

/** oblique_hexagon(): a Hexel across the ray in perspective, its near (left) side taller than its far side. */
function obliqueHexagon(cx, cy) {
  const { width, height, perspective } = HEXEL_SHAPE;
  return HEX_VERTICES.map(([u, v]) => [cx + (width * u) / (1 + perspective * u), cy + (height * v) / (1 + perspective * u)]);
}

/** Running sums of the segment widths: the left end of each segment. */
function starts(widths, left) {
  let x = left;
  return widths.map((width) => {
    const start = x;
    x += width;
    return start;
  });
}

const formatAlpha = (alpha) => alpha.toFixed(2);
const formatError = (error) => error.toFixed(3);

/** Stacked rectangles in the colors of C_1, C_2, C_3 and b (hatched), as stacked_segments() draws them. */
function stackedSegments(parent, hatch, top, height) {
  return [...HEXEL_COLORS, BACKGROUND].map((color, k) => {
    const isBackground = k === 3;
    return svgEl("rect", {
      y: top,
      height,
      fill: isBackground ? hatch : rgb(color),
      stroke: isBackground ? "none" : "white",
      "stroke-width": isBackground ? 0 : 1.0 * PT,
    }, parent);
  });
}

function placeSegments(rects, xs, widths) {
  rects.forEach((rect, k) => {
    rect.setAttribute("x", xs[k]);
    rect.setAttribute("width", Math.max(widths[k], 0));
  });
}

export function mount(container, { stage, controls }) {
  const state = { opacity: [...REST.opacity], support: [...REST.support] };
  const select = cssVar("--hx-select") || "#5d70ae";
  const ink = rgb(COLORS.ink);
  const axes = planeAxes(...RAY_AXES);
  const svg = svgStage(stage);
  const hatch = svgHatch(svg, { fill: BACKGROUND });

  /* draw_ray(): the background b, the three Hexels, the dashed ray and the pixel. */
  svgEl("rect", {
    x: axes.x(BACK_X),
    y: axes.y(2.55),
    width: 0.5 * axes.unit,
    height: 5.1 * axes.unit,
    fill: rgb(BACKGROUND),
    stroke: rgb(COLORS.guide),
    "stroke-width": 1.0 * PT,
  }, svg);
  const shapes = DEPTH.map((depth, k) => obliqueHexagon(depth, LIFT[k]).map(([u, v]) => `${axes.x(u)},${axes.y(v)}`).join(" "));
  const fills = shapes.map((points, k) => svgEl("polygon", { points, fill: rgb(HEXEL_COLORS[k]) }, svg));
  const outlines = shapes.map((points) => svgEl("polygon", {
    points,
    fill: "none",
    stroke: ink,
    "stroke-width": 1.3 * PT,
    "stroke-linejoin": "round",
  }, svg));
  svgText(svg, { size: FONT.formula, anchor: "middle", align: "top" }).set("$b$", axes.x(BACK_X + 0.25), axes.y(-2.7));
  const alphaLabels = DEPTH.map(() => svgText(svg, { size: FONT.small, anchor: "middle", align: "bottom" }));
  DEPTH.forEach((depth, k) => {
    svgText(svg, { size: FONT.formula, anchor: "middle", align: "top" }).set(`$C_${k + 1}$`, axes.x(depth), axes.y(-2.62));
  });
  svgText(svg, { size: FONT.small, anchor: "middle", align: "top" }).set("pixel", axes.x(PIXEL_X), axes.y(-0.45));
  svgEl("line", {
    x1: axes.x(PIXEL_X + 0.25),
    y1: axes.y(0),
    x2: axes.x(BACK_X),
    y2: axes.y(0),
    stroke: ink,
    "stroke-width": 1.3 * PT,
    "stroke-dasharray": `${3 * 1.3 * PT} ${2.2 * 1.3 * PT}`,
  }, svg);
  const pixel = svgEl("rect", {
    x: axes.x(PIXEL_X - 0.25),
    y: axes.y(0.25),
    width: 0.5 * axes.unit,
    height: 0.5 * axes.unit,
    stroke: ink,
    "stroke-width": 1.3 * PT,
  }, svg);

  /* draw_weight_bar(): w_1, w_2, w_3 and T stacked on [0, 1]. */
  const barTop = flip(BAR.middle + BAR.half);
  const barBottom = flip(BAR.middle - BAR.half);
  const weightRects = stackedSegments(svg, hatch, barTop, 2 * BAR.half);
  const weightLabels = [0, 1, 2, 3].map((k) => svgText(svg, { size: FONT.label, anchor: "middle", align: k === 3 ? "bottom" : "top" }));
  svgEl("rect", { x: BAR.left, y: barTop, width: BAR.width, height: 2 * BAR.half, fill: "none", stroke: rgb(COLORS.guide), "stroke-width": 1.2 * PT }, svg);
  svgText(svg, { size: FONT.small, anchor: "end", align: "middle", fill: COLORS.note }).set("0", BAR.left - 7, flip(BAR.middle));
  svgText(svg, { size: FONT.small, anchor: "start", align: "middle", fill: COLORS.note }).set("1", BAR.left + BAR.width + 5, flip(BAR.middle));

  /* The pixel I and the true color f, and the formula for I. */
  const pixelDot = svgEl("circle", { cx: 505, cy: flip(262), r: 13, stroke: ink, "stroke-width": 1.1 * PT }, svg);
  svgEl("circle", { cx: 505, cy: flip(220), r: 13, fill: rgb(TARGET), stroke: ink, "stroke-width": 1.1 * PT }, svg);
  svgText(svg, { size: FONT.label, align: "middle" }).set("pixel $I$", 527, flip(262));
  svgText(svg, { size: FONT.label, align: "middle" }).set("true color $f$", 527, flip(220));
  svgText(svg, { size: FONT.formula, align: "middle" }).set("$I=\\sum_i w_i C_i+T\\,b$", 492, flip(152));

  /* draw_error_bars(): the bound as stacked weighted errors above the pixel error, on one scale. */
  const boundRects = stackedSegments(svg, hatch, flip(ERROR_ROWS.bound + ERROR_HALF), 2 * ERROR_HALF);
  const errorRect = svgEl("rect", { x: ERROR_LEFT, y: flip(ERROR_ROWS.error + ERROR_HALF), height: 2 * ERROR_HALF, fill: ERROR_INK }, svg);
  svgText(svg, { size: FONT.label, anchor: "end", align: "middle" }).set("bound", ERROR_LEFT - 10, flip(ERROR_ROWS.bound));
  svgText(svg, { size: FONT.label, anchor: "end", align: "middle" }).set("pixel error", ERROR_LEFT - 10, flip(ERROR_ROWS.error));
  const boundValue = svgText(svg, { size: FONT.label, align: "middle" });
  const errorValue = svgText(svg, { size: FONT.label, align: "middle" });

  /* The divider handles of the weight bar, above everything else. */
  const handles = [0, 1, 2].map(() => {
    const handle = svgEl("g", { class: "hx-ac-handle" }, svg);
    const halo = svgEl("circle", { cy: flip(BAR.middle), r: HANDLE.halo, fill: select, opacity: 0 }, handle);
    const grip = svgEl("rect", {
      y: barTop - HANDLE.overhang,
      width: HANDLE.width,
      height: 2 * BAR.half + 2 * HANDLE.overhang,
      rx: HANDLE.width / 2,
      fill: "white",
      stroke: ink,
      "stroke-width": 1.4,
    }, handle);
    return { halo, grip };
  });

  /* Controls: per Hexel its opacity and support weight; the readout under them. */
  let dividers = [];
  let hovered = null;
  let dragged = null;
  let focused = null;
  const legendValues = [];
  const opacitySliders = [];
  const supportSliders = [];
  HEXEL_COLORS.forEach((color, k) => {
    const n = k + 1;
    const value = el("span", { className: "hx-fig-legend-value" });
    legendValues.push(value);
    opacitySliders.push(slider({
      label: `$o_${n}$`,
      name: `Opacity o${n} of Hexel ${n}`,
      value: state.opacity[k],
      accent: color,
      onInput: (opacity) => {
        state.opacity[k] = opacity;
        render();
      },
    }));
    supportSliders.push(slider({
      label: `$K_${n}$`,
      name: `Support weight K${n} of Hexel ${n}`,
      value: state.support[k],
      accent: color,
      onInput: (support) => {
        state.support[k] = support;
        render();
      },
    }));
    const box = group({ legend: `Hexel ${n}`, swatch: color, aside: value }, [opacitySliders[k].element, supportSliders[k].element]);
    // Pointing at or focusing a Hexel's sliders outlines that Hexel in the figure.
    box.addEventListener("pointerenter", () => emphasize(k));
    box.addEventListener("pointerleave", () => emphasize(null));
    box.addEventListener("focusin", () => emphasize(k));
    box.addEventListener("focusout", () => emphasize(null));
    controls.append(box);
  });
  const summary = readout();
  controls.append(summary);
  controls.style.setProperty("--hx-fig-grid", "repeat(3, minmax(0, 1fr))"); // one column per Hexel

  function emphasize(k) {
    focused = k;
    paintHighlights();
  }

  /** Outline the Hexel being edited and light up the hovered or dragged divider handle. */
  function paintHighlights() {
    const active = dragged ?? hovered;
    const edited = active ?? focused;
    outlines.forEach((outline, k) => outline.setAttribute("stroke-width", (k === edited ? 2.3 : 1.3) * PT));
    handles.forEach(({ halo, grip }, k) => {
      halo.setAttribute("opacity", k === dragged ? 0.28 : k === hovered ? 0.18 : 0);
      grip.setAttribute("stroke", k === active ? select : ink);
    });
  }

  function render() {
    const frame = composite(state.opacity, state.support);

    // Hexels, their alphas and the pixel.
    frame.alphas.forEach((alpha, k) => {
      fills[k].setAttribute("fill-opacity", alpha);
      alphaLabels[k].set(`$\\alpha_${k + 1}=${formatAlpha(alpha)}$`, axes.x(DEPTH[k]), axes.y(2.6));
    });
    const color = rgb(frame.image);
    pixel.setAttribute("fill", color);
    pixelDot.setAttribute("fill", color);

    // The weight bar; a segment's label fades in while the segment grows from 8 to 14 layout units.
    const widths = [...frame.weights, frame.transmittance].map((weight) => BAR.width * weight);
    const xs = starts(widths, BAR.left);
    placeSegments(weightRects, xs, widths);
    ["$w_1$", "$w_2$", "$w_3$", "$T$"].forEach((name, k) => {
      const label = weightLabels[k];
      const y = k === 3 ? flip(BAR.middle + BAR.half + 4) : flip(BAR.middle - BAR.half - 4);
      label.set(name, xs[k] + widths[k] / 2, y);
      label.node.setAttribute("opacity", ramp(widths[k], LABEL_RAMP));
    });
    dividers = xs.slice(1);
    handles.forEach(({ halo, grip }, k) => {
      halo.setAttribute("cx", dividers[k]);
      grip.setAttribute("x", dividers[k] - HANDLE.width / 2);
    });

    // The bound and the pixel error on one scale: the animation's, or smaller once the bound needs more room.
    const scale = Math.min(ERROR_SCALE, ERROR_ROOM / frame.bound);
    const termWidths = frame.terms.map((term) => scale * term);
    placeSegments(boundRects, starts(termWidths, ERROR_LEFT), termWidths);
    const boundWidth = scale * frame.bound;
    const errorWidth = scale * frame.error;
    errorRect.setAttribute("width", errorWidth);
    boundValue.set(formatError(frame.bound), ERROR_LEFT + boundWidth + 8, flip(ERROR_ROWS.bound));
    errorValue.set(formatError(frame.error), ERROR_LEFT + errorWidth + 8, flip(ERROR_ROWS.error));

    // Readouts.
    frame.alphas.forEach((alpha, k) => {
      const capped = state.opacity[k] * state.support[k] > ALPHA_CAP;
      legendValues[k].replaceChildren(htmlLabel(`$\\alpha_${k + 1}=${formatAlpha(alpha)}$${capped ? " (capped)" : ""}`));
    });
    const holds = frame.error <= frame.bound + 1e-12;
    const background = frame.terms[3];
    summary.classList.toggle("is-violated", !holds);
    summary.replaceChildren(
      el("span", { className: "hx-fig-readout-main" }, [
        icon(holds ? "circle-check" : "circle-exclamation"),
        ` Pixel error ${formatError(frame.error)} ${holds ? "≤" : ">"} bound ${formatError(frame.bound)}: `,
        el("strong", { text: holds ? "the bound holds." : "the bound fails." }),
      ]),
      el("span", { className: "hx-fig-readout-note" }, [
        htmlLabel(`Background term $T\\|b-f\\|=${formatError(background)}$, with $T=${formatAlpha(frame.transmittance)}$.`),
      ]),
    );
    svg.setAttribute(
      "aria-label",
      `A pixel's ray through three Hexels with alpha ${frame.alphas.map(formatAlpha).join(", ")} and transmittance ` +
        `${formatAlpha(frame.transmittance)} to the background. Pixel error ${formatError(frame.error)}, bound ` +
        `${formatError(frame.bound)}, of which the background term is ${formatError(background)}.`,
    );
    paintHighlights();
  }

  /** Move divider k (after w_k) to layout x: set alpha_k so that the stack up to it ends there, through o_k. */
  function dragDivider(k, x) {
    const frame = composite(state.opacity, state.support);
    const reach = frame.alphas.slice(0, k).reduce((left, alpha) => left * (1 - alpha), 1); // light reaching Hexel k
    if (reach < 1e-6 || state.support[k] <= 0) return;
    const share = clamp((x - BAR.left) / BAR.width, 0, 1);
    const alpha = clamp((share - (1 - reach)) / reach, 0, 1);
    state.opacity[k] = Math.round(100 * clamp(alpha / state.support[k], 0, 1)) / 100;
    opacitySliders[k].set(state.opacity[k]);
    render();
  }

  const drag = dragHandles(svg, {
    hit(point) {
      const reach = HANDLE.overhang + point.slop;
      if (point.y < barTop - reach || point.y > barBottom + reach) return null;
      const distances = dividers.map((x) => Math.abs(point.x - x));
      const nearest = Math.min(...distances);
      if (nearest > HANDLE.width / 2 + point.slop) return null;
      const ties = distances.flatMap((distance, k) => (distance - nearest <= DIVIDER_TIE ? [k] : []));
      // Dividers move sideways only: on a touch screen an up or down swipe that starts on one scrolls the page.
      return { ties, k: ties.length === 1 ? ties[0] : null, from: point.x, offset: dividers[ties[0]] - point.x, axis: "x" };
    },
    start(handle) {
      dragged = handle.k;
      paintHighlights();
    },
    move(handle, point) {
      if (handle.k === null) {
        // Dividers on top of each other: dragging left takes the first, dragging right the last.
        if (Math.abs(point.x - handle.from) < 0.5) return;
        handle.k = point.x < handle.from ? handle.ties[0] : handle.ties.at(-1);
        dragged = handle.k;
      }
      dragDivider(handle.k, point.x + handle.offset);
    },
    end() {
      dragged = null;
      paintHighlights();
    },
    hover(handle) {
      hovered = handle ? (handle.k ?? handle.ties.at(-1)) : null;
      paintHighlights();
    },
    cursor: () => "ew-resize",
  });

  render();
  return {
    reset() {
      state.opacity = [...REST.opacity];
      state.support = [...REST.support];
      opacitySliders.forEach((control, k) => control.set(state.opacity[k]));
      supportSliders.forEach((control, k) => control.set(state.support[k]));
      render();
    },
    destroy() {
      drag.destroy();
    },
  };
}
