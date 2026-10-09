/**
 * Interactive "Constant versus linear color" (theory.html, why_linear_color): one color channel f on a slice through
 * the patch center p, approximated by the constant f(p) and by the tangent line l_p(x) = f(p) + f'(p)(x - p) on the
 * window |x - p| <= r. Each fit shows its pale tolerance band (+- epsilon) and its error (shaded) over the window,
 * and a thick bar marks the widest window on which it stays within epsilon, found on a dense grid of radii and
 * refined by bisection. The small plot shows the largest error on |x - p| <= r against r, under the dashed bounds
 * L r and M r^2 / 2. The visitor drags p along the slice and r along the plot's axis, or sets p, r and epsilon with
 * the sliders.
 *
 * The math, constants, colors and layout are those of lin_f(), lin_valid_radius(), lin_exit(), draw_fit_panel() and
 * draw_why_linear_color() in tools/make_theory_animations.py. The default state is the poster frame (loop phase
 * 0.62): p = 0, r = 0.62 and epsilon = 0.05, where the widest windows have half-widths 0.088 (constant) and 0.337
 * (tangent line), 3.8 times wider. The error plot keeps the animation's axis of 0 to 3 epsilon, so its curves and
 * bounds rescale when epsilon changes.
 */
import {
  COLORS,
  FONT,
  PT,
  SERIF,
  SIZE,
  clamp,
  cssVar,
  dragHandles,
  ease,
  el,
  flip,
  group,
  htmlLabel,
  icon,
  readout,
  rgb,
  serifReady,
  signed,
  slider,
  snap,
  svgEl,
  svgPath,
  svgStage,
  svgText,
  textColor,
  uid,
} from "./core.js";

export const hint = "Drag p along the slice, or r along the axis of the error plot.";

// tools/make_theory_animations.py, section 5 (why_linear_color). f(x) = 0.5 + A1 sin(K1 x + P1) + A2 sin(K2 x + P2).
const WAVES = [[0.28, 1.25, 0.2], [0.12, 2.6, 0.9]];
const L = WAVES.reduce((sum, [a, k]) => sum + a * k, 0); // sup |f'| <= L = 0.662
const M = WAVES.reduce((sum, [a, k]) => sum + a * k * k, 0); // sup |f''| <= M = 1.2487
const R_MAX = 0.62; // LIN_RMAX: the largest window drawn, and the poster's
const R_STEP = R_MAX / 1240; // the spacing of LIN_RADII, linspace(0, 0.62, 1241)
const RADII = Array.from({ length: 1241 }, (_, k) => k * R_STEP);
const SPAN = 0.68; // LIN_SPAN: half-width of the plotted slice around the poster's p = 0
const Y_LIMITS = [0.03, 1.06]; // LIN_YLIM
const BAR_Y = 0.08; // LIN_BAR_Y
const TICKS = [-0.6, -0.3, 0.0, 0.3, 0.6]; // LIN_TICKS
const MARK_RAMP = 0.02; // LIN_MARK_RAMP
const FIT_RECT = { left: 22, width: 392, height: 146 }; // draw_fit_panel rect; bottoms 238 (constant) and 82 (affine)
const ERROR_RECT = [480, 82, 218, 232]; // the error axes
const ERROR_TICKS = [0, 0.2, 0.4, 0.6];
const TICK = { length: 3 * PT, width: 0.8 * PT, pad: 2.5 * PT }; // format_axis()
const SPINE_WIDTH = 0.9 * PT;
const FITS = [
  { key: "constant", color: COLORS.beta[2], title: "constant color $f(p)$", bottom: 238, labelTicks: false },
  { key: "affine", color: COLORS.beta[32], title: "affine color, tangent at $p$", bottom: 82, labelTicks: true },
];
// The widget beyond the animation: the ranges of its controls, the rest state (the poster), the longest radius the
// search for the widest window tries, and the drag knobs.
const REST = { p: 0, r: R_MAX, eps: 0.05 };
const P_RANGE = [-0.6, 0.6];
const EPS_RANGE = [0.03, 0.1];
const SEARCH_RADIUS = 6; // f ranges over more than 0.3 in any window this wide: every epsilon of the slider is crossed
const KNOB = { radius: 6, halo: 13 };

/* ---------- The script's math ---------- */

function f(x) {
  return WAVES.reduce((sum, [a, k, phase]) => sum + a * Math.sin(k * x + phase), 0.5);
}

function df(x) {
  return WAVES.reduce((sum, [a, k, phase]) => sum + a * k * Math.cos(k * x + phase), 0);
}

/** The two fits at p: the constant f(p) and the tangent line l_p, each a function of x. */
function fitsAt(p) {
  const value = f(p);
  const slope = df(p);
  return { constant: () => value, affine: (x) => value + slope * (x - p) };
}

/** The larger error of a fit at the two ends of [p - r, p + r]. */
function endError(fit, p, r) {
  return Math.max(Math.abs(f(p + r) - fit(p + r)), Math.abs(f(p - r) - fit(p - r)));
}

/** lin_max_error(): the largest error on |x - p| <= r for every r of RADII, as a running maximum. */
function maxErrors(fit, p) {
  let running = 0;
  return RADII.map((r) => {
    running = Math.max(running, endError(fit, p, r));
    return running;
  });
}

/**
 * lin_valid_radius(): the largest r whose window keeps the error within eps. The first radius of the grid (spacing
 * R_STEP, as the script's) whose running maximum exceeds eps brackets the crossing, which bisection then refines;
 * Infinity when no window up to SEARCH_RADIUS exceeds eps.
 */
function validRadius(fit, p, eps) {
  let running = 0;
  const steps = Math.ceil(SEARCH_RADIUS / R_STEP);
  for (let k = 1; k <= steps; k += 1) {
    running = Math.max(running, endError(fit, p, k * R_STEP));
    if (running <= eps) continue;
    let lo = (k - 1) * R_STEP;
    let hi = k * R_STEP;
    for (let i = 0; i < 80; i += 1) {
      const middle = 0.5 * (lo + hi);
      if (endError(fit, p, middle) - eps <= 0) lo = middle;
      else hi = middle;
    }
    return lo;
  }
  return Infinity;
}

/** lin_exit(): the end of [p - r, p + r] at which the error of the fit reaches eps. */
function exitPoint(fit, p, eps, radius) {
  const ends = [p - radius, p + radius];
  const gaps = ends.map((x) => Math.abs(Math.abs(f(x) - fit(x)) - eps));
  return gaps[0] <= gaps[1] ? ends[0] : ends[1];
}

/** lin_marks(): the marks of the widest window fade in once r passes it. */
function markOpacity(r, rValid) {
  return ease((r - rValid) / MARK_RAMP);
}

/* ---------- Layout ---------- */

/** Axes over rect = [left, bottom, width, height] (GIF pixels from the bottom left) with data limits x and y. */
function axesMap([left, bottom, width, height], [x0, x1], [y0, y1]) {
  return {
    left,
    right: left + width,
    top: flip(bottom + height),
    bottom: flip(bottom),
    width,
    height,
    x: (u) => left + ((u - x0) / (x1 - x0)) * width,
    y: (v) => flip(bottom + ((v - y0) / (y1 - y0)) * height),
    u: (x) => x0 + ((x - left) / width) * (x1 - x0),
  };
}

/** A closed band between two curves sampled at the same xs. */
function band(xs, lower, upper, axes) {
  const top = xs.map((x, k) => [axes.x(x), axes.y(upper[k])]);
  const bottom = xs.map((x, k) => [axes.x(x), axes.y(lower[k])]).reverse();
  return svgPath([...top, ...bottom]);
}

function linspace(start, end, count) {
  return Array.from({ length: count }, (_, k) => start + ((end - start) * k) / (count - 1));
}

const metricsContext = document.createElement("canvas").getContext("2d");

/** Inked ascent of "l" and descent of "p" in the serif at `size`: matplotlib's "lp" box, by which ticks align. */
function lpBox(size) {
  metricsContext.font = `1000px ${SERIF}`;
  const l = metricsContext.measureText("l");
  const p = metricsContext.measureText("p");
  return { ascent: (l.actualBoundingBoxAscent / 1000) * size, descent: (p.actualBoundingBoxDescent / 1000) * size };
}

const formatRadius = (r) => (Number.isFinite(r) ? r.toFixed(3) : `more than ${SEARCH_RADIUS}`);

export function mount(container, { stage, controls }) {
  const state = { ...REST };
  const select = cssVar("--hx-select") || "#5d70ae";
  const ink = rgb(COLORS.ink);
  const guide = rgb(COLORS.guide);
  const svg = svgStage(stage);
  const defs = svgEl("defs", {}, svg);
  const clipTo = (axes) => {
    const id = uid("hx-lc-clip");
    const path = svgEl("clipPath", { id }, defs);
    svgEl("rect", { x: axes.left, y: axes.top, width: axes.width, height: axes.height }, path);
    return `url(#${id})`;
  };

  /* draw_fit_panel(): per fit, its band, error shading, bars, the fit, f, p, the exit mark and its note. */
  const panels = FITS.map((fit) => {
    const axes = axesMap([FIT_RECT.left, fit.bottom, FIT_RECT.width, FIT_RECT.height], [-SPAN, SPAN], Y_LIMITS);
    const color = rgb(fit.color);
    const clip = svgEl("g", { "clip-path": clipTo(axes) }, svg);
    const bandPath = svgEl("path", { fill: color, "fill-opacity": 0.16 }, clip);
    const shade = svgEl("path", { fill: color, "fill-opacity": 0.38 }, clip);
    const windowLine = svgEl("line", { stroke: guide, "stroke-width": 1.3 * PT, y1: axes.y(BAR_Y), y2: axes.y(BAR_Y) }, clip);
    const validBar = svgEl("line", { stroke: color, "stroke-width": 5.0 * PT, y1: axes.y(BAR_Y), y2: axes.y(BAR_Y) }, clip);
    const fitLine = svgEl("path", { fill: "none", stroke: color, "stroke-width": 2.2 * PT, "stroke-linecap": "round", "stroke-linejoin": "round" }, clip);
    const curve = svgEl("path", { fill: "none", stroke: ink, "stroke-width": 2.2 * PT, "stroke-linecap": "round", "stroke-linejoin": "round" }, clip);
    // The bottom spine and the ticks (format_axis); only the affine panel labels its p tick.
    TICKS.forEach((tick) => {
      svgEl("line", { x1: axes.x(tick), x2: axes.x(tick), y1: axes.bottom, y2: axes.bottom + TICK.length, stroke: ink, "stroke-width": TICK.width }, svg);
    });
    const pTick = svgEl("line", { y1: axes.bottom, y2: axes.bottom + TICK.length, stroke: ink, "stroke-width": TICK.width }, svg);
    svgEl("line", { x1: axes.left, x2: axes.right, y1: axes.bottom, y2: axes.bottom, stroke: guide, "stroke-width": SPINE_WIDTH }, svg);
    const pLabel = fit.labelTicks ? svgText(svg, { size: FONT.small, anchor: "middle", align: "top" }) : null;
    const pDot = svgEl("circle", { r: (Math.sqrt(34) / 2) * PT, fill: ink, stroke: "white", "stroke-width": 1.0 * PT }, svg);
    const exitMark = svgEl("circle", { r: (Math.sqrt(50) / 2) * PT, fill: "white", stroke: color, "stroke-width": 1.7 * PT }, svg);
    // The script's halo (haloed_text): once p moves, f can pass behind the note.
    const note = svgText(svg, { size: FONT.small, anchor: "middle", align: "bottom", fill: textColor(fit.color), halo: true });
    svgText(svg, { size: FONT.label, anchor: "start", align: "top", fill: textColor(fit.color) }).set(fit.title, axes.left, axes.top);
    return { fit, axes, bandPath, shade, windowLine, validBar, fitLine, curve, pTick, pLabel, pDot, exitMark, note };
  });
  svgText(svg, { size: FONT.small, anchor: "middle", align: "middle" }).set("position $x$ on a slice through $p$", 218, flip(26));

  /* The error plot: the largest error on |x - p| <= r against r, under the bounds L r and M r^2 / 2. */
  const errorAxes = axesMap(ERROR_RECT, [0, R_MAX], [0, 3]); // y in units of epsilon
  const errorClip = svgEl("g", { "clip-path": clipTo(errorAxes) }, svg);
  svgEl("line", {
    x1: errorAxes.left,
    x2: errorAxes.right,
    y1: errorAxes.y(1),
    y2: errorAxes.y(1),
    stroke: ink,
    "stroke-width": 1.1 * PT,
    "stroke-dasharray": `${1 * 1.1 * PT} ${2.2 * 1.1 * PT}`,
  }, errorClip);
  const errorPlots = FITS.map((fit) => {
    const color = rgb(fit.color);
    const bound = svgEl("path", {
      fill: "none",
      stroke: color,
      "stroke-width": 1.5 * PT,
      "stroke-opacity": 0.85,
      "stroke-dasharray": `${4 * 1.5 * PT} ${2 * 1.5 * PT}`,
    }, errorClip);
    const markLine = svgEl("line", { stroke: color, "stroke-width": 1.2 * PT, "stroke-dasharray": `${2 * 1.2 * PT} ${2 * 1.2 * PT}` }, errorClip);
    const errorLine = svgEl("path", { fill: "none", stroke: color, "stroke-width": 2.6 * PT, "stroke-linecap": "round", "stroke-linejoin": "round" }, errorClip);
    return { fit, bound, markLine, errorLine };
  });
  // Marks and dots stay whole at the plot's edges (the script's axes would clip a marker sitting on them).
  errorPlots.forEach((plot) => {
    const color = rgb(plot.fit.color);
    plot.markCircle = svgEl("circle", { r: (Math.sqrt(50) / 2) * PT, fill: "white", stroke: color, "stroke-width": 1.7 * PT }, svg);
    // scatter(s=30) with the default 1.5 pt edge in the face color
    plot.dot = svgEl("circle", { r: (Math.sqrt(30) / 2) * PT, fill: color, stroke: color, "stroke-width": 1.5 * PT }, svg);
  });
  const boundLabels = [
    svgText(svg, { size: FONT.label, anchor: "end", align: "middle", fill: textColor(COLORS.beta[2]) }),
    svgText(svg, { size: FONT.label, anchor: "end", align: "middle", fill: textColor(COLORS.beta[32]) }),
  ];
  // Spines and ticks of the error axes.
  ERROR_TICKS.forEach((tick) => {
    svgEl("line", { x1: errorAxes.x(tick), x2: errorAxes.x(tick), y1: errorAxes.bottom, y2: errorAxes.bottom + TICK.length, stroke: ink, "stroke-width": TICK.width }, svg);
  });
  [0, 1, 2, 3].forEach((level) => {
    svgEl("line", { x1: errorAxes.left - TICK.length, x2: errorAxes.left, y1: errorAxes.y(level), y2: errorAxes.y(level), stroke: ink, "stroke-width": TICK.width }, svg);
  });
  svgEl("path", {
    d: `M${errorAxes.left},${errorAxes.top}V${errorAxes.bottom}H${errorAxes.right}`,
    fill: "none",
    stroke: guide,
    "stroke-width": SPINE_WIDTH,
  }, svg);
  const xTickLabels = ERROR_TICKS.map(() => svgText(svg, { size: FONT.small, anchor: "middle", align: "top" }));
  const yTickLabels = [0, 1, 2, 3].map(() => svgText(svg, { size: FONT.small, anchor: "end", align: "baseline" }));
  const xLabel = svgText(svg, { size: FONT.label, anchor: "middle", align: "top" });
  const errorTitle = svgText(svg, { size: FONT.label, anchor: "middle", align: "middle" });
  svgText(svg, { size: FONT.small, anchor: "middle", align: "middle", fill: COLORS.note }).set("dashed: bound", 586, flip(352));

  /** Set a label and shift it back inside [low, high] if the serif, a little wider than the script's, pushes it out. */
  function placeInside(label, text, x, y, [low, high]) {
    label.set(text, x, y);
    const box = label.node.getBBox();
    if (!box.width) return; // not laid out (hidden): placed again on the next input
    const shift = Math.max(0, low - box.x) - Math.max(0, box.x + box.width - high);
    if (shift) label.set(text, x + shift, y);
  }

  /** Tick labels, placed like matplotlib's: x labels hang below the ticks, y labels center between top and baseline. */
  function placeTickLabels() {
    const small = lpBox(FONT.small);
    const top = errorAxes.bottom + TICK.length + TICK.pad;
    ERROR_TICKS.forEach((tick, k) => xTickLabels[k].set(k ? tick.toFixed(1) : "0", errorAxes.x(tick), top));
    ["0", "$\\varepsilon$", "$2\\varepsilon$", "$3\\varepsilon$"].forEach((text, level) => {
      yTickLabels[level].set(text, errorAxes.left - TICK.length - TICK.pad, errorAxes.y(level) + small.ascent / 2);
    });
    xLabel.set("half-width $r$", (errorAxes.left + errorAxes.right) / 2, top + small.ascent + small.descent + 1.0 * PT);
    placeInside(errorTitle, "max error on $|x-p|\\leq r$", 586, flip(384), [0, SIZE.width - 4]);
  }

  /* Drag knobs: p on the axis of each slice, r on the axis of the error plot. */
  const knob = (x, y) => {
    const node = svgEl("g", { class: "hx-lc-knob" }, svg);
    const halo = svgEl("circle", { r: KNOB.halo, fill: select, opacity: 0 }, node);
    const grip = svgEl("circle", { r: KNOB.radius, fill: "white", stroke: ink, "stroke-width": 1.4 }, node);
    for (const circle of [halo, grip]) {
      circle.setAttribute("cx", x);
      circle.setAttribute("cy", y);
    }
    return { node, halo, grip };
  };
  const pKnobs = panels.map((panel) => knob(0, panel.axes.bottom));
  const rKnob = knob(0, errorAxes.bottom);

  /* Controls: p, r and epsilon; the readout under them. */
  const pSlider = slider({
    label: "$p$",
    name: "Patch center p on the slice",
    value: state.p,
    min: P_RANGE[0],
    max: P_RANGE[1],
    step: 0.01,
    format: (value) => signed(value, 2),
    onInput: (value) => {
      state.p = value;
      render();
    },
  });
  const rSlider = slider({
    label: "$r$",
    name: "Half-width r of the window around p",
    value: state.r,
    min: 0,
    max: R_MAX,
    step: 0.01,
    onInput: (value) => {
      state.r = value;
      render();
    },
  });
  const epsSlider = slider({
    label: "$\\varepsilon$",
    name: "Tolerance epsilon",
    value: state.eps,
    min: EPS_RANGE[0],
    max: EPS_RANGE[1],
    step: 0.005,
    format: (value) => value.toFixed(3),
    onInput: (value) => {
      state.eps = value;
      render();
    },
  });
  controls.append(
    group({ legend: "Patch center" }, [pSlider.element]),
    group({ legend: "Window half-width" }, [rSlider.element]),
    group({ legend: "Tolerance" }, [epsSlider.element]),
  );
  const summary = readout();
  controls.append(summary);

  let hovered = null;
  let dragged = null;

  function paintHighlights() {
    const active = dragged ?? hovered;
    const paint = ({ halo, grip }, on) => {
      halo.setAttribute("opacity", on ? (dragged ? 0.28 : 0.18) : 0);
      grip.setAttribute("stroke", on ? select : ink);
    };
    pKnobs.forEach((item) => paint(item, active === "p"));
    paint(rKnob, active === "r");
  }

  function render() {
    const { p, r, eps } = state;
    const fits = fitsAt(p);
    const xs = linspace(-SPAN, SPAN, 600);
    const windowXs = linspace(p - r, p + r, 400);
    const valid = {};

    panels.forEach((panel) => {
      const { axes } = panel;
      const fit = fits[panel.fit.key];
      const rValid = validRadius(fit, p, eps);
      valid[panel.fit.key] = rValid;
      const approx = windowXs.map(fit);
      const shown = r > 1e-6;
      panel.bandPath.setAttribute("d", shown ? band(windowXs, approx.map((v) => v - eps), approx.map((v) => v + eps), axes) : "");
      panel.shade.setAttribute("d", shown ? band(windowXs, approx, windowXs.map(f), axes) : "");
      panel.fitLine.setAttribute("d", shown ? svgPath(windowXs.map((x, k) => [axes.x(x), axes.y(approx[k])]), false) : "");
      const inside = Math.min(r, rValid);
      for (const [line, half] of [[panel.windowLine, r], [panel.validBar, inside]]) {
        line.setAttribute("x1", axes.x(p - half));
        line.setAttribute("x2", axes.x(p + half));
        line.setAttribute("visibility", shown ? "visible" : "hidden");
      }
      panel.curve.setAttribute("d", svgPath(xs.map((x) => [axes.x(x), axes.y(f(x))]), false));
      panel.pDot.setAttribute("cx", axes.x(p));
      panel.pDot.setAttribute("cy", axes.y(f(p)));
      panel.pTick.setAttribute("x1", axes.x(p));
      panel.pTick.setAttribute("x2", axes.x(p));
      panel.pLabel?.set("$p$", axes.x(p), axes.bottom + TICK.length + TICK.pad);

      // The marks of the widest window within eps: its exit point on f and its half-width.
      const marks = shown && Number.isFinite(rValid) ? markOpacity(r, rValid) : 0;
      const exit = Number.isFinite(rValid) ? exitPoint(fit, p, eps, rValid) : p;
      const exitX = axes.x(exit);
      const exitShown = marks > 0 && exitX >= axes.left && exitX <= axes.right;
      panel.exitMark.setAttribute("cx", exitX);
      panel.exitMark.setAttribute("cy", axes.y(f(exit)));
      panel.exitMark.setAttribute("opacity", exitShown ? marks : 0);
      placeNote(panel, marks >= 0.05 ? marks : 0, `within $\\varepsilon$ for $r\\leq${formatRadius(rValid)}$`);
    });

    // The error plot, in units of eps.
    const scaled = (value) => value / eps;
    const k = Math.max(0, RADII.findLastIndex((radius) => radius <= r + 1e-12));
    errorPlots.forEach((plot) => {
      const fit = fits[plot.fit.key];
      const errors = maxErrors(fit, p);
      const boundAt = plot.fit.key === "constant" ? (radius) => L * radius : (radius) => (M * radius * radius) / 2;
      const boundRadii = plot.fit.key === "constant" ? [0, R_MAX] : RADII.filter((_, i) => i % 4 === 0 || i === RADII.length - 1);
      plot.bound.setAttribute("d", svgPath(boundRadii.map((radius) => [errorAxes.x(radius), errorAxes.y(scaled(boundAt(radius)))]), false));
      const shownRadii = RADII.slice(0, k + 1);
      plot.errorLine.setAttribute(
        "d",
        shownRadii.length > 1 ? svgPath(shownRadii.map((radius, i) => [errorAxes.x(radius), errorAxes.y(scaled(errors[i]))]), false) : "",
      );
      const rValid = valid[plot.fit.key];
      const marks = r > 1e-6 && Number.isFinite(rValid) && rValid <= R_MAX ? markOpacity(r, rValid) : 0;
      plot.markLine.setAttribute("x1", errorAxes.x(rValid));
      plot.markLine.setAttribute("x2", errorAxes.x(rValid));
      plot.markLine.setAttribute("y1", errorAxes.y(0));
      plot.markLine.setAttribute("y2", errorAxes.y(1));
      plot.markLine.setAttribute("opacity", marks);
      plot.markCircle.setAttribute("cx", errorAxes.x(rValid));
      plot.markCircle.setAttribute("cy", errorAxes.y(1));
      plot.markCircle.setAttribute("opacity", marks);
      const dotShown = r > 1e-6 && errors[k] <= 3 * eps;
      plot.dot.setAttribute("cx", errorAxes.x(RADII[k]));
      plot.dot.setAttribute("cy", errorAxes.y(scaled(errors[k])));
      plot.dot.setAttribute("visibility", dotShown ? "visible" : "hidden");
    });
    const level = 2.5 * eps;
    boundLabels[0].set("$Lr$", errorAxes.x(level / L - 0.025), errorAxes.y(2.5));
    boundLabels[1].set("$Mr^2/2$", errorAxes.x(Math.sqrt((2 * level) / M) - 0.025), errorAxes.y(2.5));

    // Knobs.
    panels.forEach((panel, i) => {
      for (const circle of [pKnobs[i].halo, pKnobs[i].grip]) circle.setAttribute("cx", panel.axes.x(p));
    });
    for (const circle of [rKnob.halo, rKnob.grip]) circle.setAttribute("cx", errorAxes.x(r));

    // Readouts.
    const ratio = valid.affine / valid.constant;
    const both = Number.isFinite(valid.affine) && Number.isFinite(valid.constant);
    summary.replaceChildren(
      el("span", { className: "hx-fig-readout-main" }, [
        icon("circle-check"),
        " ",
        htmlLabel(
          `Within $\\varepsilon=${eps.toFixed(3)}$: the linear color holds for $r\\leq${formatRadius(valid.affine)}$, ` +
            `the constant for $r\\leq${formatRadius(valid.constant)}$`,
        ),
        !both ? "." : ratio >= 1.05 ? el("strong", { text: `, ${ratio.toFixed(1)} times wider.` }) : ", about as wide, since f is nearly flat at p.",
      ]),
      el("span", { className: "hx-fig-readout-note" }, [
        htmlLabel(
          `Slope $f'(p)=${df(p).toFixed(3)}$. The errors stay under $Lr$ and $Mr^2/2$, with $L=${L.toFixed(3)}$ and ` +
            `$M=${M.toFixed(3)}$ bounding $|f'|$ and $|f''|$ everywhere.`,
        ),
      ]),
    );
    svg.setAttribute(
      "aria-label",
      `A color channel f near p = ${signed(p, 2)} with the constant f(p) and the tangent line at p over the window ` +
        `|x - p| <= ${r.toFixed(2)}. Within epsilon = ${eps.toFixed(3)} the tangent line holds for r up to ` +
        `${formatRadius(valid.affine)} and the constant for r up to ${formatRadius(valid.constant)}` +
        `${both ? `, ${ratio.toFixed(1)} times wider` : ""}.`,
    );
    paintHighlights();
  }

  /** The note "within eps for r <= ..." centered on p, kept inside its panel. */
  function placeNote(panel, opacity, text) {
    const { axes, note } = panel;
    note.node.setAttribute("opacity", opacity);
    if (opacity) placeInside(note, text, axes.x(state.p), axes.y(BAR_Y + 0.05), [axes.left, axes.right]);
  }

  // p and r move sideways only (axis "x"), so on a touch screen an up or down swipe that starts on a knob scrolls.
  const drag = dragHandles(svg, {
    hit(point) {
      const near = (cx, cy, radius) => Math.hypot(point.x - cx, point.y - cy) <= radius + point.slop;
      const rX = errorAxes.x(state.r);
      if (near(rX, errorAxes.bottom, KNOB.radius)) return { key: "r", axis: "x", offset: rX - point.x };
      for (const panel of panels) {
        const pX = panel.axes.x(state.p);
        if (near(pX, panel.axes.bottom, KNOB.radius) || near(pX, panel.axes.y(f(state.p)), 4)) {
          return { key: "p", axis: "x", offset: pX - point.x };
        }
      }
      return null;
    },
    start(handle) {
      dragged = handle.key;
      paintHighlights();
    },
    move(handle, point) {
      const x = point.x + handle.offset;
      if (handle.key === "p") {
        state.p = clamp(snap(panels[0].axes.u(x), 0.01), ...P_RANGE);
        pSlider.set(state.p);
      } else {
        state.r = clamp(snap(errorAxes.u(x), 0.01), 0, R_MAX);
        rSlider.set(state.r);
      }
      render();
    },
    end() {
      dragged = null;
      paintHighlights();
    },
    hover(handle) {
      hovered = handle?.key ?? null;
      paintHighlights();
    },
    cursor: () => "ew-resize",
  });

  placeTickLabels();
  render();
  serifReady().then(() => {
    if (!svg.isConnected) return;
    placeTickLabels();
    render();
  });

  return {
    reset() {
      Object.assign(state, REST);
      pSlider.set(state.p);
      rSlider.set(state.r);
      epsSlider.set(state.eps);
      render();
    },
    destroy() {
      drag.destroy();
    },
  };
}
