/**
 * Results explorer for the #explorer-root mount: Hexels against the baselines on each dataset, or
 * on the mean of the three dataset means, as a quality or speed metric (y axis) against a cost
 * (x axis).
 *
 * Button groups pick the dataset, the y metric and the x metric, and a checkbox beside each axis
 * group switches that axis between log and linear scales. A "Compare with" row (on phones under the
 * plot) adds the optional baseline families to the ones that are always shown, the paper's closest
 * comparison: a hidden family leaves the chart, the legend and the table, and the axes fit the points that remain. Up
 * is always better, so the LPIPS axis is inverted, and an arrow marks the better end of each axis.
 * Hexels are hexagons and the baselines circles, each labelled directly where its label fits.
 * Hovering, tapping or focusing a point shows all of that method's numbers in a tooltip placed
 * where it covers least of the point and its label (on phones a shorter one, the y metrics in one
 * row and the x metrics in the next); the arrow keys move between points. Legend entries, grouped
 * by family, highlight methods, and the table lists the selected dataset by family with the best
 * shown value of each column in bold (on phones the plotted columns come first). The choices last
 * for the browser session.
 *
 * Mount: <div id="explorer-root" data-src="static/data/explorer.json">. The data file (version 1)
 * lists datasets (id, label, scenes), families (id, label, description, members, and either
 * "always": true or a boolean default_visible), methods (id, label, color, ours, family),
 * x_metrics and y_metrics (id, label, better, decimals, log_default), values[dataset][method] with
 * every metric plus primitives and scenes, definitions and notes. Families shown at first stay
 * shown; the others get a toggle. Values are shown as the file states them, rounded only for
 * display. An optional ada_scenes count per entry marks FPS, VRAM and training time that were
 * partly measured on other hardware with a dagger; a dataset without scenes (the mean of the
 * three) is described as an average of the others.
 */

import { loadJSON } from "./media.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const DATA_VERSION = 1;
const SHORT_LABELS = {
  psnr: "PSNR",
  ssim: "SSIM",
  lpips: "LPIPS",
  fps: "FPS",
  memory_mb: "Model memory",
  vram_gib: "Peak VRAM",
  train_min: "Training time",
};
const UNITS = { psnr: "dB", memory_mb: "MB", vram_gib: "GiB", train_min: "min" };
const TYPE = {
  regular: { tick: 12, label: 12.5, title: 13 },
  compact: { tick: 11, label: 11.5, title: 12 },
};
const COMPACT_WIDTH = 560;
const MOVE_MS = 600;
const FADE_MS = 300;
const MARKER_RADIUS = { ours: 9.5, baseline: 6 };
const HIT_RADIUS = 24;
const TIP_INSET = 4;
const LABEL_GAPS = [5, 18, 32];
const LABEL_DIRECTIONS = [[1, 0], [-1, 0], [0, -1], [0, 1], [1, -1], [-1, -1], [1, 1], [-1, 1]];
const ARROWS = {
  up: "M0 5V-5M-3.5-1.5L0-5L3.5-1.5",
  left: "M5 0H-5M-1.5-3.5L-5 0L-1.5 3.5",
  right: "M-5 0H5M1.5-3.5L5 0L1.5 3.5",
};
/* Scenes whose FPS, VRAM and training time come from other hardware (optional field); they get a dagger. */
const HARDWARE_FIELD = "ada_scenes";
const HARDWARE_METRICS = new Set(["fps", "vram_gib", "train_min"]);
const DAGGER = "†";
const MISSING = "n/a";
const LOG_LABEL = "Log scale";
const LEGEND_HINT = "Select a method to highlight it; hover or tap a point for its numbers.";
const ERROR_TEXT = "The results explorer could not be loaded.";
// The explorer opens on this dataset when the data file lists it, else on the first one; a choice made
// earlier in the session wins. The key changed with this opening, so choices saved before do not hold it back.
const OPENING_DATASET = "tanks_and_temples";
const STORE_KEY = "hexels-explorer-2";
// Longest wait for the web fonts before the chart is drawn.
const FONT_WAIT_MS = 1500;
// Phones (explorer.css): the plot comes right under the axis choices and the "Compare with" row moves below it.
const PHONE_QUERY = "(max-width: 600px)";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const measureContext = document.createElement("canvas").getContext("2d");
const numberFormats = new Map();
const countFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/* ---------- DOM and text helpers ---------- */

/** Create an HTML element with a class name and, optionally, its text. */
function html(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Create an SVG element with attributes, appended to `parent` when one is given. */
function svgNode(tag, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, tag);
  setAttributes(node, attrs);
  if (parent) parent.append(node);
  return node;
}

/** Set several attributes at once. */
function setAttributes(node, attrs) {
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
}

/** Create an SVG text element. */
function svgText(parent, className, text, attrs) {
  const node = svgNode("text", { class: className, ...attrs }, parent);
  node.textContent = text;
  return node;
}

/** Width in pixels of `text` set in the CSS `font`. */
function textWidth(text, font) {
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

/** Format `value` with fixed decimals and thousands separators. */
function formatNumber(value, decimals) {
  if (!numberFormats.has(decimals)) {
    numberFormats.set(
      decimals,
      new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
    );
  }
  return numberFormats.get(decimals).format(value);
}

/** A metric value with its unit, or "n/a" when it is missing. */
function formatValue(metric, value) {
  if (value === null) return MISSING;
  const text = formatNumber(value, metric.decimals);
  return metric.unit ? `${text} ${metric.unit}` : text;
}

/** Path data of a marker centred on the origin: a flat-topped hexagon for Hexels, a circle otherwise. */
function markerPath(ours, radius) {
  if (!ours) return `M${-radius} 0A${radius} ${radius} 0 1 0 ${radius} 0A${radius} ${radius} 0 1 0 ${-radius} 0Z`;
  const corners = Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 3) * index;
    return `${(radius * Math.cos(angle)).toFixed(2)} ${(radius * Math.sin(angle)).toFixed(2)}`;
  });
  return `M${corners.join("L")}Z`;
}

/** Small inline SVG of a method's marker, for the legend, the tooltip and the table. */
function swatch(method) {
  const icon = svgNode("svg", {
    class: "ex-swatch",
    viewBox: "-7 -7 14 14",
    width: 14,
    height: 14,
    "aria-hidden": "true",
    focusable: "false",
  });
  svgNode("path", { d: markerPath(method.ours, method.ours ? 6.6 : 4.6), fill: method.color }, icon);
  return icon;
}

/** Check box drawn in SVG for the "Compare with" row; CSS fills it when the family is shown. */
function checkIcon() {
  const icon = svgNode("svg", {
    class: "ex-family-check",
    viewBox: "0 0 16 16",
    width: 16,
    height: 16,
    "aria-hidden": "true",
    focusable: "false",
  });
  svgNode("rect", { class: "ex-family-box", x: 1, y: 1, width: 14, height: 14, rx: 3.5 }, icon);
  svgNode("path", { class: "ex-family-tick", d: "M4.6 8.3l2.3 2.3 4.6-4.8" }, icon);
  return icon;
}

/** Join items as prose: "a, b and c". */
function listText(items) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** `text` with a capitalised first word in lower case, for use inside a sentence. */
function inSentence(text) {
  return /^[A-Z][a-z]/.test(text) ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
}

/** A paragraph that opens with `term` in bold. */
function termLine(term, text) {
  const line = html("p");
  line.append(html("strong", "", `${term}:`), ` ${text}`);
  return line;
}

/* ---------- Session storage ---------- */

/** The choices saved earlier in this browser session, or null; storage can be blocked or broken. */
function loadChoices() {
  try {
    return JSON.parse(sessionStorage.getItem(STORE_KEY));
  } catch (error) {
    console.info(`Explorer choices not restored: ${error.message}`);
    return null;
  }
}

/** Save the choices for this browser session, when storage is available. */
function saveChoices(choices) {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(choices));
  } catch (error) {
    console.info(`Explorer choices not saved: ${error.message}`);
  }
}

/* ---------- Data file ---------- */

/** Throw an error that names the data file. */
function fail(source, message) {
  throw new Error(`${source}: ${message}`);
}

/** Check one metric entry and add the display fields the explorer needs. */
function parseMetric(metric, where, source) {
  if (typeof metric?.id !== "string" || typeof metric.label !== "string") {
    fail(source, `${where}: id and label must be strings`);
  }
  if (metric.better !== "higher" && metric.better !== "lower") {
    fail(source, `${where}: better must be "higher" or "lower"`);
  }
  if (!Number.isInteger(metric.decimals) || typeof metric.log_default !== "boolean") {
    fail(source, `${where}: decimals must be an integer and log_default a boolean`);
  }
  const [, name = metric.label, qualifier = ""] = /^(.*?)\s*\(([^()]*)\)$/.exec(metric.label) ?? [];
  const short = SHORT_LABELS[metric.id] ?? name;
  return {
    id: metric.id,
    label: metric.label,
    better: metric.better,
    logDefault: metric.log_default,
    short,
    noun: inSentence(short),
    qualifier: qualifier === short ? "" : qualifier,
    unit: UNITS[metric.id] ?? "",
    decimals: metric.decimals,
  };
}

/**
 * Check the families and resolve their members. Every method belongs to exactly one family, which
 * its own family field names; a family holds only Hexels, which are always shown, or only
 * baselines. A family that is not visible at first becomes optional.
 */
function parseFamilies(families, methods, source) {
  if (!Array.isArray(families) || families.length === 0) fail(source, "families must be a non-empty array");
  const byId = new Map(methods.map((method) => [method.id, method]));
  const parsed = families.map((family, index) => {
    const where = `families[${index}]`;
    if (![family?.id, family?.label, family?.description].every((text) => typeof text === "string")) {
      fail(source, `${where}: id, label and description must be strings`);
    }
    const always = family.always === true;
    if (!always && typeof family.default_visible !== "boolean") {
      fail(source, `${where}: needs "always": true or a boolean default_visible`);
    }
    if (!Array.isArray(family.members) || family.members.length === 0) {
      fail(source, `${where}: members must be a non-empty array`);
    }
    const members = family.members.map((id) => byId.get(id) ?? fail(source, `${where}: unknown member ${id}`));
    const stray = members.find((method) => method.family !== family.id);
    if (stray) fail(source, `${where}: ${stray.id} names family ${stray.family}`);
    const ours = members.every((method) => method.ours);
    if (!ours && members.some((method) => method.ours)) fail(source, `${where}: mixes Hexels and baselines`);
    if (ours && !always) fail(source, `${where}: Hexels must always be shown`);
    const optional = !always && !family.default_visible;
    return { id: family.id, label: family.label, description: family.description, ours, optional, members };
  });
  if (new Set(parsed.map((family) => family.id)).size !== parsed.length) fail(source, "family ids must be unique");
  const listed = parsed.flatMap((family) => family.members);
  if (listed.length !== methods.length || new Set(listed).size !== methods.length) {
    fail(source, "every method must be a member of exactly one family");
  }
  return parsed;
}

/** Check that every value is a number or null, and that metric values are positive for log scales. */
function checkValues(values, datasets, methods, metrics, source) {
  const known = new Set(methods.map((method) => method.id));
  const fields = [...metrics.map((metric) => metric.id), "primitives", "scenes", HARDWARE_FIELD];
  for (const dataset of datasets) {
    for (const [methodId, row] of Object.entries(values[dataset.id])) {
      const where = `values.${dataset.id}.${methodId}`;
      if (!known.has(methodId)) fail(source, `${where}: unknown method`);
      for (const field of fields) {
        const value = row[field];
        if (value !== undefined && value !== null && !Number.isFinite(value)) {
          fail(source, `${where}.${field} must be a number or null`);
        }
      }
      for (const metric of metrics) {
        if (typeof row[metric.id] === "number" && row[metric.id] <= 0) {
          fail(source, `${where}.${metric.id} must be positive`);
        }
      }
    }
  }
}

/** Return the explorer's view of the data file after checking every field it reads. */
function parseData(data, source) {
  if (data?.version !== DATA_VERSION) fail(source, `expected "version": ${DATA_VERSION}`);
  for (const key of ["datasets", "methods", "x_metrics", "y_metrics"]) {
    if (!Array.isArray(data[key]) || data[key].length === 0) fail(source, `${key} must be a non-empty array`);
  }
  const datasets = data.datasets.map((dataset, index) => {
    if (typeof dataset?.id !== "string" || typeof dataset.label !== "string") {
      fail(source, `datasets[${index}]: id and label must be strings`);
    }
    if (dataset.scenes !== undefined && !Number.isInteger(dataset.scenes)) {
      fail(source, `datasets[${index}]: scenes must be an integer`);
    }
    if (typeof data.values?.[dataset.id] !== "object" || data.values[dataset.id] === null) {
      fail(source, `values.${dataset.id} is missing`);
    }
    return { id: dataset.id, label: dataset.label, scenes: dataset.scenes ?? null };
  });
  const methods = data.methods.map((method, index) => {
    if (typeof method?.id !== "string" || typeof method.label !== "string" || typeof method.family !== "string") {
      fail(source, `methods[${index}]: id, label and family must be strings`);
    }
    if (!/^#[0-9a-f]{6}$/i.test(method.color ?? "")) fail(source, `methods[${index}]: color must be #rrggbb`);
    const { id, label, color, family } = method;
    return { id, label, color, ours: method.ours === true, family };
  });
  const families = parseFamilies(data.families, methods, source);
  const xMetrics = data.x_metrics.map((metric, index) => parseMetric(metric, `x_metrics[${index}]`, source));
  const yMetrics = data.y_metrics.map((metric, index) => parseMetric(metric, `y_metrics[${index}]`, source));
  checkValues(data.values, datasets, methods, [...yMetrics, ...xMetrics], source);
  const definitions = new Map(Object.entries(data.definitions ?? {}));
  const notes = data.notes ?? [];
  if (![...definitions.values(), ...notes].every((text) => typeof text === "string")) {
    fail(source, "definitions and notes must be strings");
  }
  return { datasets, families, methods, xMetrics, yMetrics, values: data.values, definitions, notes };
}

/* ---------- Scales ---------- */

/** Smallest 1-2-5 step that splits `span` into at most `count` intervals. */
function tickStep(span, count) {
  const raw = span / Math.max(count, 1);
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((factor) => factor * power).find((step) => step >= raw * (1 - 1e-9));
}

/** Decimals needed to print `value` when it is a 1-2-5 step or a multiple of one. */
function stepDecimals(value) {
  return Math.max(0, -Math.floor(Math.log10(value) + 1e-9));
}

/** Ticks at the multiples of a 1-2-5 step inside [lo, hi]. */
function linearTicks(lo, hi, count) {
  const step = tickStep(hi - lo, count);
  const decimals = stepDecimals(step);
  const ticks = [];
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + step * 1e-9; k += 1) {
    const value = k * step + 0;
    ticks.push({ value, text: formatNumber(value, decimals) });
  }
  return ticks;
}

/** Values m * 10^e inside [lo, hi] for every mantissa m. */
function decadeValues(lo, hi, mantissas) {
  const values = [];
  for (let exponent = Math.floor(Math.log10(lo)); exponent <= Math.ceil(Math.log10(hi)); exponent += 1) {
    for (const mantissa of mantissas) {
      const value = Number((mantissa * 10 ** exponent).toPrecision(6));
      if (value >= lo && value <= hi) values.push(value);
    }
  }
  return values;
}

/** Log-axis ticks on [lo, hi]: 1-2-5 per decade, thinned to at most `count`; a linear step for short spans. */
function logTicks(lo, hi, count) {
  const fine = decadeValues(lo, hi, [1, 2, 5]);
  if (fine.length < 3) return linearTicks(lo, hi, count);
  const powers = decadeValues(lo, hi, [1]);
  const values = [fine, decadeValues(lo, hi, [1, 3]), powers].find((candidate) => candidate.length <= count) ??
    powers.filter((_, index) => index % Math.ceil(powers.length / count) === 0);
  return values.map((value) => ({ value, text: formatNumber(value, stepDecimals(value)) }));
}

/** Map `values` onto [start, end] pixels, linear or log10, with padding and ticks; small values land at `start`. */
function makeScale(values, { log, zero, start, end, count }) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (log) {
    const lo = Math.log10(min);
    const hi = Math.log10(max);
    const pad = Math.max((hi - lo) * 0.08, 0.06);
    const [d0, d1] = [lo - pad, hi + pad];
    return {
      map: (value) => start + ((Math.log10(value) - d0) / (d1 - d0)) * (end - start),
      ticks: logTicks(10 ** d0, 10 ** d1, count),
    };
  }
  const span = max - min || Math.abs(max) * 0.1 || 1;
  const d0 = zero ? 0 : min - span * 0.1;
  const d1 = max + span * 0.1;
  return { map: (value) => start + ((value - d0) / (d1 - d0)) * (end - start), ticks: linearTicks(d0, d1, count) };
}

/** Chart height for a width: about 16:9 on wide screens, taller on phones. */
function chartHeight(width) {
  if (width >= 760) return Math.round(Math.min((width * 9) / 16, 600));
  if (width >= COMPACT_WIDTH) return Math.round(width * 0.7);
  return Math.round(Math.min(Math.max(width * 1.1, 320), 520));
}

/** Half-pixel offset so 1px lines fall on the pixel grid. */
function crisp(value) {
  return Math.round(value) + 0.5;
}

/* ---------- Direct labels ---------- */

/** Box with its edges and size. */
function rect(left, top, width, height) {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

/** True when two boxes overlap. */
function overlaps(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** Area that two boxes share. */
function overlapArea(a, b) {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return Math.max(width, 0) * Math.max(height, 0);
}

/** True when `box` lies within `bounds`. */
function inside(box, bounds) {
  return box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom;
}

/** Segment from the marker's edge to the nearest point of the label box. */
function leaderLine(point, box) {
  const x = Math.min(Math.max(point.x, box.left), box.right);
  const y = Math.min(Math.max(point.y, box.top), box.bottom);
  const start = (point.r + 2) / Math.hypot(x - point.x, y - point.y);
  return { x1: point.x + (x - point.x) * start, y1: point.y + (y - point.y) * start, x2: x, y2: y };
}

/** True when the segment passes through one of the boxes, sampled at a few points along it. */
function crosses(line, boxes) {
  for (let step = 1; step < 8; step += 1) {
    const x = line.x1 + ((line.x2 - line.x1) * step) / 8;
    const y = line.y1 + ((line.y2 - line.y1) * step) / 8;
    if (boxes.some((box) => x > box.left && x < box.right && y > box.top && y < box.bottom)) return true;
  }
  return false;
}

/** Label boxes around a point: beside the marker first, then further out with a leader line. */
function labelCandidates(point, lineHeight) {
  return LABEL_GAPS.flatMap((gap, ring) =>
    LABEL_DIRECTIONS.map(([dx, dy]) => {
      const reach = (point.r + gap) * (dx !== 0 && dy !== 0 ? 0.8 : 1);
      const x = point.x + dx * reach;
      const y = point.y + dy * reach;
      const left = dx > 0 ? x : dx < 0 ? x - point.labelWidth : x - point.labelWidth / 2;
      const top = dy > 0 ? y : dy < 0 ? y - lineHeight : y - lineHeight / 2;
      const box = rect(left, top, point.labelWidth, lineHeight);
      return { box, leader: ring === 0 ? null : leaderLine(point, box) };
    }),
  );
}

/**
 * Place direct labels greedily, Hexels first, where they overlap no marker, no other label and
 * no plot edge. A label that fits nowhere is left out; the legend, tooltip and table still name
 * the method.
 */
function placeLabels(points, frame) {
  const { plot, width, type } = frame;
  const bounds = { left: plot.left + 2, top: plot.top, right: width - 2, bottom: plot.bottom - 2 };
  const lineHeight = Math.ceil(type.label * 1.3);
  const markers = points.map((point) => ({
    id: point.method.id,
    box: rect(point.x - point.r - 2, point.y - point.r - 2, 2 * point.r + 4, 2 * point.r + 4),
  }));
  const taken = [];
  const placements = new Map();
  for (const point of [...points].sort((a, b) => Number(b.method.ours) - Number(a.method.ours))) {
    const blockers = [...taken, ...markers.filter(({ id }) => id !== point.method.id).map(({ box }) => box)];
    const free = ({ box, leader }) =>
      inside(box, bounds) && !blockers.some((other) => overlaps(box, other)) && !(leader && crosses(leader, blockers));
    const placement = labelCandidates(point, lineHeight).find(free);
    if (placement) {
      taken.push(placement.box);
      placements.set(point.method.id, { ...placement, text: point.labelText });
    }
  }
  return placements;
}

/* ---------- The explorer ---------- */

class Explorer {
  constructor(root, data) {
    this.root = root;
    this.data = data;
    this.metrics = [...data.yMetrics, ...data.xMetrics];
    this.hardwareNames = listText(this.metrics.filter(({ id }) => HARDWARE_METRICS.has(id)).map(({ noun }) => noun));
    const opening = data.datasets.find((dataset) => dataset.id === OPENING_DATASET) ?? data.datasets[0];
    this.state = { dataset: opening.id, y: data.yMetrics[0].id, x: data.xMetrics[0].id };
    this.logScale = Object.fromEntries(this.metrics.map((metric) => [metric.id, metric.logDefault]));
    this.families = new Map(data.families.map((family) => [family.id, family]));
    this.shown = new Set();
    this.restore(loadChoices());
    this.pinned = new Set();
    this.hover = null;
    this.focused = null;
    this.tipHidden = false;
    this.moving = false;
    this.current = null;
    this.width = 0;
    this.labelTimer = 0;
    this.placements = new Map();
    this.nodes = new Map(data.methods.map((method) => [method.id, { method, cells: new Map() }]));
    this.familyNodes = new Map(data.families.map((family) => [family.id, {}]));
    this.controls = { dataset: [], y: [], x: [] };
    this.logInputs = {};
    this.fontFamily = getComputedStyle(root).fontFamily;
    this.build();
    new ResizeObserver(() => this.onResize()).observe(this.plot);
  }

  /* Choices ---------------------------------------------------------------------------------- */

  /** Take over the saved choices that still name a dataset, metric or family of the data file. */
  restore(saved) {
    const known = (items, id) => items.some((item) => item.id === id);
    if (known(this.data.datasets, saved?.dataset)) this.state.dataset = saved.dataset;
    if (known(this.data.yMetrics, saved?.y)) this.state.y = saved.y;
    if (known(this.data.xMetrics, saved?.x)) this.state.x = saved.x;
    for (const id of Object.keys(this.logScale)) {
      if (typeof saved?.log?.[id] === "boolean") this.logScale[id] = saved.log[id];
    }
    if (!Array.isArray(saved?.families)) return;
    for (const id of saved.families) if (this.families.get(id)?.optional) this.shown.add(id);
  }

  save() {
    saveChoices({ ...this.state, log: this.logScale, families: [...this.shown] });
  }

  /* Data access ------------------------------------------------------------------------------ */

  /** The metric objects, their scales and the dataset of the current selection. */
  view() {
    const { dataset, x, y } = this.state;
    return {
      dataset: this.data.datasets.find((item) => item.id === dataset),
      x: this.data.xMetrics.find((metric) => metric.id === x),
      y: this.data.yMetrics.find((metric) => metric.id === y),
      xLog: this.logScale[x],
      yLog: this.logScale[y],
    };
  }

  /** True when a family is on the chart: always for fixed families, after its toggle for optional ones. */
  familyShown(family) {
    return !family.optional || this.shown.has(family.id);
  }

  /** The methods of the shown families, in the data file's order. */
  visibleMethods() {
    return this.data.methods.filter((method) => this.familyShown(this.families.get(method.family)));
  }

  /** One method's entry on a dataset, or null when the dataset has none. */
  entry(datasetId, methodId) {
    return this.data.values[datasetId][methodId] ?? null;
  }

  /** A metric value of a method on the current dataset, or null when it is missing. */
  value(methodId, metricId) {
    const value = this.entry(this.state.dataset, methodId)?.[metricId];
    return typeof value === "number" ? value : null;
  }

  /** Scenes behind a method's value of `metricId` that ran on other hardware; 0 for hardware-free metrics. */
  hardwareScenes(methodId, metricId) {
    return HARDWARE_METRICS.has(metricId) ? this.value(methodId, HARDWARE_FIELD) ?? 0 : 0;
  }

  /** "9 scenes", or "8 of 9 scenes" when a method misses some of the dataset's scenes. */
  sceneText(methodId) {
    const scenes = this.value(methodId, "scenes");
    if (scenes === null) return "";
    const total = this.view().dataset.scenes;
    return total !== null && scenes < total ? `${scenes} of ${total} scenes` : `${scenes} scenes`;
  }

  /** "9 of 9 scenes" for the scenes whose FPS, VRAM and training time ran on other hardware, or "". */
  hardwareText(methodId) {
    const count = this.value(methodId, HARDWARE_FIELD) ?? 0;
    const scenes = this.value(methodId, "scenes");
    if (!count) return "";
    return scenes === null ? `${count} scenes` : `${count} of ${scenes} scenes`;
  }

  /** CSS font shorthand in the chart's family. */
  font(size, weight = 400) {
    return `${weight} ${size}px ${this.fontFamily}`;
  }

  /* Building --------------------------------------------------------------------------------- */

  build() {
    this.content = html("div", "ex is-static");
    this.content.style.setProperty("--ex-move", `${MOVE_MS}ms`);
    this.content.style.setProperty("--ex-fade", `${FADE_MS}ms`);
    const columns = Math.max(this.data.yMetrics.length, this.data.xMetrics.length);
    this.content.style.setProperty("--ex-tip-columns", String(columns));
    this.status = html("p", "is-sr-only");
    this.status.setAttribute("role", "status");
    const families = this.buildFamilies();
    const body = this.buildBody();
    this.content.append(this.buildControls(), families, body, this.buildTable(), this.buildNotes(), this.status);
    // On phones the "Compare with" row follows the plot and its legend, so the plot starts on the first screen. The
    // move is in the DOM: a grid reorder of the content would widen it to the table's width.
    const phone = window.matchMedia(PHONE_QUERY);
    const place = () => (phone.matches ? body.after(families) : body.before(families));
    phone.addEventListener("change", place);
    place();
    this.root.replaceChildren(this.content);
  }

  buildControls() {
    const controls = html("div", "ex-controls");
    const datasets = this.data.datasets.map(({ id, label }) => ({ id, label }));
    const yMetrics = this.data.yMetrics.map(({ id, short }) => ({ id, label: short }));
    const xMetrics = this.data.xMetrics.map(({ id, short }) => ({ id, label: short }));
    controls.append(
      this.buildGroup("Dataset", "dataset", datasets),
      this.buildGroup("Y axis", "y", yMetrics, this.buildLogToggle("y")),
      this.buildGroup("X axis", "x", xMetrics, this.buildLogToggle("x")),
    );
    return controls;
  }

  /** A labelled group of toggle buttons that sets state[key]. */
  buildGroup(title, key, options, extra) {
    const group = html("div", "ex-control");
    const label = html("span", "ex-control-label", title);
    label.id = `explorer-${key}-label`;
    group.setAttribute("role", "group");
    group.setAttribute("aria-labelledby", label.id);
    const buttons = html("div", "ex-segmented");
    buttons.dataset.count = String(options.length);
    buttons.style.setProperty("--ex-count", String(options.length));
    for (const option of options) {
      const button = html("button", "", option.label);
      button.type = "button";
      button.dataset.value = option.id;
      button.addEventListener("click", () => this.select(key, option.id));
      buttons.append(button);
      this.controls[key].push(button);
    }
    group.append(label, buttons);
    if (extra) group.append(extra);
    return group;
  }

  /** Log-scale checkbox of the y or x axis, shown as "Log"; each metric keeps its own setting. */
  buildLogToggle(axis) {
    const label = html("label", "ex-check");
    label.title = LOG_LABEL;
    const input = html("input");
    input.type = "checkbox";
    input.setAttribute("aria-label", LOG_LABEL);
    input.addEventListener("change", () => {
      this.logScale[this.state[axis]] = input.checked;
      this.save();
      this.render(true);
    });
    this.logInputs[axis] = input;
    label.append(input, html("span", "", "Log"));
    return label;
  }

  /**
   * The "Compare with" row: a fixed chip for each baseline family that is always shown, a toggle
   * button for each optional one, and a note on why the fixed families stay.
   */
  buildFamilies() {
    const group = html("div", "ex-families");
    const label = html("span", "ex-control-label", "Compare with");
    label.id = "explorer-families-label";
    group.setAttribute("role", "group");
    group.setAttribute("aria-labelledby", label.id);
    const list = html("div", "ex-family-list");
    const baselines = this.data.families.filter((family) => !family.ours);
    for (const family of baselines) {
      list.append(family.optional ? this.buildFamilyToggle(family) : this.buildFamilyChip(family));
    }
    group.append(label, list);
    const fixed = listText(baselines.filter((family) => !family.optional).map((family) => family.label));
    const note = `${fixed}, the paper's closest comparison to Hexels, are always shown.`;
    if (fixed) group.append(html("p", "ex-family-note", note));
    return group;
  }

  /** A family's name with its members in small text below; its description shows on hover. */
  familyContent(element, family) {
    const text = html("span", "ex-family-text");
    const members = family.members.map((method) => method.label).join(", ");
    text.append(html("span", "ex-family-name", family.label), html("span", "ex-family-members", members));
    element.title = family.description;
    element.append(checkIcon(), text);
    return element;
  }

  buildFamilyChip(family) {
    return this.familyContent(html("span", "ex-family is-fixed"), family);
  }

  buildFamilyToggle(family) {
    const button = this.familyContent(html("button", "ex-family"), family);
    button.type = "button";
    button.dataset.family = family.id;
    button.addEventListener("click", () => this.toggleFamily(family));
    this.familyNodes.get(family.id).toggle = button;
    return button;
  }

  buildBody() {
    this.svg = svgNode("svg", { class: "ex-svg", role: "group" });
    this.axisLayer = svgNode("g", { class: "ex-axes", "aria-hidden": "true" }, this.svg);
    this.haloLayer = svgNode("g", { class: "ex-halos", "aria-hidden": "true" }, this.svg);
    this.labelLayer = svgNode("g", { class: "ex-labels", "aria-hidden": "true" }, this.svg);
    const leaders = svgNode("g", {}, this.labelLayer);
    const labels = svgNode("g", {}, this.labelLayer);
    this.pointLayer = svgNode("g", { class: "ex-points", role: "list" }, this.svg);
    for (const method of this.data.methods) this.buildLabel(method, leaders, labels);
    for (const method of this.data.methods.filter((item) => !item.ours)) this.buildPoint(method);
    for (const method of this.data.methods.filter((item) => item.ours)) this.buildPoint(method);
    this.tip = html("div", "ex-tip");
    this.tip.hidden = true;
    this.tip.setAttribute("aria-hidden", "true");
    this.empty = html("p", "ex-empty", "No values for this selection.");
    this.empty.hidden = true;
    this.plot = html("div", "ex-plot");
    this.plot.append(this.svg, this.tip, this.empty);
    this.attachChartEvents();
    const body = html("div", "ex-body");
    body.append(this.plot, this.buildLegend());
    return body;
  }

  buildLabel(method, leaders, labels) {
    const node = this.nodes.get(method.id);
    node.leader = svgNode("line", { class: "ex-leader" }, leaders);
    const className = `ex-label${method.ours ? " is-ours" : ""}`;
    node.label = svgNode("text", { class: className, "data-method": method.id }, labels);
  }

  buildPoint(method) {
    const radius = method.ours ? MARKER_RADIUS.ours : MARKER_RADIUS.baseline;
    const point = svgNode(
      "g",
      {
        class: `ex-point is-absent${method.ours ? " is-ours" : ""}`,
        role: "listitem",
        tabindex: "-1",
        "data-method": method.id,
      },
      this.pointLayer,
    );
    if (method.ours) {
      const halo = markerPath(true, radius + 5);
      const attrs = { class: "ex-halo is-absent", d: halo, fill: method.color, "data-method": method.id };
      this.nodes.get(method.id).halo = svgNode("path", attrs, this.haloLayer);
    }
    svgNode("circle", { class: "ex-ring", r: radius + 5 }, point);
    svgNode("path", { class: "ex-mark", d: markerPath(method.ours, radius), fill: method.color }, point);
    point.addEventListener("focus", () => this.setFocused(method.id));
    point.addEventListener("blur", () => this.setFocused(null));
    this.nodes.get(method.id).point = point;
  }

  /** Legend entries grouped by family, under the family's name. */
  buildLegend() {
    const legend = html("div", "ex-legend");
    for (const family of this.data.families) {
      const list = html("ul", "ex-legend-list");
      for (const method of family.members) {
        const item = html("li");
        item.append(this.buildLegendItem(method));
        list.append(item);
      }
      const group = html("div", "ex-legend-group");
      group.dataset.family = family.id;
      group.append(html("p", "ex-legend-title", family.label), list);
      this.familyNodes.get(family.id).legend = group;
      legend.append(group);
    }
    legend.append(html("p", "ex-legend-hint", LEGEND_HINT));
    return legend;
  }

  buildLegendItem(method) {
    const button = html("button", "ex-legend-item");
    button.type = "button";
    button.setAttribute("aria-pressed", "false");
    button.dataset.method = method.id;
    button.style.setProperty("--ex-method", method.color);
    button.append(swatch(method), html("span", "", method.label));
    button.addEventListener("pointerenter", () => this.setHover(method.id));
    button.addEventListener("pointerleave", () => this.setHover(null));
    button.addEventListener("focus", () => this.setHover(method.id));
    button.addEventListener("blur", () => this.setHover(null));
    button.addEventListener("click", () => this.togglePin(method.id));
    this.nodes.get(method.id).legend = button;
    return button;
  }

  /** The table: one body per family, the baseline families under a heading row. */
  buildTable() {
    const block = html("div", "ex-table-block");
    this.tableTitle = html("p", "ex-table-title");
    this.tableTitle.id = "explorer-table-title";
    const table = html("table", "table is-narrow is-hoverable ex-table");
    table.setAttribute("aria-labelledby", this.tableTitle.id);
    this.headRow = html("tr");
    const methodHead = html("th", "", "Method");
    methodHead.scope = "col";
    this.headRow.append(methodHead);
    this.headCells = new Map();
    for (const metric of this.metrics) {
      const cell = this.buildHeadCell(metric);
      this.headCells.set(metric.id, cell);
      this.headRow.append(cell);
    }
    const head = html("thead");
    head.append(this.headRow);
    table.append(head);
    for (const family of this.data.families) {
      const body = html("tbody");
      body.dataset.family = family.id;
      if (!family.ours) body.append(this.buildFamilyRow(family));
      for (const method of family.members) body.append(this.buildRow(method));
      this.familyNodes.get(family.id).body = body;
      table.append(body);
    }
    const scroll = html("div", "ex-table-scroll");
    scroll.append(table);
    // Shown on phones only (index.css), where the table scrolls sideways.
    const hint = html("p", "hx-swipe-hint");
    hint.setAttribute("aria-hidden", "true");
    const glyph = html("i", "fa-solid fa-left-right");
    hint.append(glyph, " Scroll sideways for every column");
    this.tableNotes = html("div", "ex-table-notes");
    block.append(this.tableTitle, scroll, hint, this.tableNotes);
    return block;
  }

  /** Column header: the metric's short name, then its qualifier and better-direction arrow. */
  buildHeadCell(metric) {
    const cell = html("th");
    cell.scope = "col";
    cell.dataset.metric = metric.id;
    const detail = html("span", "ex-th-detail", metric.qualifier ? `${metric.qualifier} ` : "");
    const arrow = html("span", "", metric.better === "higher" ? "↑" : "↓");
    arrow.setAttribute("aria-hidden", "true");
    detail.append(arrow, html("span", "is-sr-only", `, ${metric.better} is better`));
    cell.append(html("span", "ex-th-name", metric.short), detail);
    return cell;
  }

  /** Heading row of a family's table body; its name stays in view while the table scrolls sideways. */
  buildFamilyRow(family) {
    const row = html("tr", "ex-family-row");
    const cell = html("th");
    cell.scope = "rowgroup";
    cell.colSpan = this.metrics.length + 1;
    cell.append(html("span", "", family.label));
    row.append(cell);
    return row;
  }

  buildRow(method) {
    const node = this.nodes.get(method.id);
    const row = html("tr", method.ours ? "is-ours" : "");
    row.dataset.method = method.id;
    row.style.setProperty("--ex-method", method.color);
    const name = html("th");
    name.scope = "row";
    const label = html("span", "ex-method");
    node.mark = html("sup", "ex-partial", "*");
    node.mark.hidden = true;
    label.append(swatch(method), html("span", "", method.label), node.mark);
    name.append(label);
    row.append(name);
    for (const metric of this.metrics) {
      const cell = html("td");
      cell.dataset.metric = metric.id;
      node.cells.set(metric.id, cell);
      row.append(cell);
    }
    row.addEventListener("pointerenter", () => this.setHover(method.id, false));
    row.addEventListener("pointerleave", () => this.setHover(null));
    node.row = row;
    return row;
  }

  /**
   * Footnotes for the plotted metrics (filled per selection), then, folded, the method families,
   * all definitions and the notes.
   */
  buildNotes() {
    const notes = html("div", "ex-notes");
    this.footnotes = html("div", "ex-footnotes");
    const body = html("div", "ex-details-body");
    for (const family of this.data.families) body.append(termLine(family.label, family.description));
    for (const key of this.data.definitions.keys()) body.append(this.definitionLine(key));
    for (const text of this.data.notes) body.append(html("p", "", text));
    const details = html("details", "ex-details");
    details.append(html("summary", "", "All definitions and notes"), body);
    notes.append(this.footnotes, details);
    return notes;
  }

  /** A definition with its term in bold: the text's own "Term:" opening, or a name for its key. */
  definitionLine(key) {
    const text = this.data.definitions.get(key);
    const [, term, body] = /^([^:.]{2,40}):\s+([\s\S]*)$/.exec(text) ?? [null, this.termFor(key), text];
    return termLine(term, body);
  }

  /** Name of a definition key: a dataset or metric label, or the key in words. */
  termFor(key) {
    if (key === HARDWARE_FIELD) return `Other hardware (${DAGGER})`;
    const named = [...this.data.datasets, ...this.metrics].find((item) => item.id === key);
    if (named) return named.label;
    const words = key.replaceAll("_", " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  /* Events ----------------------------------------------------------------------------------- */

  attachChartEvents() {
    this.svg.addEventListener("pointermove", (event) => {
      if (event.pointerType !== "touch") this.setHover(this.nearest(event));
    });
    this.svg.addEventListener("pointerleave", () => this.setHover(null));
    this.svg.addEventListener("click", (event) => {
      this.nodes.get(this.nearest(event))?.point.focus({ preventScroll: true });
    });
    this.pointLayer.addEventListener("keydown", (event) => this.onPointKey(event));
  }

  /** The method whose point is closest to the pointer, within HIT_RADIUS pixels. */
  nearest(event) {
    if (!this.current) return null;
    const box = this.svg.getBoundingClientRect();
    const scale = this.current.frame.width / box.width;
    const x = (event.clientX - box.left) * scale;
    const y = (event.clientY - box.top) * scale;
    let found = null;
    let best = HIT_RADIUS;
    for (const point of this.current.points) {
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance < best) {
        found = point.method.id;
        best = distance;
      }
    }
    return found;
  }

  /** Arrow keys, Home and End move between points; Escape hides the tooltip. */
  onPointKey(event) {
    if (event.key === "Escape") {
      this.tipHidden = true;
      this.refresh();
      return;
    }
    const target = this.keyTarget(event.key);
    if (!target) return;
    event.preventDefault();
    this.nodes.get(target).point.focus();
  }

  /** The point the arrow, Home or End key moves to: left and right in x order, up and down on screen. */
  keyTarget(key) {
    const points = this.current?.points ?? [];
    const byX = [...points].sort((a, b) => a.x - b.x || a.y - b.y).map((point) => point.method.id);
    const byY = [...points].sort((a, b) => a.y - b.y || a.x - b.x).map((point) => point.method.id);
    const step = (order, delta) => order[Math.min(order.length - 1, Math.max(0, order.indexOf(this.focused) + delta))];
    const moves = {
      ArrowRight: () => step(byX, 1),
      ArrowLeft: () => step(byX, -1),
      ArrowDown: () => step(byY, 1),
      ArrowUp: () => step(byY, -1),
      Home: () => byX[0],
      End: () => byX.at(-1),
    };
    return moves[key]?.() ?? null;
  }

  onResize() {
    const width = Math.floor(this.plot.clientWidth);
    if (width > 0 && width !== this.width) this.render(false);
  }

  /** Switch the dataset or a metric and animate to it. */
  select(key, id) {
    if (this.state[key] === id) return;
    this.state[key] = id;
    this.save();
    this.render(true);
  }

  /** Show or hide an optional family; hiding it also drops its pinned highlights. */
  toggleFamily(family) {
    if (this.shown.has(family.id)) {
      this.shown.delete(family.id);
      for (const method of family.members) this.pinned.delete(method.id);
    } else {
      this.shown.add(family.id);
    }
    this.save();
    this.render(true);
  }

  /* Highlight and tooltip -------------------------------------------------------------------- */

  /** Set the method under the pointer, a legend entry or a table row; `tip` shows its tooltip. */
  setHover(id, tip = true) {
    const same = id ? this.hover?.id === id && this.hover.tip === tip : this.hover === null;
    if (same) return;
    this.hover = id ? { id, tip } : null;
    this.refresh();
  }

  /** Track the focused point and keep it as the one tab stop of the chart. */
  setFocused(id) {
    this.focused = id;
    this.tipHidden = false;
    if (id) {
      for (const [other, node] of this.nodes) node.point.setAttribute("tabindex", other === id ? "0" : "-1");
    }
    this.refresh();
  }

  /** Pin or unpin a method's highlight (legend entries). */
  togglePin(id) {
    if (!this.pinned.delete(id)) this.pinned.add(id);
    this.refresh();
  }

  /** Dim every method outside the pinned, hovered and focused ones, and show the tooltip. */
  refresh() {
    const target = this.hover?.id ?? this.focused;
    const active = new Set(this.pinned);
    if (target) active.add(target);
    for (const [id, node] of this.nodes) {
      const dim = active.size > 0 && !active.has(id);
      for (const element of [node.point, node.halo, node.label, node.leader]) element?.classList.toggle("is-dim", dim);
      node.point.classList.toggle("is-target", id === target);
      node.row.classList.toggle("is-active", active.size > 0 && active.has(id));
      node.legend.setAttribute("aria-pressed", String(this.pinned.has(id)));
    }
    const tip = this.hover ? (this.hover.tip ? this.hover.id : null) : this.tipHidden ? null : this.focused;
    if (tip && !this.moving) this.showTip(tip);
    else this.hideTip();
  }

  /** Show the tooltip of a plotted method next to its point. */
  showTip(id) {
    const point = this.current?.points.find((item) => item.method.id === id);
    if (!point) {
      this.hideTip();
      return;
    }
    this.fillTip(point.method);
    this.tip.hidden = false;
    this.positionTip(point);
  }

  hideTip() {
    this.tip.hidden = true;
  }

  /** Tooltip: the method, all its values (the plotted two stand out) and a footer of counts. */
  fillTip(method) {
    const name = html("p", "ex-tip-name");
    name.append(swatch(method), html("span", "", method.label));
    const values = html("dl", "ex-tip-values");
    const yIds = new Set(this.data.yMetrics.map((metric) => metric.id));
    for (const metric of this.metrics) {
      const plotted = metric.id === this.state.x || metric.id === this.state.y;
      const dagger = this.hardwareScenes(method.id, metric.id) ? DAGGER : "";
      const item = html("div", `${yIds.has(metric.id) ? "is-y" : "is-x"}${plotted ? " is-plotted" : ""}`);
      item.append(
        html("dt", "", metric.short),
        html("dd", "", `${formatValue(metric, this.value(method.id, metric.id))}${dagger}`),
      );
      values.append(item);
    }
    const primitives = this.value(method.id, "primitives");
    const counts = [
      primitives === null ? "" : `${countFormat.format(primitives)} primitives`,
      this.sceneText(method.id),
    ];
    const hardware = this.hardwareText(method.id);
    const footer = [
      counts.filter(Boolean).join(", "),
      hardware ? `${DAGGER} ${this.hardwareNames} not hardware-matched on ${hardware}` : "",
    ].filter(Boolean);
    this.tip.replaceChildren(name, values, ...footer.map((text) => html("p", "ex-tip-meta", text)));
  }

  /**
   * Place the tooltip next to the point: beside it, above or below it, or past its direct label.
   * Every spot is first moved inside the chart; the spot that covers least of the marker (with its
   * focus ring) wins, then the one that covers least of the label, then the earlier one.
   */
  positionTip(point) {
    const { width, height } = this.current.frame;
    const tipWidth = this.tip.offsetWidth;
    const tipHeight = this.tip.offsetHeight;
    const gap = point.r + 10;
    const spot = (left, top) =>
      rect(
        Math.min(Math.max(left, TIP_INSET), width - TIP_INSET - tipWidth),
        Math.min(Math.max(top, TIP_INSET), height - TIP_INSET - tipHeight),
        tipWidth,
        tipHeight,
      );
    const middleX = point.x - tipWidth / 2;
    const middleY = point.y - tipHeight / 2;
    const label = this.placements.get(point.method.id)?.box;
    const spots = [
      spot(point.x + gap, middleY),
      spot(point.x - gap - tipWidth, middleY),
      spot(middleX, point.y - gap - tipHeight),
      spot(middleX, point.y + gap),
      ...(label
        ? [
            spot(middleX, Math.min(point.y - gap, label.top - 6) - tipHeight),
            spot(middleX, Math.max(point.y + gap, label.bottom + 6)),
          ]
        : []),
    ];
    const reach = point.r + 6;
    const marker = rect(point.x - reach, point.y - reach, 2 * reach, 2 * reach);
    const costs = spots.map((box) => [overlapArea(box, marker), label ? overlapArea(box, label) : 0]);
    let best = 0;
    costs.forEach(([markerArea, labelArea], index) => {
      const [bestMarker, bestLabel] = costs[best];
      if (markerArea < bestMarker || (markerArea === bestMarker && labelArea < bestLabel)) best = index;
    });
    this.tip.style.transform = `translate(${Math.round(spots[best].left)}px, ${Math.round(spots[best].top)}px)`;
  }

  /* Rendering -------------------------------------------------------------------------------- */

  /** Draw the current selection; `animate` glides the points and cross-fades the axes. */
  render(animate) {
    const width = Math.floor(this.plot.clientWidth);
    if (width <= 0) return;
    this.width = width;
    const motion = animate && !reducedMotion.matches;
    const view = this.view();
    const visible = this.visibleMethods();
    const present = visible.filter(
      (method) => this.value(method.id, view.x.id) !== null && this.value(method.id, view.y.id) !== null,
    );
    const frame = this.layout(width, view, present);
    const compact = frame.type === TYPE.compact;
    const points = present.map((method) => this.toPoint(method, frame, view));
    this.current = { frame, points };
    this.content.classList.toggle("is-compact", compact);
    const summary = this.summary(view);
    setAttributes(this.svg, {
      width,
      height: frame.height,
      viewBox: `0 0 ${width} ${frame.height}`,
      "aria-label": summary,
    });
    this.empty.hidden = points.length > 0;
    if (!motion) this.content.classList.add("is-static");
    this.drawAxes(frame, view, motion && points.length > 0);
    this.placePoints(points, view);
    this.scheduleLabels(frame.plot ? placeLabels(points, frame) : new Map(), frame, motion);
    if (!motion) {
      void this.svg.getBoundingClientRect();
      this.content.classList.remove("is-static");
    }
    this.updateControls(view);
    this.updateLegend(points);
    this.updateTable(view, compact, visible);
    this.status.textContent = `${summary}.`;
  }

  /** What the chart shows, in words: "PSNR against model memory (log scale) on DTU, compared with ...". */
  summary(view) {
    const families = this.data.families.filter((family) => !family.ours && this.familyShown(family));
    const names = listText(families.map((family) => inSentence(family.label)));
    const scaled = (text, log) => (log ? `${text} (log scale)` : text);
    const axes = `${scaled(view.y.short, view.yLog)} against ${scaled(view.x.noun, view.xLog)}`;
    return `${axes} on ${view.dataset.label}${names ? `, compared with ${names}` : ""}`;
  }

  /** Plot rectangle, type sizes and scales for the methods with both values. */
  layout(width, view, present) {
    const type = width < COMPACT_WIDTH ? TYPE.compact : TYPE.regular;
    const height = chartHeight(width);
    const frame = { width, height, type };
    if (!present.length) return frame;
    const top = type.title + 22;
    const bottom = height - (type.tick + type.title + 26);
    const [low, high] = view.y.better === "higher" ? [bottom, top] : [top, bottom];
    const yCount = Math.max(3, Math.floor((bottom - top) / 56));
    const y = makeScale(
      present.map((method) => this.value(method.id, view.y.id)),
      { log: view.yLog, zero: false, start: low, end: high, count: yCount },
    );
    const left = Math.ceil(Math.max(...y.ticks.map((tick) => textWidth(tick.text, this.font(type.tick))))) + 10;
    const right = width - 12;
    const xCount = Math.max(3, Math.floor((right - left) / (view.xLog ? 64 : 90)));
    const x = makeScale(
      present.map((method) => this.value(method.id, view.x.id)),
      { log: view.xLog, zero: true, start: left, end: right, count: xCount },
    );
    return { ...frame, plot: { left, right, top, bottom }, x, y };
  }

  /** Pixel position, marker radius and direct label of a method; the label carries a dagger for other hardware. */
  toPoint(method, frame, view) {
    const other = [view.x.id, view.y.id].some((id) => this.hardwareScenes(method.id, id) > 0);
    const labelText = other ? `${method.label}${DAGGER}` : method.label;
    return {
      method,
      x: frame.x.map(this.value(method.id, view.x.id)),
      y: frame.y.map(this.value(method.id, view.y.id)),
      r: method.ours ? MARKER_RADIUS.ours : MARKER_RADIUS.baseline,
      labelText,
      labelWidth: Math.ceil(textWidth(labelText, this.font(frame.type.label, method.ours ? 600 : 400))) + 2,
    };
  }

  /** Draw grid, ticks and titles in a new layer; when animating, cross-fade it with the old one. */
  drawAxes(frame, view, motion) {
    const leaving = [...this.axisLayer.children];
    if (!frame.plot) {
      leaving.forEach((layer) => layer.remove());
      return;
    }
    const layer = svgNode("g", { class: "ex-axis" });
    this.drawGrid(layer, frame);
    this.drawTitles(layer, frame, view);
    if (!motion) {
      this.axisLayer.replaceChildren(layer);
      return;
    }
    for (const old of leaving) old.classList.add("is-leaving");
    layer.classList.add("is-entering");
    this.axisLayer.append(layer);
    void layer.getBoundingClientRect();
    layer.classList.remove("is-entering");
    setTimeout(() => leaving.forEach((old) => old.remove()), FADE_MS);
  }

  /** Gridlines and tick labels of both axes, and the x baseline. */
  drawGrid(layer, frame) {
    const { plot, x, y, type, width } = frame;
    const tickFont = this.font(type.tick);
    for (const tick of y.ticks) {
      const position = crisp(y.map(tick.value));
      svgNode("line", { class: "ex-grid", x1: plot.left, x2: plot.right, y1: position, y2: position }, layer);
      svgText(layer, "ex-tick", tick.text, {
        x: plot.left - 8,
        y: position,
        dy: "0.35em",
        "text-anchor": "end",
        "font-size": type.tick,
      });
    }
    for (const tick of x.ticks) {
      const position = crisp(x.map(tick.value));
      const half = textWidth(tick.text, tickFont) / 2;
      svgNode("line", { class: "ex-grid", x1: position, x2: position, y1: plot.top, y2: plot.bottom }, layer);
      svgText(layer, "ex-tick", tick.text, {
        x: Math.min(Math.max(position, half), width - half),
        y: plot.bottom + type.tick + 7,
        "text-anchor": "middle",
        "font-size": type.tick,
      });
    }
    const base = crisp(plot.bottom);
    svgNode("line", { class: "ex-baseline", x1: plot.left, x2: plot.right, y1: base, y2: base }, layer);
  }

  /** Axis titles: y at the top left with an up arrow, x under the ticks with an arrow at its better end. */
  drawTitles(layer, frame, view) {
    const { plot, type, height } = frame;
    const titleFont = this.font(type.title, 600);
    const yTitle = view.yLog ? `${view.y.label}, log scale` : view.y.label;
    svgText(layer, "ex-axis-title", yTitle, { x: 0, y: type.title, "font-size": type.title });
    this.drawCue(layer, textWidth(yTitle, titleFont) + 12, type.title, "up", type.tick);
    const lower = view.x.better === "lower";
    const baseline = height - 6;
    const cueWidth = this.drawCue(layer, lower ? plot.left : plot.right, baseline, lower ? "left" : "right", type.tick);
    const title = view.xLog ? `${view.x.label}, log scale` : view.x.label;
    const titleWidth = textWidth(title, titleFont);
    const centred = (plot.left + plot.right - titleWidth) / 2;
    const left = lower
      ? Math.max(centred, plot.left + cueWidth + 16)
      : Math.min(centred, plot.right - cueWidth - 16 - titleWidth);
    svgText(layer, "ex-axis-title", title, { x: left, y: baseline, "font-size": type.title });
  }

  /** An arrow and the word "better", starting at x (ending at x for "right"); returns its width. */
  drawCue(layer, x, baseline, direction, size) {
    const arrowWidth = 10;
    const word = "better";
    const group = svgNode("g", { class: "ex-cue" }, layer);
    const middle = baseline - size * 0.34;
    const arrowX = direction === "right" ? x - arrowWidth / 2 : x + arrowWidth / 2;
    const textX = direction === "right" ? x - arrowWidth - 5 : x + arrowWidth + 5;
    const transform = `translate(${arrowX} ${middle})`;
    svgNode("path", { class: "ex-cue-arrow", d: ARROWS[direction], transform }, group);
    svgText(group, "ex-cue-text", word, {
      x: textX,
      y: baseline,
      "text-anchor": direction === "right" ? "end" : "start",
      "font-size": size,
    });
    return arrowWidth + 5 + textWidth(word, this.font(size));
  }

  /** Move the markers and halos; a point that was hidden appears in place instead of gliding in. */
  placePoints(points, view) {
    const shown = new Set(points.map((point) => point.method.id));
    for (const point of points) {
      const node = this.nodes.get(point.method.id);
      for (const element of [node.point, node.halo].filter(Boolean)) {
        const appearing = element.classList.contains("is-absent");
        if (appearing) element.classList.add("is-jump");
        element.style.transform = `translate(${point.x}px, ${point.y}px)`;
        if (appearing) {
          void element.getBoundingClientRect();
          element.classList.remove("is-jump", "is-absent");
        }
      }
      node.point.removeAttribute("aria-hidden");
      node.point.setAttribute("aria-label", this.pointLabel(point.method, view));
    }
    for (const [id, node] of this.nodes) {
      if (shown.has(id)) continue;
      node.point.classList.add("is-absent");
      node.halo?.classList.add("is-absent");
      node.point.setAttribute("aria-hidden", "true");
      if (this.focused === id) node.point.blur();
    }
    const tabStop = [...this.nodes.values()].find(({ point }) => point.getAttribute("tabindex") === "0");
    if (!tabStop || !shown.has(tabStop.method.id)) {
      const first = points[0]?.method.id;
      for (const [id, node] of this.nodes) node.point.setAttribute("tabindex", id === first ? "0" : "-1");
    }
  }

  /** Accessible name of a point: the method and its two plotted values. */
  pointLabel(method, view) {
    const y = formatValue(view.y, this.value(method.id, view.y.id));
    const x = formatValue(view.x, this.value(method.id, view.x.id));
    return `${method.label}: ${view.y.short} ${y}, ${view.x.short} ${x}`;
  }

  /** Apply label placements now, or after the points have moved: labels fade out, then back in. */
  scheduleLabels(placements, frame, motion) {
    const show = () => {
      this.moving = false;
      this.applyLabels(placements, frame);
      this.labelLayer.classList.remove("is-hidden");
      this.refresh();
    };
    clearTimeout(this.labelTimer);
    if (!motion) {
      show();
      return;
    }
    this.moving = true;
    this.labelLayer.classList.add("is-hidden");
    this.hideTip();
    this.labelTimer = setTimeout(show, MOVE_MS);
  }

  /** Move every direct label and leader line to its placement, or hide it. */
  applyLabels(placements, frame) {
    this.placements = placements;
    for (const [id, node] of this.nodes) {
      const placement = placements.get(id);
      node.label.classList.toggle("is-placed", Boolean(placement));
      node.leader.classList.toggle("is-placed", Boolean(placement?.leader));
      if (!placement) continue;
      const { box, leader, text } = placement;
      node.label.textContent = text;
      setAttributes(node.label, {
        x: box.left + 1,
        y: box.top + box.height / 2,
        dy: "0.35em",
        "font-size": frame.type.label,
      });
      if (leader) setAttributes(node.leader, leader);
    }
  }

  /** Pressed states of the buttons and the family toggles, and the log checkboxes of the plotted metrics. */
  updateControls(view) {
    const selected = { dataset: view.dataset.id, y: view.y.id, x: view.x.id };
    for (const [key, buttons] of Object.entries(this.controls)) {
      for (const button of buttons) button.setAttribute("aria-pressed", String(button.dataset.value === selected[key]));
    }
    for (const [id, node] of this.familyNodes) node.toggle?.setAttribute("aria-pressed", String(this.shown.has(id)));
    this.logInputs.y.checked = view.yLog;
    this.logInputs.x.checked = view.xLog;
  }

  /** Hide the legend groups of hidden families and mark entries without a point in this selection. */
  updateLegend(points) {
    for (const family of this.data.families) this.familyNodes.get(family.id).legend.hidden = !this.familyShown(family);
    const plotted = new Set(points.map((point) => point.method.id));
    for (const [id, node] of this.nodes) {
      node.legend.classList.toggle("is-absent", !plotted.has(id));
      node.legend.title = plotted.has(id) ? "" : "No value for this selection";
    }
  }

  /**
   * Values of the selected dataset for the shown families; the best shown value of each column (as
   * printed) in bold. On compact screens the plotted y and x columns come first, so they are not
   * scrolled out of view.
   */
  updateTable(view, compact, visible) {
    const { dataset } = view;
    const others = this.data.datasets.filter((item) => item.scenes !== null).map((item) => item.label);
    this.tableTitle.textContent =
      dataset.scenes === null
        ? `${dataset.label}: average of the ${listText(others)} means`
        : `${dataset.label}: mean over ${dataset.scenes} scenes`;
    for (const family of this.data.families) this.familyNodes.get(family.id).body.hidden = !this.familyShown(family);
    const axes = [view.y.id, view.x.id];
    const order = compact
      ? [...axes, ...this.metrics.map((metric) => metric.id).filter((id) => !axes.includes(id))]
      : this.metrics.map((metric) => metric.id);
    this.headRow.append(...order.map((id) => this.headCells.get(id)));
    for (const node of this.nodes.values()) node.row.append(...order.map((id) => node.cells.get(id)));
    for (const metric of this.metrics) {
      const plotted = metric.id === view.x.id || metric.id === view.y.id;
      const best = this.bestValue(metric, visible);
      this.headCells.get(metric.id).classList.toggle("is-plotted", plotted);
      for (const [id, node] of this.nodes) {
        const value = this.value(id, metric.id);
        const cell = node.cells.get(metric.id);
        const dagger = value !== null && this.hardwareScenes(id, metric.id) > 0;
        cell.replaceChildren(
          value === null ? MISSING : formatNumber(value, metric.decimals),
          ...(dagger ? [html("sup", "ex-dagger", DAGGER)] : []),
        );
        cell.classList.toggle("is-best", value !== null && Number(value.toFixed(metric.decimals)) === best);
      }
    }
    this.updateTableNotes(visible);
    this.updateFootnotes(view);
  }

  /** The best value of a metric among `methods` on the current dataset, rounded as printed; null without values. */
  bestValue(metric, methods) {
    const values = methods
      .map((method) => this.value(method.id, metric.id))
      .filter((value) => value !== null)
      .map((value) => Number(value.toFixed(metric.decimals)));
    if (!values.length) return null;
    return metric.better === "higher" ? Math.max(...values) : Math.min(...values);
  }

  /** Table notes for the shown methods: fewer scenes than the dataset has (*), and values from other hardware. */
  updateTableNotes(visible) {
    const total = this.view().dataset.scenes;
    const partial = [];
    const hardware = [];
    for (const [id, node] of this.nodes) {
      const scenes = this.value(id, "scenes");
      const isPartial = total !== null && scenes !== null && scenes < total;
      node.mark.hidden = !isPartial;
      if (!visible.includes(node.method)) continue;
      if (isPartial) partial.push(`${node.method.label} (${scenes} of ${total} scenes)`);
      const other = this.hardwareText(id);
      if (other) hardware.push(`${node.method.label} (${other})`);
    }
    const lines = [
      partial.length ? `* Mean over the scenes available: ${listText(partial)}.` : "",
      hardware.length ? `${DAGGER} ${this.hardwareNames} are not hardware-matched for ${listText(hardware)}.` : "",
    ];
    this.tableNotes.replaceChildren(...lines.filter(Boolean).map((text) => html("p", "", text)));
  }

  /** Definitions of the plotted metrics and, for a mean of datasets, of that mean. */
  updateFootnotes(view) {
    const keys = [view.y.id, view.x.id, view.dataset.id].filter((key) => this.data.definitions.has(key));
    this.footnotes.replaceChildren(...keys.map((key) => this.definitionLine(key)));
  }
}

/**
 * Wait for the chart's fonts, so text is measured with the faces it is drawn in. A font that fails (blocked or
 * offline) or is slower than FONT_WAIT_MS only costs exact label measurements, never the chart.
 */
async function fontsReady(root) {
  const family = getComputedStyle(root).fontFamily;
  const loads = Promise.allSettled(["400", "600"].map((weight) => document.fonts.load(`${weight} 12px ${family}`)));
  await Promise.race([loads, new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS))]);
}

const root = document.getElementById("explorer-root");
if (root) {
  const source = root.dataset.src;
  loadJSON(source)
    .then(async (raw) => {
      const data = parseData(raw, source);
      await fontsReady(root);
      return new Explorer(root, data);
    })
    .catch((error) => {
      console.error("The results explorer could not be loaded", error);
      root.replaceChildren(html("p", "ex-error", ERROR_TEXT));
    });
}
