/**
 * Interactive theory figures (theory.html only): every theory animation can also be shown as a figure the visitor
 * changes by hand, and this module is the framework for those widgets plus the helpers they share.
 *
 * Panels and modes. A panel is one div.hx-anim-media of theory.html (a poster <img> and a hover-to-play <video>).
 * Its figure name is the panel's data-widget attribute or else the stem of its video's data-src
 * ("static/anim/<name>.mp4"), and its widget is the ES module static/js/theory/<name>.js. static/js/site.js imports
 * this module on theory.html and calls attachFigure() for every panel. A compact switch above the panel then offers
 * "Animation", the default (the poster and the hover-to-play video, unchanged), and "Interactive"; the choice is
 * remembered per figure for the browser session. Until the visitor first opens an interactive figure, a honey dot
 * rests on "Interactive" and pulses when a figure first comes into view, and after a few seconds of watching an
 * animation a short "Try it yourself" note, which also opens the figure, appears beside the switch; the pulse and the
 * note play once per figure and session. attachFigure's onMode("animation") tells site.js to build or enable the
 * panel's video group, and onMode("interactive") to stop and disable it, so an interactive figure never plays or
 * loads its video.
 *
 * Loading. Only the figures named in WIDGETS are tried, because importing a module that does not exist logs a 404
 * that no code can silence. A listed module is imported when its row comes within 600 px of the viewport and mounted
 * once its figure is interactive. If it is missing, has no mount() or throws while it loads or mounts, the figure
 * keeps its animation and loses the switch, with one console.info.
 *
 * Widget API. A widget module exports
 *   mount(container, { name, stage, controls, reducedMotion, setHint }) returning { reset(), destroy() }
 * and optionally `hint`, the one line under the figure that says what to drag (for example "Drag the arrow tips.").
 * container is the widget's div.hx-widget, which already holds the stage, the hint and Reset line and the controls;
 * the widget fills stage and controls and leaves the rest alone. stage is a box of exactly 16:9 styled like the
 * animation panel; the widget puts one drawing into it with svgStage() or canvasStage(), in layout units: the
 * animation's own 720 x 405 grid (SIZE), so the layout of tools/make_theory_animations.py ports one to one.
 * controls is the grid under the figure for group(), slider() and readout(): as many columns as fit at 10rem or
 * more (a widget can fix them with the custom property --hx-fig-grid), one column when the widget is narrower than
 * 30rem. reducedMotion is true when the visitor asked for reduced motion (no transitions then), and setHint(text)
 * replaces the hint. The Reset button calls reset(), which restores the animation's key frame; destroy() removes
 * every listener the widget added outside its own elements. A widget redraws on input and on resize only, never in
 * an idle loop, and draws in the animation's colors (COLORS, or values copied from the script) on its white stage.
 */
import { whenNear } from "../media.js";

/* ---------- Registry and shared constants ---------- */

/** Figures whose widget module exists. A figure missing here keeps its animation and sends no request. */
const WIDGETS = new Set([
  "hexel_anatomy",
  "hexel_sharpness",
  "hexels_on_surface",
  "why_linear_color",
  "why_hexagon",
  "honeycomb_area",
  "honeycomb",
  "alpha_compositing",
]);

const STORAGE_PREFIX = "hexels-theory-figure:";
const MODES = [
  { mode: "animation", label: "Animation", icon: "film" },
  { mode: "interactive", label: "Interactive", icon: "hand-pointer" },
];
// Set for the session once the visitor has opened any interactive figure; the cues then stop on every figure.
const TRIED_KEY = "hexels-theory-tried-interactive";
// The figures whose dot has pulsed, and whose note has shown, this session (names separated by spaces): each cue
// plays once per figure and session, while the resting dot stays until the visitor opens an interactive figure.
const PULSED_KEY = "hexels-theory-pulsed";
const NUDGED_KEY = "hexels-theory-nudged";
// Seconds of an animation watched before the "Try it yourself" note, and how long the note stays.
const NUDGE_AFTER_MS = 2500;
const NUDGE_SHOW_MS = 5000;
const figures = new Set();
const DEFAULT_HINT = "Drag the figure or use the sliders.";
const SVG_NS = "http://www.w3.org/2000/svg";
// Grab radius around a drag handle, in CSS pixels: a fingertip needs more room than a mouse pointer.
const TOUCH_SLOP_PX = 22;
const POINTER_SLOP_PX = 10;
// A finger on a sideways handle moves this far, in CSS pixels, before its drag starts or the page scrolls instead.
const AXIS_LOCK_PX = 6;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** The layout grid of the animations, in their GIF pixels: 720 x 405 (16:9), the units every widget draws in. */
export const SIZE = Object.freeze({ width: 720, height: 405 });

/** Layout units per matplotlib point: the script draws at 100 GIF pixels per inch. */
export const PT = 100 / 72;

/** The script's font sizes (FS_SMALL, FS_LABEL, FS_FORMULA, FS_BIG) in layout units. */
export const FONT = Object.freeze({ small: 18.7 * PT, label: 20.0 * PT, formula: 21.5 * PT, big: 23.0 * PT });

/** The animations' STIX serif; theory.html loads STIX Two Text from Google Fonts. */
export const SERIF = '"STIX Two Text", "Times New Roman", Times, serif';

/** The script's label halo (haloed_text): a white outline HALO_WIDTH points wide at alpha 0.92, under the glyphs. */
export const HALO = Object.freeze({ width: 4.0, alpha: 0.92 });

/** The shared colors of tools/make_theory_animations.py (INK, GUIDE, NOTE, BETA_COLORS, ...). */
export const COLORS = Object.freeze({
  ink: "#263f48", // lines and text
  guide: "#9baeb3", // axes, outlines of secondary shapes, hatching
  note: "#61777e", // secondary text
  beta: Object.freeze({ 2: "#458da5", 8: "#8b679a", 32: "#cd7353" }),
  tangent: Object.freeze({ u: "#244d76", v: "#715080" }),
  support: Object.freeze(["#ffffff", "#5d70ae"]), // SUPPORT_MAP, from white to the support color
  tint: "#eff1f7",
  surfaceGrid: "#6f818a",
  shape: Object.freeze({ 3: "#458da5", 4: "#8b679a", 6: "#cd7353" }), // triangle, square, hexagon
});

/* ---------- Colors ---------- */

/** An RGB triple in [0, 1] from "#rrggbb", "#rgb" or a triple. */
export function toRgb(color) {
  if (Array.isArray(color)) return color.map(Number);
  const hex = String(color).trim().replace(/^#/, "");
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`toRgb: not a hex color: ${color}`);
  return [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16) / 255);
}

/**
 * A CSS rgb() color from a triple in [0, 1] or a hex color, each channel clamped to [0, 1]; any other CSS color
 * string (such as "white" or a cssVar() value) is returned as it is.
 */
export function rgb(color) {
  if (typeof color === "string" && !color.trim().startsWith("#")) return color;
  const [r, g, b] = toRgb(color).map((channel) => Math.round(255 * Math.min(Math.max(channel, 0), 1)));
  return `rgb(${r}, ${g}, ${b})`;
}

/** The script's mix(): a linear RGB blend from a (w = 0) to b (w = 1), as a triple. */
export function mix(a, b, w) {
  const [ca, cb] = [toRgb(a), toRgb(b)];
  return ca.map((channel, index) => (1 - w) * channel + w * cb[index]);
}

/** The script's text_color(): a stroke color mixed with 30 percent ink, so that text in it reads on white. */
export function textColor(color) {
  return mix(color, COLORS.ink, 0.3);
}

/** A custom property of the page, such as cssVar("--hx-ours"), trimmed. */
export function cssVar(name, element = document.documentElement) {
  return getComputedStyle(element).getPropertyValue(name).trim();
}

/* ---------- Numbers and shapes ---------- */

/** value limited to [low, high]. */
export const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/** value rounded to a whole multiple of step. */
export const snap = (value, step) => Math.round(value / step) * step;

/** value with `digits` decimals and a real minus sign (U+2212), as matplotlib prints numbers; never "-0". */
export const signed = (value, digits) => value.toFixed(digits).replace(/^-(?=.*[1-9])/, "−").replace(/^-/, "");

/** The script's ease(): cosine ease-in-out on [0, 1], clamped outside. */
export function ease(x) {
  return 0.5 - 0.5 * Math.cos(Math.PI * clamp(x, 0, 1));
}

/** The canonical flat-top hexagon of the script's HEX_VERTICES: inradius 1, circumradius 2 / sqrt(3). */
export const HEX_VERTICES = Object.freeze(
  [0, 1, 2, 3, 4, 5].map((k) => Object.freeze([(2 / Math.sqrt(3)) * Math.cos((k * Math.PI) / 3), (2 / Math.sqrt(3)) * Math.sin((k * Math.PI) / 3)])),
);

/** The m corners of the regular polygon inscribed in the unit circle, the first at `angle` (radians), counterclockwise. */
export function regularPolygon(m, angle = 0) {
  return Array.from({ length: m }, (_, k) => [Math.cos(angle + (2 * Math.PI * k) / m), Math.sin(angle + (2 * Math.PI * k) / m)]);
}

/** The shoelace formula: a polygon's signed area, positive when its corners run counterclockwise. */
export function shoelace(points) {
  let sum = 0;
  points.forEach(([x, y], k) => {
    const [nx, ny] = points[(k + 1) % points.length];
    sum += x * ny - y * nx;
  });
  return 0.5 * sum;
}

/* ---------- Layout ---------- */

/** A y coordinate of the script's overlay (GIF pixels from the bottom) in layout units (from the top). */
export function flip(y) {
  return SIZE.height - y;
}

/**
 * The script's plane_axes(fig, rect, center, half_width): frameless axes over rect = [left, bottom, width, height]
 * (GIF pixels from the bottom left, as the script writes them) with one data unit equal in x and y. Returns
 * { x(u), y(v), unit }: data to layout coordinates (origin top left) and the layout units per data unit.
 */
export function planeAxes([left, bottom, width, height], [cx, cy], halfWidth) {
  const unit = width / (2 * halfWidth);
  const middle = flip(bottom + height / 2);
  return {
    unit,
    x: (u) => left + width / 2 + (u - cx) * unit,
    y: (v) => middle - (v - cy) * unit,
  };
}

/* ---------- DOM ---------- */

let idCount = 0;

/** A page-unique id, for SVG patterns, labels and inputs. */
export function uid(prefix = "hx-fig") {
  idCount += 1;
  return `${prefix}-${idCount}`;
}

/** An HTML element: el("p", { className, text, attrs }, children); attributes that are null or undefined are skipped. */
export function el(tag, { className, text, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value !== null && value !== undefined) node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}

/** An SVG element with attributes, appended to `parent` when one is given. */
export function svgEl(tag, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) node.setAttribute(name, value);
  }
  parent?.append(node);
  return node;
}

/** A Font Awesome solid glyph, hidden from screen readers. */
export function icon(name) {
  return el("i", { className: `fa-solid fa-${name}`, attrs: { "aria-hidden": "true" } });
}

/* ---------- Math labels ---------- */

const GREEK = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ",
  kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "ϕ",
  varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Pi: "Π",
  Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};
// Commands for symbols and their kind: "rel" and "bin" are spaced on both sides, "op" (an operator name) gets a thin
// space after it, "big" sets its subscript underneath, as mathtext does.
const SYMBOLS = {
  cdot: ["·", "bin"], times: ["×", "bin"], pm: ["±", "bin"], le: ["≤", "rel"], leq: ["≤", "rel"],
  ge: ["≥", "rel"], geq: ["≥", "rel"], approx: ["≈", "rel"], ne: ["≠", "rel"], neq: ["≠", "rel"],
  to: ["→", "rel"], in: ["∈", "rel"], sim: ["∼", "rel"], infty: ["∞", "ord"], partial: ["∂", "ord"],
  nabla: ["∇", "ord"], ell: ["ℓ", "ord"], prime: ["′", "ord"], "|": ["‖", "ord"], "{": ["{", "ord"],
  "}": ["}", "ord"], "_": ["_", "ord"], "%": ["%", "ord"], sum: ["Σ", "big"], min: ["min", "op"],
  max: ["max", "op"], log: ["log", "op"], exp: ["exp", "op"], sin: ["sin", "op"], cos: ["cos", "op"],
  tan: ["tan", "op"],
};
// mathtext's explicit spaces, in its em: the advance of an italic m.
const SPACES = {
  ",": 0.16667, "/": 0.16667, ">": 0.22222, ":": 0.22222, ";": 0.27778, " ": 0.33333, enspace: 0.5, quad: 1,
  qquad: 2, "!": -0.16667,
};
const CHAR_KIND = { "=": "rel", "<": "rel", ">": "rel", ":": "rel", "+": "bin", "-": "bin", "*": "bin", ",": "punct", ";": "punct" };
const CHAR_GLYPH = { "-": "−", "'": "′", "*": "∗" };
const NO_SPACE_BEFORE_BIN = new Set(["", "{", "(", "[", "=", "<", ">", ":"]);
const STYLE_COMMANDS = {
  mathbf: { bold: true, upright: true },
  mathrm: { upright: true },
  text: { upright: true, text: true },
  operatorname: { upright: true },
  mathit: { italic: true },
};
// Declarations that restyle the rest of their group, as in matplotlib's {\rm sp}.
const DECLARATIONS = { rm: { upright: true, italic: false }, it: { italic: true }, bf: { bold: true, upright: true } };
const LOWER_GREEK = /[α-ωϵϕϑϖ]/;
// mathtext's layout for the STIX fonts (STIXFontConstants and Parser): spaces in italic-m widths, script shifts and
// kerns in x-heights of the nucleus, scripts at 70 percent.
const MATHTEXT = {
  symbolSpace: 0.2, thinSpace: 0.16667, scriptScale: 0.7, sub1: 0.3, sub2: 0.6, sup1: 0.8, delta: 0.05,
  deltaSlanted: 0.3, scriptSpace: 0.1,
};
// \sum: mathtext draws the STIX summation sign; the STIX Two Text capital sigma takes its place, scaled to its
// height (scale) and dropped below the baseline (drop, in font sizes), pulled closer to its neighbours (before and
// after, in italic-m widths), with its limit gap font sizes underneath.
const BIG_OPERATOR = { scale: 1.55, drop: 0.28, before: -0.15, after: -0.22, gap: 0.18 };

/**
 * Parse a label in matplotlib's notation, as tools/make_theory_animations.py writes its labels: plain text, with
 * math between dollar signs ("pixel $I$", "$\\alpha_1=0.60$"; "\\$" is a dollar sign). Returns the runs of
 * parseMath() for the math and upright runs for the text between.
 */
function parseLabel(label) {
  const runs = [];
  for (const { text, math } of splitDollars(label)) parseMath(text, runs, !math);
  return runs;
}

/** The parts of a label: [{ text, math }], math between unescaped dollar signs; "\\$" becomes "$" in text. */
function splitDollars(label) {
  const parts = [];
  let text = "";
  let math = false;
  const source = String(label);
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\\" && source[i + 1] === "$" && !math) {
      text += "$";
      i += 1;
    } else if (source[i] === "$") {
      if (text) parts.push({ text, math });
      text = "";
      math = !math;
    } else {
      text += source[i];
    }
  }
  if (text) parts.push({ text, math });
  return parts;
}

/**
 * Parse a small TeX subset into runs, appended to `runs`, and lay them out as matplotlib's mathtext does. Letters
 * and lowercase Greek are italic; digits, operators and uppercase Greek upright; "-" is a minus sign. Supported:
 * _x, _{..}, ^x and ^{..} scripts; the Greek letters by name; \| (double bar), \le, \leq, \ge, \geq, \approx,
 * \sim, \ne, \cdot, \times, \pm, \to, \in, \partial, \infty, \ell, \prime; \sum, its subscript underneath; \min,
 * \max, \log, \exp, \sin, \cos, \tan; \mathbf, \mathrm, \text, \operatorname and \mathit; the declarations \rm,
 * \it and \bf, which restyle the rest of their group; the spaces \, \: \; "\ " ~ \quad \qquad \!. Typed spaces
 * count only inside \text; relations and binary operators get mathtext's spaces instead. An unknown command
 * throws. With plain, the source is text: literal and upright.
 * Each run is { text, italic, bold, scale, space, big, group }: space before it in italic-m widths, and group the
 * script it belongs to, { kind: "sub" | "sup" | "under", nucleus, runs, paired }.
 */
function parseMath(source, runs, plain = false) {
  let pos = 0;
  let pending = 0; // space before the next run
  let emitted = 0; // characters emitted so far

  const emit = (text, style, italic) => {
    emitted += 1;
    const run = {
      text,
      italic: style.italic ?? (!style.upright && italic),
      bold: Boolean(style.bold),
      scale: style.scale,
      space: pending,
      big: Boolean(style.big),
      group: style.group ?? null,
    };
    pending = 0;
    const last = runs.at(-1);
    const joins = last && !last.big && !run.big && run.space === 0 && last.group === run.group
      && last.italic === run.italic && last.bold === run.bold && last.scale === run.scale;
    if (joins) {
      last.text += text;
      return last;
    }
    run.group?.runs.push(run);
    runs.push(run);
    return run;
  };

  const previousChar = (at) => {
    for (let i = at - 1; i >= 0; i -= 1) if (source[i] !== " ") return source[i];
    return "";
  };
  const nextChar = (at) => {
    for (let i = at; i < source.length; i += 1) if (source[i] !== " ") return source[i];
    return "";
  };

  // Relations and binary operators get symbolSpace on both sides, except a binary operator that starts the text or
  // follows "{", an opening bracket or a relation (a sign); punctuation gets it after.
  const symbol = (glyph, style, italic, kind, at) => {
    if (kind === "rel" || kind === "bin") {
      const spaced = kind === "rel" || !NO_SPACE_BEFORE_BIN.has(previousChar(at));
      if (spaced) pending += MATHTEXT.symbolSpace;
      emit(glyph, style, italic);
      if (spaced) pending += MATHTEXT.symbolSpace;
      return;
    }
    emit(glyph, style, italic);
    if (kind === "punct") pending += MATHTEXT.symbolSpace;
  };

  // One atom: a {group}, a command or a character. Returns { kind, last } (the run scripts attach to), or null.
  const atom = (style) => {
    const at = pos;
    const char = source[pos];
    const before = emitted;
    const done = (kind = "ord") => ({ kind, last: emitted > before ? runs.at(-1) : null });
    if (char === "{") {
      pos += 1;
      sequence(style);
      pos += 1; // the closing brace
      return done();
    }
    pos += 1;
    if (char === "~" && !style.text) {
      pending += SPACES[" "];
      return null;
    }
    if (char !== "\\") {
      if (style.text) emit(char, style, false);
      else symbol(CHAR_GLYPH[char] ?? char, style, /[A-Za-z]/.test(char) || LOWER_GREEK.test(char), CHAR_KIND[char], at);
      return done(style.text ? "ord" : CHAR_KIND[char] ?? "ord");
    }
    const name = /[A-Za-z]/.test(source[pos] ?? "") ? source.slice(pos).match(/^[A-Za-z]+/)[0] : source[pos] ?? "";
    pos += name.length;
    if (SPACES[name] !== undefined) {
      pending += SPACES[name];
      return null;
    }
    if (STYLE_COMMANDS[name]) {
      if (pos < source.length) atom({ ...style, ...STYLE_COMMANDS[name] });
      return done();
    }
    if (DECLARATIONS[name]) return { declare: DECLARATIONS[name] };
    if (GREEK[name]) {
      emit(GREEK[name], style, LOWER_GREEK.test(GREEK[name]));
      return done();
    }
    if (!SYMBOLS[name]) throw new Error(`parseMath: unknown command \\${name} in ${source}`);
    const [glyph, kind] = SYMBOLS[name];
    if (kind === "big") {
      pending += BIG_OPERATOR.before / BIG_OPERATOR.scale;
      emit(glyph, { ...style, scale: style.scale * BIG_OPERATOR.scale, big: true }, false);
      pending += BIG_OPERATOR.after;
    } else if (kind === "op") {
      emit(glyph, { ...style, upright: true }, false);
      if (!"([{^_".includes(nextChar(pos)) && nextChar(pos) !== "") pending += MATHTEXT.thinSpace;
    } else {
      symbol(glyph, { ...style, upright: true }, false, kind, at);
    }
    return done(kind);
  };

  const sequence = (outer) => {
    let style = outer;
    while (pos < source.length && source[pos] !== "}") {
      if (source[pos] === " " && !style.text) {
        pos += 1;
        continue;
      }
      const item = atom(style);
      if (item?.declare) style = { ...style, ...item.declare };
      if (!item?.last) continue;
      const scripts = [];
      while (source[pos] === "_" || source[pos] === "^") {
        const sub = source[pos] === "_";
        pos += 1;
        const group = { kind: item.kind === "big" && sub ? "under" : sub ? "sub" : "sup", nucleus: item.last, runs: [], paired: false };
        atom({ ...style, scale: style.scale * MATHTEXT.scriptScale, group, big: false });
        scripts.push(group);
      }
      if (scripts.length > 1) scripts.forEach((group) => { group.paired = true; });
      if (item.kind === "op" && scripts.length) pending += MATHTEXT.thinSpace;
    }
  };

  sequence({ scale: 1, upright: plain, text: plain });
  return runs;
}

const measureContext = document.createElement("canvas").getContext("2d");
// Glyphs are measured at this size and scaled, because canvases round the metrics of small text to whole pixels.
const REFERENCE_SIZE = 1000;
const metricCache = new Map(); // emptied once the serif has loaded

function runFont(run, size) {
  return `${run.italic ? "italic " : ""}${run.bold ? "bold " : ""}${size * run.scale}px ${SERIF}`;
}

/** Advance width and inked ascent and descent of `text` at font size `size`, in the serif. */
function measure(text, size, { italic = false, bold = false } = {}) {
  const key = `${italic ? "i" : "r"}${bold ? "b" : "n"}${text}`;
  let unit = metricCache.get(key);
  if (!unit) {
    measureContext.font = `${italic ? "italic " : ""}${bold ? "bold " : ""}${REFERENCE_SIZE}px ${SERIF}`;
    const metrics = measureContext.measureText(text);
    unit = {
      width: metrics.width / REFERENCE_SIZE,
      ascent: metrics.actualBoundingBoxAscent / REFERENCE_SIZE,
      descent: metrics.actualBoundingBoxDescent / REFERENCE_SIZE,
    };
    metricCache.set(key, unit);
  }
  return { width: unit.width * size, ascent: unit.ascent * size, descent: unit.descent * size };
}

/**
 * Lay out runs at font size `size` (layout units): each run's x and baseline shift dy (up positive), the total
 * advance (width), and matplotlib's text box: height and depth (the part below the baseline), from the ink of the
 * runs but never smaller than "lp", by which matplotlib aligns text.
 */
function layoutRuns(runs, size) {
  const xHeight = (scale) => measure("x", size * scale).ascent;
  const em = (scale) => measure("m", size * scale, { italic: true }).width;
  const runMetrics = (run) => measure(run.text, size * run.scale, run);
  const placed = new Map(); // run -> { x, dy, width, ascent, descent }
  const flowPen = new Map(); // script group (or null for the main line) -> next free x
  flowPen.set(null, 0);
  let top = 0;
  let bottom = 0;
  let right = 0;
  for (const run of runs) {
    const metrics = runMetrics(run);
    const group = run.group;
    let x;
    let dy;
    if (group && group.runs[0] === run) {
      const nucleus = placed.get(group.nucleus);
      const h = xHeight(group.nucleus.scale);
      if (group.kind === "under") {
        const width = group.runs.reduce((sum, item) => sum + runMetrics(item).width, 0);
        x = nucleus.x + (nucleus.width - width) / 2;
        const gap = (BIG_OPERATOR.gap * size * group.nucleus.scale) / BIG_OPERATOR.scale;
        dy = -(nucleus.descent - nucleus.dy) - gap - metrics.ascent; // the limit's ink starts gap below the operator's
      } else {
        const slanted = group.nucleus.italic;
        const kern = group.kind === "sup" && slanted
          ? 2 * MATHTEXT.delta * h + MATHTEXT.deltaSlanted * (nucleus.ascent - (2 / 3) * h)
          : slanted ? 0 : MATHTEXT.delta * h;
        x = nucleus.x + nucleus.width + kern + run.space * em(run.scale);
        const shift = group.kind === "sup" ? MATHTEXT.sup1 : group.paired ? MATHTEXT.sub2 : MATHTEXT.sub1;
        dy = nucleus.dy + (group.kind === "sup" ? shift : -shift) * h;
      }
      group.dy = dy;
    } else if (group) {
      x = flowPen.get(group) + run.space * em(run.scale);
      dy = group.dy;
    } else {
      x = flowPen.get(null) + run.space * em(run.scale);
      dy = run.big ? -BIG_OPERATOR.drop * size : 0;
    }
    const item = { x, dy, width: metrics.width, ascent: metrics.ascent, descent: metrics.descent };
    placed.set(run, item);
    flowPen.set(group, x + metrics.width);
    // A script pushes on the line of its nucleus (and that line's own nucleus, for nested scripts), plus mathtext's
    // script space; a limit underneath does not.
    for (let script = group; script && script.kind !== "under"; script = script.nucleus.group) {
      const end = flowPen.get(script) + MATHTEXT.scriptSpace * xHeight(script.nucleus.scale);
      const line = script.nucleus.group;
      flowPen.set(line, Math.max(flowPen.get(line) ?? 0, end));
    }
    top = Math.max(top, metrics.ascent + dy);
    bottom = Math.max(bottom, metrics.descent - dy);
    right = Math.max(right, x + metrics.width);
  }
  const items = runs.map((run) => ({ text: run.text, italic: run.italic, bold: run.bold, scale: run.scale, ...placed.get(run) }));
  // matplotlib's text box (Text._get_layout): at least as tall as "lp" in the upright font, so that labels of one
  // size share their baselines.
  const l = measure("l", size);
  const p = measure("p", size);
  const height = Math.max(top + bottom, l.ascent + p.descent);
  const depth = Math.max(bottom, p.descent);
  return { runs: items, width: Math.max(flowPen.get(null), right), height, depth };
}

/** The baseline that places a laid-out label like matplotlib's va: "baseline", "top", "middle" or "bottom". */
function baselineFor(layout, y, align) {
  if (align === "top") return y + layout.height - layout.depth;
  if (align === "bottom") return y - layout.depth;
  if (align === "middle") return y + layout.height / 2 - layout.depth;
  return y;
}

function anchorOffset(width, anchor) {
  if (anchor === "middle") return -width / 2;
  if (anchor === "end") return -width;
  return 0;
}

/**
 * A label in an SVG figure. label = svgText(parent, { size, anchor, align, fill, halo }) adds an empty <text>;
 * label.set(text, x, y) writes it in matplotlib's notation (plain text with $math$, as the script writes it) and
 * places it like matplotlib's ha and va: anchor "start", "middle" or "end" and align "baseline", "top", "middle" or
 * "bottom". halo: true draws the script's white HALO under the glyphs. label.node is the <text>, for opacity and
 * other attributes. Labels place themselves again once the serif has loaded.
 */
export function svgText(parent, { size = FONT.label, anchor = "start", align = "baseline", fill = COLORS.ink, halo = false } = {}) {
  const node = svgEl("text", { fill: rgb(fill), "font-size": size }, parent);
  if (halo) {
    for (const [name, value] of Object.entries({
      stroke: "white",
      "stroke-width": HALO.width * PT,
      "stroke-opacity": HALO.alpha,
      "stroke-linejoin": "round",
      "paint-order": "stroke",
    })) node.setAttribute(name, value);
  }
  let last = null;
  const label = {
    node,
    set(text, x, y) {
      last = [text, x, y];
      const layout = layoutRuns(parseLabel(text), size);
      const start = x + anchorOffset(layout.width, anchor);
      const baseline = baselineFor(layout, y, align);
      node.replaceChildren();
      for (const run of layout.runs) {
        const tspan = svgEl("tspan", {
          x: start + run.x,
          y: baseline - run.dy,
          "font-size": size * run.scale,
          "font-style": run.italic ? "italic" : null,
          "font-weight": run.bold ? "bold" : null,
        }, node);
        tspan.textContent = run.text;
      }
      return label;
    },
  };
  // Measured with a fallback serif until STIX arrives: place the label again with the real metrics.
  serifReady().then(() => {
    if (last && node.isConnected) label.set(...last);
  });
  return label;
}

/**
 * Draw a label (matplotlib's notation) on a canvas at layout coordinates (x, y), with the options of svgText plus
 * color and alpha; returns its box { width, height, depth } (matplotlib's text box). halo: true (or { width, alpha },
 * width in points) first strokes the whole label in white, the script's haloed_text(). Use it in a canvasStage draw().
 */
export function canvasText(ctx, text, x, y, { size = FONT.label, anchor = "start", align = "baseline", color = COLORS.ink, alpha = 1, halo = false } = {}) {
  const layout = layoutRuns(parseLabel(text), size);
  const start = x + anchorOffset(layout.width, anchor);
  const baseline = baselineFor(layout, y, align);
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  if (halo) {
    const outline = halo === true ? HALO : halo;
    ctx.save();
    ctx.globalAlpha *= outline.alpha;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = outline.width * PT;
    ctx.lineJoin = "round";
    for (const run of layout.runs) {
      ctx.font = runFont(run, size);
      ctx.strokeText(run.text, start + run.x, baseline - run.dy);
    }
    ctx.restore();
  }
  ctx.fillStyle = rgb(color);
  for (const run of layout.runs) {
    ctx.font = runFont(run, size);
    ctx.fillText(run.text, start + run.x, baseline - run.dy);
  }
  ctx.restore();
  return layout;
}

/**
 * A label in matplotlib's notation as HTML, for slider labels, legends and readouts: the text in the page's font and
 * each $math$ part as a span.hx-math in the figures' serif (italic letters, <sub> and <sup>).
 */
export function htmlLabel(label) {
  const span = el("span", { className: "hx-label" });
  for (const part of splitDollars(label)) {
    if (!part.math) {
      span.append(part.text);
      continue;
    }
    const math = el("span", { className: "hx-math" });
    for (const run of parseMath(part.text, [])) {
      const em = 0.72 * run.space; // an italic m is about 0.72 em wide
      if (em > 0.04) math.append(em < 0.25 ? "\u2009" : em < 0.6 ? "\u2005" : "\u2003"); // thin, four-per-em, em space
      let node = document.createTextNode(run.text);
      if (run.italic) node = el("i", {}, [node]);
      if (run.bold) node = el("b", {}, [node]);
      if (run.group) node = el(run.group.kind === "sup" ? "sup" : "sub", {}, [node]);
      math.append(node);
    }
    span.append(math);
  }
  return span;
}

let serifPromise = null;

/** Resolves once the STIX serif (upright, italic, bold and Greek) is ready, or could not load; never rejects. */
export function serifReady() {
  serifPromise ??= Promise.all([
    document.fonts.load(`16px "STIX Two Text"`, "Iw0α−‖"),
    document.fonts.load(`italic 16px "STIX Two Text"`, "Iwα"),
    document.fonts.load(`bold 16px "STIX Two Text"`, "pctg"), // \mathbf
  ]).then(
    () => {
      metricCache.clear(); // measured with a fallback serif until now
      return true;
    },
    (error) => {
      console.info(`The figure serif did not load, a fallback serif is used: ${error.message}`);
      return false;
    },
  );
  return serifPromise;
}

/* ---------- Stages: SVG or canvas ---------- */

/** An <svg> filling the stage, in layout units (viewBox 0 0 720 405), with an accessible description `label`. */
export function svgStage(stage, { label = "" } = {}) {
  const svg = svgEl("svg", {
    class: "hx-fig-drawing",
    viewBox: `0 0 ${SIZE.width} ${SIZE.height}`,
    "font-family": SERIF,
    "text-rendering": "geometricPrecision",
    role: "img",
    "aria-label": label,
  });
  stage.append(svg);
  return svg;
}

/**
 * A pattern like matplotlib's hatch "////": diagonal `stroke` lines over a `fill`, `spacing` layout units apart
 * along x (8.33, as the script's bars show), drawn `width` wide. Returns the fill value "url(#id)".
 */
export function svgHatch(svg, { fill, stroke = COLORS.guide, spacing = 100 / 12, width = PT } = {}) {
  const defs = svg.querySelector("defs") ?? svgEl("defs", {}, null);
  if (!defs.isConnected) svg.prepend(defs);
  const id = uid("hx-fig-hatch");
  const pattern = svgEl("pattern", { id, patternUnits: "userSpaceOnUse", width: spacing, height: spacing }, defs);
  if (fill) svgEl("rect", { width: spacing, height: spacing, fill: rgb(fill) }, pattern);
  const s = spacing;
  svgEl("path", {
    d: `M${-s / 4},${s / 4} L${s / 4},${-s / 4} M0,${s} L${s},0 M${(3 * s) / 4},${(5 * s) / 4} L${(5 * s) / 4},${(3 * s) / 4}`,
    stroke: rgb(stroke),
    "stroke-width": width,
    "stroke-linecap": "square",
  }, pattern);
  return `url(#${id})`;
}

/**
 * A canvas filling the stage, sharp on high-DPI screens. draw(ctx, { width, height, pixelRatio }) paints the whole
 * figure in layout units: the context maps the 720 x 405 grid onto the canvas, and pixelRatio gives device pixels per
 * layout unit for per-pixel images. It runs when the canvas resizes, once the serif has loaded and after redraw(),
 * at most once per frame, never while idle. Returns { canvas, ctx, redraw(), destroy() }.
 */
export function canvasStage(stage, draw, { label = "" } = {}) {
  const canvas = el("canvas", { className: "hx-fig-drawing", attrs: { role: "img", "aria-label": label } });
  stage.append(canvas);
  const ctx = canvas.getContext("2d");
  let frame = 0;
  const paint = () => {
    frame = 0;
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return; // not displayed: it is painted when it shows again
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    ctx.setTransform(pixelWidth / SIZE.width, 0, 0, pixelHeight / SIZE.height, 0, 0);
    ctx.clearRect(0, 0, SIZE.width, SIZE.height);
    draw(ctx, { width, height, pixelRatio: pixelWidth / SIZE.width });
  };
  const redraw = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };
  const observer = new ResizeObserver(redraw);
  observer.observe(canvas);
  serifReady().then(redraw);
  return {
    canvas,
    ctx,
    redraw,
    destroy() {
      observer.disconnect();
      cancelAnimationFrame(frame);
    },
  };
}

/* ---------- Paths and arrows ---------- */

/** An SVG path through points (layout units), closed unless close is false. */
export function svgPath(points, close = true) {
  return points.map(([x, y], k) => `${k ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join("") + (close ? "Z" : "");
}

/** A closed canvas path through points, ready to fill, stroke or clip. */
export function polygonPath(ctx, points) {
  ctx.beginPath();
  points.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

/**
 * The script's arrow() on a canvas: a FancyArrowPatch "-|>" from start to end (layout units), lw points wide with a
 * head of mutation scale `head`, its tip `shrink` points short of end, with round caps and joins and a white halo
 * `halo` points wider than the line. As matplotlib draws it: the shaft (halo, then line), then the head (halo, then
 * fill).
 */
export function arrow(ctx, start, end, color, { lw = 2.1, head = 17, shrink = 0, halo = 3.2 } = {}) {
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  if (length < 1e-9) return;
  const d = [(end[0] - start[0]) / length, (end[1] - start[1]) / length];
  const n = [-d[1], d[0]];
  const width = lw * PT;
  const headLength = 0.4 * head * PT;
  const headHalf = 0.2 * head * PT;
  const sin = headHalf / Math.hypot(headLength, headHalf);
  const back = shrink * PT + (0.5 * width) / sin; // the wedge pad puts a mitered tip exactly on the shrunk end
  const apex = [end[0] - back * d[0], end[1] - back * d[1]];
  const base = [apex[0] - headLength * d[0], apex[1] - headLength * d[1]];
  const wedge = [[base[0] + headHalf * n[0], base[1] + headHalf * n[1]], apex, [base[0] - headHalf * n[0], base[1] - headHalf * n[1]]];
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const pass = (path, filled) => {
    path();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = width + halo * PT;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (filled) {
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.stroke();
  };
  pass(() => {
    ctx.beginPath();
    ctx.moveTo(...start);
    ctx.lineTo(...apex);
  }, false);
  pass(() => polygonPath(ctx, wedge), true);
  ctx.restore();
}

/* ---------- Direct manipulation ---------- */

/**
 * Drag handles drawn on a stage's <svg> or <canvas> (`target`) with a mouse, a pen or a finger. Points are in layout
 * units: { x, y, slop, pointerType }, where slop is the grab radius in layout units (22 CSS px for a finger, 10 for a
 * mouse or pen) to add to a handle's own size when hit-testing.
 *   hit(point) returns the handle under the point (any truthy value) or null; a handle that only moves sideways
 *     (a slider knob, a divider) says so with axis: "x";
 *   start(handle, point, event), move(handle, point, event) and end(handle, event) follow one drag;
 *   hover(handle or null) reports a mouse moving over the figure without dragging, for highlights;
 *   cursor(handle) gives the CSS cursor over a handle ("grab" by default; "grabbing" while dragging).
 * A touch that starts on a handle does not scroll the page (its touchstart is cancelled), except on a sideways
 * handle: there the drag waits until the finger has moved AXIS_LOCK_PX, starts if it went mostly sideways and
 * otherwise leaves the swipe to the page, and a tap starts and ends it at once (a jump or a preset). A swipe that
 * starts anywhere else scrolls as usual (CSS touch-action: pan-y), so a figure never traps a phone's scrolling.
 * Returns { destroy() }.
 */
export function dragHandles(target, { hit, start, move, end, hover, cursor = () => "grab" }) {
  let drag = null; // { handle, id }
  let pending = null; // a finger on a sideways handle that has not shown its direction yet: { handle, id, point, x, y }
  target.classList.add("hx-fig-draggable");
  const local = (clientX, clientY, pointerType) => {
    const rect = target.getBoundingClientRect();
    const scale = SIZE.width / rect.width;
    return {
      x: (clientX - rect.left) * scale,
      y: (clientY - rect.top) * (SIZE.height / rect.height),
      slop: (pointerType === "touch" ? TOUCH_SLOP_PX : POINTER_SLOP_PX) * scale,
      pointerType,
    };
  };
  const begin = (handle, point, event) => {
    drag = { handle, id: event.pointerId };
    target.setPointerCapture(event.pointerId);
    target.classList.add("is-dragging");
    target.style.cursor = "grabbing";
    start?.(handle, point, event);
  };
  const onDown = (event) => {
    if (drag || pending || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    const point = local(event.clientX, event.clientY, event.pointerType);
    const handle = hit(point);
    if (!handle) return;
    if (event.pointerType === "touch" && handle.axis === "x") {
      pending = { handle, id: event.pointerId, point, x: event.clientX, y: event.clientY };
      return;
    }
    event.preventDefault(); // no text selection or native image drag
    begin(handle, point, event);
  };
  const onMove = (event) => {
    if (pending) {
      if (event.pointerId !== pending.id) return;
      const dx = Math.abs(event.clientX - pending.x);
      const dy = Math.abs(event.clientY - pending.y);
      if (Math.max(dx, dy) < AXIS_LOCK_PX) return;
      const { handle, point } = pending;
      pending = null;
      if (dy > dx) return; // an up or down swipe: the page scrolls
      begin(handle, point, event);
      move(handle, local(event.clientX, event.clientY, event.pointerType), event);
      return;
    }
    if (drag) {
      if (event.pointerId === drag.id) move(drag.handle, local(event.clientX, event.clientY, event.pointerType), event);
      return;
    }
    if (event.pointerType !== "mouse") return;
    const handle = hit(local(event.clientX, event.clientY, "mouse"));
    target.style.cursor = handle ? cursor(handle) : "";
    hover?.(handle ?? null);
  };
  const onUp = (event) => {
    // Capturing a finger's drag on the figure takes the capture from the shape the finger first touched; that
    // shape's lostpointercapture bubbles up here and does not end the drag.
    if (event.type === "lostpointercapture" && event.target !== target) return;
    if (pending && event.pointerId === pending.id) {
      const { handle, point } = pending;
      pending = null;
      if (event.type !== "pointerup") return; // the page took the swipe
      start?.(handle, point, event); // a tap
      end?.(handle, event);
      return;
    }
    if (!drag || event.pointerId !== drag.id) return;
    const { handle } = drag;
    drag = null;
    target.classList.remove("is-dragging");
    target.style.cursor = "";
    end?.(handle, event);
    if (event.pointerType === "mouse" && event.type === "pointerup") onMove(event);
  };
  const onLeave = (event) => {
    if (drag || event.pointerType !== "mouse") return;
    target.style.cursor = "";
    hover?.(null);
  };
  const onTouchStart = (event) => {
    if (event.touches.length !== 1) return; // two fingers: let the browser zoom
    const touch = event.touches[0];
    const handle = drag ? drag.handle : hit(local(touch.clientX, touch.clientY, "touch"));
    if (handle && handle.axis !== "x") event.preventDefault();
  };
  const listeners = [
    ["pointerdown", onDown],
    ["pointermove", onMove],
    ["pointerup", onUp],
    ["pointercancel", onUp],
    ["lostpointercapture", onUp],
    ["pointerleave", onLeave],
  ];
  for (const [type, listener] of listeners) target.addEventListener(type, listener);
  target.addEventListener("touchstart", onTouchStart, { passive: false });
  return {
    destroy() {
      for (const [type, listener] of listeners) target.removeEventListener(type, listener);
      target.removeEventListener("touchstart", onTouchStart);
    },
  };
}

/* ---------- Controls ---------- */

/**
 * A labelled range input with its live value: div.hx-fig-slider holding a <label> (`label` in matplotlib's notation,
 * such as "$o_1$"), an <input type="range"> named `name` for screen readers (plain words) and the value as
 * format(value). onInput(value)
 * runs on every change by the visitor; set(value) moves the slider without calling it (after a drag on the figure,
 * or on reset) and keeps the exact value even when the slider rounds to its step. `accent` colors the slider.
 * Returns { element, input, set(value), value }.
 */
export function slider({ label, name, value, min = 0, max = 1, step = 0.01, format = (number) => number.toFixed(2), onInput, accent }) {
  const id = uid("hx-fig-slider");
  const input = el("input", { attrs: { type: "range", id, min, max, step, "aria-label": name } });
  const shown = el("span", { className: "hx-fig-value", attrs: { "aria-hidden": "true" } });
  const caption = el("label", { attrs: { for: id } }, [htmlLabel(label)]);
  const element = el("div", { className: "hx-fig-slider" }, [caption, input, shown]);
  if (accent) element.style.setProperty("--hx-fig-accent", rgb(accent));
  let current = value;
  const display = (number) => {
    current = number;
    shown.textContent = format(number);
    input.setAttribute("aria-valuetext", format(number));
    const share = (Math.min(Math.max(number, min), max) - min) / (max - min);
    input.style.setProperty("--hx-fig-share", share.toFixed(4));
  };
  input.addEventListener("input", () => {
    display(Number(input.value));
    onInput?.(current);
  });
  const control = {
    element,
    input,
    set(number) {
      input.value = String(number);
      display(number);
    },
    get value() {
      return current;
    },
  };
  control.set(value);
  return control;
}

/**
 * A group of controls under a legend (a <fieldset>): legend in matplotlib's notation ("Hexel 1", "Sharpness
 * $\\beta$"); swatch an optional color dot before it; aside an optional element at the legend's right end, such
 * as a live value; wide makes the group span the whole row of the controls grid.
 */
export function group({ legend, swatch = null, aside = null, wide = false }, children = []) {
  const caption = el("legend", { className: "hx-fig-legend" });
  if (swatch) caption.append(el("span", { className: "hx-fig-swatch", attrs: { style: `background:${rgb(swatch)}` } }));
  caption.append(htmlLabel(legend));
  if (aside) caption.append(aside);
  return el("fieldset", { className: wide ? "hx-fig-group is-wide" : "hx-fig-group" }, [caption, ...children]);
}

/** A readout line under the controls (it spans the whole controls grid); set its content with replaceChildren. */
export function readout() {
  return el("p", { className: "hx-fig-readout" });
}

/* ---------- Figures: the switch, lazy widgets and the video hand-off ---------- */

let storageNoted = false; // blocked storage (a private window, a sandbox) is noted once per page

function storageUnavailable(error) {
  if (!storageNoted) console.info(`Figure choices are not remembered: ${error.message}`);
  storageNoted = true;
}

function storedMode(name) {
  try {
    const value = window.sessionStorage.getItem(STORAGE_PREFIX + name);
    return MODES.some(({ mode }) => mode === value) ? value : null;
  } catch (error) {
    storageUnavailable(error);
    return null;
  }
}

function storeMode(name, mode) {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + name, mode);
  } catch (error) {
    storageUnavailable(error);
  }
}

let triedThisPage = false; // also holds when storage is blocked

function triedInteractive() {
  if (triedThisPage) return true;
  try {
    return window.sessionStorage.getItem(TRIED_KEY) === "1";
  } catch (error) {
    storageUnavailable(error);
    return false;
  }
}

/** Whether this session already played a cue (PULSED_KEY or NUDGED_KEY) for the figure `name`. */
function cuePlayed(key, name) {
  try {
    return (window.sessionStorage.getItem(key) ?? "").split(" ").includes(name);
  } catch (error) {
    storageUnavailable(error);
    return false;
  }
}

/** Remember for the session that the cue under `key` has played for the figure `name`. */
function markCuePlayed(key, name) {
  try {
    const names = new Set((window.sessionStorage.getItem(key) ?? "").split(" ").filter(Boolean));
    names.add(name);
    window.sessionStorage.setItem(key, [...names].join(" "));
  } catch (error) {
    storageUnavailable(error);
  }
}

/** The visitor has found the interactive figures: remember it and retire every cue on the page. */
function markTried() {
  triedThisPage = true;
  try {
    window.sessionStorage.setItem(TRIED_KEY, "1");
  } catch (error) {
    storageUnavailable(error);
  }
  for (const figure of figures) figure.retireCue();
}

/** The figure name of a panel: its data-widget attribute or the stem of its video's data-src. */
function figureName(media) {
  if (media.dataset.widget) return media.dataset.widget;
  const source = media.querySelector("video")?.dataset.src ?? "";
  return source.split("/").pop().replace(/\.[^.]*$/, "");
}

/** One panel's figure: its switch, its widget once loaded, and which of the two it shows. */
class Figure {
  constructor(media, onMode) {
    this.media = media;
    this.host = media.parentElement;
    this.row = media.closest(".hx-anim") ?? media;
    this.name = figureName(media);
    this.onMode = onMode;
    this.mode = storedMode(this.name) ?? "animation";
    this.loading = null; // promise of the widget module
    this.widget = null; // { container, api }
    this.failed = false;
    const heading = this.row.querySelector("h3")?.textContent.trim();
    const item = media.closest(".hx-anim-item")?.querySelector(".hx-anim-label")?.textContent.trim();
    this.title = [heading, item].filter(Boolean).join(", ") || this.name;
  }

  start() {
    this.buttons = new Map();
    const options = MODES.map(({ mode, label, icon: glyph }) => {
      const button = el("button", { attrs: { type: "button", "data-mode": mode } }, [icon(glyph), el("span", { text: label })]);
      button.addEventListener("click", () => this.choose(mode));
      this.buttons.set(mode, button);
      return button;
    });
    const choice = el("div", { className: "hx-fig-switch", attrs: { role: "group", "aria-label": `Show “${this.title}” as` } }, options);
    const interactive = this.buttons.get("interactive");
    interactive.title = "Explore this figure yourself";
    this.cue = el("span", { className: "hx-fig-cue", attrs: { "aria-hidden": "true" } });
    interactive.append(this.cue);
    this.nudge = el("span", { className: "hx-fig-nudge", attrs: { "aria-hidden": "true" } }, [icon("hand-pointer"), el("span", { text: "Try it yourself" })]);
    // A shortcut for the pointer; keyboards and screen readers use the switch, so the note stays out of their way.
    this.nudge.addEventListener("click", () => this.choose("interactive"));
    this.bar = el("div", { className: "hx-fig-bar" }, [this.nudge, choice]);
    this.media.before(this.bar);
    this.host.classList.add("hx-fig-host");
    this.show(this.mode);
    whenNear(this.row, () => this.load());
    figures.add(this);
    if (triedInteractive()) this.retireCue();
    else this.watchForCue();
  }

  /**
   * While the figure shows its animation: pulse the dot on "Interactive" the first time the figure is well in view,
   * and show the "Try it yourself" note once the animation has played for NUDGE_AFTER_MS; each once per session.
   */
  watchForCue() {
    if (!cuePlayed(PULSED_KEY, this.name)) {
      this.cueObserver = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        this.cueObserver.disconnect();
        if (this.mode !== "animation" || reducedMotion.matches) return;
        this.cue.classList.add("is-pulsing");
        markCuePlayed(PULSED_KEY, this.name);
      }, { threshold: 0.6 });
      this.cueObserver.observe(this.media);
    }
    const video = this.media.querySelector("video");
    if (!video || cuePlayed(NUDGED_KEY, this.name)) return;
    let timer = 0;
    this.onPlaying = () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.showNudge(), NUDGE_AFTER_MS);
    };
    this.onPause = () => clearTimeout(timer);
    this.clearNudgeTimer = () => clearTimeout(timer);
    video.addEventListener("playing", this.onPlaying);
    video.addEventListener("pause", this.onPause);
  }

  showNudge() {
    if (this.nudged || this.mode !== "animation" || triedInteractive()) return;
    this.nudged = true;
    markCuePlayed(NUDGED_KEY, this.name);
    this.nudge.classList.add("is-shown");
    setTimeout(() => this.nudge.classList.remove("is-shown"), NUDGE_SHOW_MS);
  }

  /** Stop every cue on this figure: the visitor knows about the interactive figures. */
  retireCue() {
    this.host.classList.add("hx-fig-tried");
    this.cue.classList.remove("is-pulsing");
    this.nudge.classList.remove("is-shown");
    this.cueObserver?.disconnect();
    this.clearNudgeTimer?.();
    const video = this.media.querySelector("video");
    if (video && this.onPlaying) {
      video.removeEventListener("playing", this.onPlaying);
      video.removeEventListener("pause", this.onPause);
    }
  }

  /** A visitor's choice, remembered for the session; the figure is on screen, so its widget loads now if need be. */
  choose(mode) {
    if (this.failed || mode === this.mode) return;
    storeMode(this.name, mode);
    this.show(mode);
    if (mode === "interactive") {
      markTried();
      this.load();
    }
  }

  show(mode) {
    this.mode = mode;
    this.host.dataset.figMode = mode;
    for (const [option, button] of this.buttons) button.setAttribute("aria-pressed", String(option === mode));
    this.onMode(mode);
  }

  /**
   * Import the widget module once (when the row comes near the viewport, or on a visitor's choice); mount it as soon
   * as it is loaded and the figure is interactive.
   */
  async load() {
    try {
      this.loading ??= import(`./${this.name}.js`);
      const module = await this.loading;
      if (this.failed || this.widget || this.mode !== "interactive") return;
      this.mount(module);
    } catch (error) {
      this.fail(error);
    }
  }

  mount(module) {
    if (typeof module.mount !== "function") throw new Error(`${this.name}.js does not export mount()`);
    const stage = el("div", { className: "hx-fig-stage" });
    const hint = el("span", { text: typeof module.hint === "string" ? module.hint : DEFAULT_HINT });
    const reset = el("button", { className: "hx-fig-reset", attrs: { type: "button" } }, [icon("rotate-left"), el("span", { text: "Reset" })]);
    const footer = el("div", { className: "hx-fig-footer" }, [el("p", { className: "hx-fig-hint" }, [icon("hand-pointer"), hint]), reset]);
    const controls = el("div", { className: "hx-fig-controls" });
    const container = el("div", { className: "hx-widget", attrs: { "data-widget": this.name, role: "group", "aria-label": `Interactive figure: ${this.title}` } }, [stage, footer, controls]);
    this.media.after(container);
    try {
      const api = module.mount(container, {
        name: this.name,
        stage,
        controls,
        reducedMotion: reducedMotion.matches,
        setHint: (text) => {
          hint.textContent = text;
        },
      });
      if (typeof api?.reset !== "function" || typeof api?.destroy !== "function") {
        throw new Error(`${this.name}.js mount() must return { reset(), destroy() }`);
      }
      reset.addEventListener("click", () => api.reset());
      this.widget = { container, api };
      this.host.dataset.figReady = "";
    } catch (error) {
      container.remove();
      throw error;
    }
  }

  /** The widget cannot be shown: keep the animation and drop the switch, with one console.info. */
  fail(error) {
    if (this.failed) return;
    this.failed = true;
    console.info(`Interactive figure "${this.name}" unavailable, its animation shows instead: ${error.message}`);
    if (this.widget) {
      this.widget.api.destroy();
      this.widget.container.remove();
      this.widget = null;
    }
    this.retireCue();
    figures.delete(this);
    this.bar.remove();
    this.host.classList.remove("hx-fig-host");
    delete this.host.dataset.figMode;
    delete this.host.dataset.figReady;
    this.onMode("animation");
  }
}

/**
 * Give one animation panel (div.hx-anim-media) its Interactive and Animation switch. onMode(mode) is called with
 * "animation" or "interactive" whenever the panel's mode is set; a figure without a widget module calls
 * onMode("animation") at once and gets no switch.
 */
export function attachFigure(media, { onMode }) {
  const name = figureName(media);
  if (!WIDGETS.has(name)) {
    onMode("animation");
    return;
  }
  new Figure(media, onMode).start();
}
