/**
 * Hexels variants ablation: the six Hexels configurations side by side on a few representative scenes.
 *
 * Mount: <div id="variants-root" data-src="static/data/variants.json">
 *
 * The six variants cross three appearance models (V1, V2, V3) with two population policies, fixed (F) and
 * densified (G). Scene buttons, grouped by dataset, pick one of the scenes in the data file, and the six
 * fly-arounds of that scene play in a grid: fixed variants on top and densified ones below, in columns V1, V2
 * and V3 (on phones two columns, fixed and densified, with a row per appearance model). One play button, frame
 * steps and a scrubber drive all six. The first video is the clock and the other five follow it within a frame,
 * the approach of SyncedPair in video-sync.js (nudged playback rates, a realigning restart for larger drift,
 * paused frames seeked to the middle of the same frame) extended from two videos to six, built on that module's
 * exported helpers.
 *
 * Playback goes through the playback manager (playback.js) as a hover group whose zone is the whole section: with a
 * mouse the six videos play while the pointer rests on the section and pause when it leaves, and they load once the
 * grid stays near the viewport, so hovering starts them at once. On touch screens and under prefers-reduced-motion
 * only a tap or click on the videos or the play button plays, and nothing but the posters loads before. An explicit
 * pause (a click or tap on the videos, the play button, space, a frame step or scrubbing) holds the frame until
 * the visitor plays again, also while hovering and across later visits of the section. The decoders are freed a
 * few seconds after the grid moves away from the viewport or the tab is hidden; when the grid is near the viewport
 * again (or the tab visible again) and the posters (frame 0) would not show the frame to resume from, the videos
 * load again on that frame, so the picture always matches the counter.
 *
 * Under the grid, a toggle switches the numbers between the scene and the mean of its dataset. The table lists
 * PSNR, SSIM, LPIPS, FPS, training time, model memory, primitives and peak training VRAM of every variant, quality
 * first, with the best printed value of each ranked column in bold: FPS within the measured re-timing spread of
 * the fastest (fps_repeatability in the data file) counts as tied, and values measured on a GPU other than the RTX
 * A5000 carry a dagger and are not ranked. The scatter plot shows a quality metric (PSNR, SSIM or LPIPS, up is
 * better) against model memory, VRAM, training time or primitives: one hexagon per variant, colored by appearance
 * model, hollow when fixed and filled when densified, with a line from each fixed variant to its densified one.
 * Hovering, tapping or focusing a point shows its two values, and hovering a point, a table row or a video
 * highlights that variant everywhere. Numbers are shown as the data file prints them (its text strings), never
 * reformatted.
 *
 * Public API: window.HexelsVariants = { selectScene(sceneId) }, with a scene id of the data file ("dtu/scan65").
 */
import { loadJSON, mediaBase, mediaUrl, watchNear } from "./media.js";
import { hasMouse, hoverPlays, playback } from "./playback.js";
import { frameTime, releaseVideo, seekAndPresent, whenLoaded, wrapFrame } from "./video-sync.js";

const DATA_VERSION = 1;
const SVG_NS = "http://www.w3.org/2000/svg";
const REFERENCE_GPU = "RTX A5000";
const DAGGER = "†";
const NO_MEDIA_TEXT = "Videos will appear here once the media is hosted.";
const MISSING_TEXT = "The videos of this scene are not available yet.";
const ERROR_TEXT = "These videos could not be loaded. Please try another scene.";
const LOAD_ERROR_TEXT = "The Hexels variants could not be loaded.";

/* Table columns in order, quality first so that a narrow screen shows it without scrolling, with their header
   (name, unit); the plot's axis choices with their button labels. */
const TABLE_COLUMNS = [
  { id: "psnr", name: "PSNR", unit: "dB" },
  { id: "ssim", name: "SSIM", unit: "" },
  { id: "lpips", name: "LPIPS", unit: "VGG" },
  { id: "fps", name: "FPS", unit: "" },
  { id: "train_min", name: "Training time", unit: "min" },
  { id: "memory_mb", name: "Model memory", unit: "MB" },
  { id: "primitives", name: "Primitives", unit: "" },
  { id: "vram_gib", name: "Peak VRAM", unit: "GiB" },
];
const PLOT_X = [
  { id: "memory_mb", button: "Model memory" },
  { id: "vram_gib", button: "VRAM" },
  { id: "train_min", button: "Training time" },
  { id: "primitives", button: "Primitives" },
];
const PLOT_Y = [
  { id: "psnr", button: "PSNR" },
  { id: "ssim", button: "SSIM" },
  { id: "lpips", button: "LPIPS" },
];
const SCOPES = [
  { id: "scene", button: "This scene" },
  { id: "mean", button: "Dataset mean" },
];
const POPULATION_NAMES = { fixed: "Fixed", densified: "Densified" };

/* Synchronization, as in video-sync.js: drift beyond RESYNC_FRAMES (WRAP_RESYNC_FRAMES at the loop point)
   realigns all videos; smaller drift outside the dead band is nudged out through the playback rate. */
const HAVE_METADATA = 1;
const HAVE_FUTURE_DATA = 3;
const RESYNC_FRAMES = 2;
const WRAP_RESYNC_FRAMES = 1;
const DEADBAND_FRAMES = 0.25;
const NUDGE_PER_SECOND = 2;
const MAX_NUDGE = 0.08;
const RELEASE_DELAY_MS = 3000;
// The grid must stay near the viewport this long before its media load, so that a smooth scroll that only passes it
// (the BibTeX button's jump to the end of the page) loads nothing; the comparison player waits as long.
const NEAR_SETTLE_MS = 250;

/* Plot geometry: marker radius, hit radius of the nearest point, label gaps and type sizes (px). */
const MARKER_RADIUS = 7;
const HIT_RADIUS = 24;
const LABEL_GAPS = [4, 14, 26];
const LABEL_DIRECTIONS = [[1, 0], [-1, 0], [0, -1], [0, 1], [1, -1], [-1, -1], [1, 1], [-1, 1]];
const TYPE = {
  regular: { tick: 11.5, label: 12, title: 12.5 },
  compact: { tick: 11, label: 11.5, title: 12 },
};
const COMPACT_WIDTH = 440;
const MOVE_MS = 450;
const ARROWS = {
  up: "M0 5V-5M-3.5-1.5L0-5L3.5-1.5",
  left: "M5 0H-5M-1.5-3.5L-5 0L-1.5 3.5",
};

const hasFrameCallback = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
const mouse = hasMouse();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const measureContext = document.createElement("canvas").getContext("2d");
const numberFormats = new Map();
const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/* ---------- DOM helpers ---------- */

/** Create an element; `on*` keys become listeners, other keys attributes (skipped when null or false). */
function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? "" : String(value));
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

/** Create an SVG element with attributes, appended to `parent` when one is given. */
function svg(tag, attributes = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined) node.setAttribute(name, String(value));
  }
  if (parent) parent.append(node);
  return node;
}

function svgText(parent, className, text, attributes) {
  const node = svg("text", { class: className, ...attributes }, parent);
  node.textContent = text;
  return node;
}

function icon(name) {
  return el("i", { class: `fa-solid fa-${name}`, "aria-hidden": "true" });
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/** Path of a flat-topped hexagon of circumradius `radius` centred on the origin. */
function hexagonPath(radius) {
  const corners = Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 3) * index;
    return `${(radius * Math.cos(angle)).toFixed(2)} ${(radius * Math.sin(angle)).toFixed(2)}`;
  });
  return `M${corners.join("L")}Z`;
}

/** Small inline hexagon in a variant's color, hollow for a fixed population: the key of labels and rows. */
function swatch(variant) {
  const node = svg("svg", {
    class: "hx-var-swatch",
    viewBox: "-8 -8 16 16",
    width: 14,
    height: 14,
    "aria-hidden": "true",
    "data-appearance": variant?.appearance,
    "data-population": variant?.population,
  });
  svg("path", { d: hexagonPath(6.2) }, node);
  return node;
}

/** Width in pixels of `text` set in the CSS `font`. */
function textWidth(text, font) {
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

/**
 * Ascent and descent in pixels of the CSS `font` (`size` px): the font's line box, which is the height of an SVG text
 * box (getBBox). Browsers without font bounding box metrics get a generous estimate.
 */
function fontBox(font, size) {
  measureContext.font = font;
  const { fontBoundingBoxAscent: ascent, fontBoundingBoxDescent: descent } = measureContext.measureText("Hg");
  return Number.isFinite(ascent) && Number.isFinite(descent)
    ? { ascent, descent }
    : { ascent: size * 1.1, descent: size * 0.32 };
}

/** Format `value` with fixed decimals and thousands separators (axis ticks only; data values use their texts). */
function formatNumber(value, decimals) {
  if (!numberFormats.has(decimals)) {
    numberFormats.set(
      decimals,
      new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
    );
  }
  return numberFormats.get(decimals).format(value);
}

/** The printed value of a text ("1,306,978", "0.62") as a number, or null. */
function printedNumber(text) {
  const value = Number(String(text ?? "").replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

/** Text with a unit: "4.34 MB", or the bare text when the metric has no unit. */
function withUnit(text, unit) {
  return unit ? `${text} ${unit}` : text;
}

/* ---------- Data ---------- */

function fail(message) {
  throw new Error(`variants data: ${message}`);
}

function requireString(value, what) {
  if (typeof value !== "string" || !value) fail(`${what} is missing`);
  return value;
}

/** Check one row of values (a scene's or a dataset mean's) for every metric used, and return it. */
function checkRow(row, metricIds, what) {
  if (!row || typeof row !== "object") fail(`${what} is missing`);
  for (const id of metricIds) {
    if (!Number.isFinite(row[id])) fail(`${what}: ${id} is not a number`);
    requireString(row.text?.[id], `${what}: the text of ${id}`);
  }
  return row;
}

/** Validate the data file and return the parts the component uses; throws on any contract drift. */
function parseData(data) {
  if (data?.version !== DATA_VERSION) fail(`version ${data?.version}, expected ${DATA_VERSION}`);
  if (!Array.isArray(data.variants) || data.variants.length === 0) fail("no variants");
  const variants = data.variants.map((variant, index) => {
    for (const key of ["id", "label", "short", "appearance", "population"]) {
      requireString(variant?.[key], `variant ${index} ${key}`);
    }
    return variant;
  });
  if (new Set(variants.map(({ id }) => id)).size !== variants.length) fail("variant ids repeat");
  const metrics = new Map();
  for (const metric of [...(data.metrics?.x ?? []), ...(data.metrics?.y ?? [])]) metrics.set(metric?.id, metric);
  const metricIds = [...new Set([...TABLE_COLUMNS, ...PLOT_X, ...PLOT_Y].map(({ id }) => id))];
  for (const id of metricIds) {
    const metric = metrics.get(id);
    requireString(metric?.label, `metric ${id} label`);
    if (![null, "higher", "lower"].includes(metric.better)) fail(`metric ${id} has better ${metric.better}`);
  }
  if (!Array.isArray(data.datasets) || data.datasets.length === 0) fail("no datasets");
  const datasets = data.datasets.map((dataset) => ({
    id: requireString(dataset?.id, "dataset id"),
    label: requireString(dataset?.label, `dataset ${dataset?.id} label`),
  }));
  const datasetIds = new Set(datasets.map(({ id }) => id));
  if (!Array.isArray(data.scenes) || data.scenes.length === 0) fail("no scenes");
  const scenes = data.scenes.map((scene) => {
    const id = requireString(scene?.id, "scene id");
    if (!datasetIds.has(scene.dataset)) fail(`scene ${id} has the unknown dataset ${scene.dataset}`);
    requireString(scene.label, `scene ${id} label`);
    for (const key of ["grid_width", "grid_height", "frames", "frame_rate"]) {
      if (!(Number.isFinite(scene[key]) && scene[key] > 0)) fail(`scene ${id} ${key} is not a positive number`);
    }
    for (const variant of variants) {
      const video = scene.videos?.[variant.id];
      requireString(video?.key, `scene ${id} video of ${variant.id}`);
      requireString(video?.poster, `scene ${id} poster of ${variant.id}`);
      checkRow(scene.values?.[variant.id], metricIds, `scene ${id} values of ${variant.id}`);
    }
    return scene;
  });
  for (const dataset of datasets) {
    if (!scenes.some((scene) => scene.dataset === dataset.id)) continue;
    for (const variant of variants) {
      const row = checkRow(data.means?.[dataset.id]?.[variant.id], metricIds, `${dataset.id} mean of ${variant.id}`);
      if (!Number.isInteger(row.scenes) || row.scenes <= 0) fail(`${dataset.id} mean of ${variant.id}: no scene count`);
    }
  }
  // How far timing the same models twice moved FPS (fractions): FPS values that close to the fastest are tied.
  const repeat = data.fps_repeatability;
  for (const scope of SCOPES.map(({ id }) => id)) {
    if (!(Number.isFinite(repeat?.[scope]) && repeat[scope] >= 0 && repeat[scope] < 1)) {
      fail(`fps_repeatability ${scope} is not a fraction`);
    }
    requireString(repeat.text?.[scope], `fps_repeatability text of ${scope}`);
  }
  const opening = scenes.find((scene) => scene.id === data.default?.scene) ?? scenes[0];
  return {
    variants,
    metrics,
    datasets: datasets.filter((dataset) => scenes.some((scene) => scene.dataset === dataset.id)),
    scenes,
    means: data.means,
    fpsTie: { scene: repeat.scene, mean: repeat.mean },
    fpsTieText: { scene: repeat.text.scene, mean: repeat.text.mean },
    opening,
    definitions: data.definitions ?? {},
    notes: Array.isArray(data.notes) ? data.notes : [],
    selectionRule: typeof data.selection_rule === "string" ? data.selection_rule : null,
  };
}

/** The thumbnail of a scene: its own field when the data file has one, else the page's gallery thumbnail. */
function thumbUrl(scene) {
  return scene.thumb ?? `static/images/thumbs/${scene.dataset}_${scene.scene}.webp`;
}

/* ---------- Synchronized playback of several videos ---------- */

function canPlay(video) {
  return video.readyState >= HAVE_FUTURE_DATA;
}

/** False when the server does not allow seeking to `time` (for example without HTTP Range support). */
function canSeek(video, time) {
  const ranges = video.seekable;
  for (let index = 0; index < ranges.length; index += 1) {
    if (ranges.start(index) <= time && time <= ranges.end(index)) return true;
  }
  return false;
}

/** Index of the frame shown at `time` seconds, clamped to the clip. */
function frameAt(time, fps, frames) {
  return Math.min(frames - 1, Math.max(0, Math.floor(time * fps + 1e-6)));
}

function wrapDrift(drift, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return drift;
  if (drift > duration / 2) return drift - duration;
  if (drift < -duration / 2) return drift + duration;
  return drift;
}

/**
 * Several videos of one clip played in lockstep: SyncedPair's approach (video-sync.js) for any number of
 * videos. The first video is the clock; each other one is kept within a frame of it by small playbackRate
 * nudges, and drift beyond two frames stops all of them, seeks the laggards to the clock and restarts them
 * together. While any video cannot play yet, it keeps loading and the others hold their frame. When paused,
 * all videos are seeked to the middle of the same frame. Play intent is kept separately from element state.
 */
class SyncedGroup {
  /**
   * @param {object} hooks
   * @param {(frame: number) => void} [hooks.onFrame] called on every presented clock frame while playing
   * @param {() => void} [hooks.onBlocked] called when the browser refuses to start playback
   * @param {(error: Error) => void} [hooks.onError] called when a video cannot be loaded or seeked
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.videos = [];
    this.fps = 24;
    this.frames = 1;
    this.wantPlay = false;
    this.suspended = true;
    this.lastMasterTime = 0;
    this.loop = null;
    this.listeners = null;
    this.alignAbort = null;
    // Largest follower drift (seconds) at the last check and the number of realignments, for diagnostics.
    this.drift = 0;
    this.realigned = 0;
  }

  get master() {
    return this.videos[0] ?? null;
  }

  /** True when the group should be playing right now. */
  get playing() {
    return this.wantPlay && !this.suspended;
  }

  setClip(fps, frames) {
    this.fps = fps;
    this.frames = frames;
  }

  /** Bind (or rebind) the elements, the clock first; play intent is kept. */
  setVideos(videos) {
    this.stopLoop();
    this.alignAbort?.abort();
    this.listeners?.abort();
    this.videos = [...videos];
    this.listeners = new AbortController();
    const options = { signal: this.listeners.signal };
    for (const video of this.videos) {
      for (const type of ["waiting", "canplay", "playing"]) {
        video.addEventListener(type, () => this.onReadiness(video), options);
      }
    }
  }

  /** Index of the frame the clock shows. */
  currentFrame() {
    return this.master ? frameAt(this.master.currentTime, this.fps, this.frames) : 0;
  }

  play() {
    this.wantPlay = true;
    return this.sync();
  }

  /** Clear the play intent and pause every video where it is. */
  stop() {
    this.wantPlay = false;
    this.halt();
  }

  /** Pause and show frame `index` in every video. */
  pauseAt(index) {
    this.stop();
    return this.seekFrame(index);
  }

  /** Show frame `index` (wrapped into the clip) in every video without changing the intent. */
  async seekFrame(index, signal) {
    const time = frameTime(wrapFrame(index, this.frames), this.fps);
    await Promise.all(this.videos.map((video) => seekAndPresent(video, time, signal)));
  }

  /** Hold playback, for example while new sources load; the intent is kept for resume(). */
  suspend() {
    this.suspended = true;
    this.halt();
  }

  resume() {
    this.suspended = false;
    return this.sync();
  }

  /**
   * Bring the elements in line with the intent. While a video cannot play yet it keeps loading (some
   * browsers only load while playing) and the others hold their frame; once all can play, the others are
   * aligned to the clock and all start together.
   */
  async sync() {
    this.alignAbort?.abort();
    const { videos, master } = this;
    if (!this.playing || !master) {
      this.halt();
      return;
    }
    if (!videos.every(canPlay)) {
      for (const video of videos) {
        if (canPlay(video)) {
          if (!video.paused) video.pause();
        } else if (video.paused) {
          this.start(video);
        }
      }
      return;
    }
    if (videos.every((video) => !video.paused)) {
      this.scheduleLoop();
      return;
    }
    const abort = new AbortController();
    this.alignAbort = abort;
    for (const video of videos) if (!video.paused) video.pause();
    const target = master.currentTime;
    const off = videos.slice(1).filter((video) => Math.abs(video.currentTime - target) > 0.5 / this.fps);
    try {
      if (off.every((video) => canSeek(video, target))) {
        await Promise.all(off.map((video) => seekAndPresent(video, target, abort.signal)));
      } else {
        await Promise.all(videos.map((video) => seekAndPresent(video, 0, abort.signal)));
      }
    } catch (error) {
      if (!abort.signal.aborted) this.fail(error);
      return;
    }
    if (abort.signal.aborted || !this.playing) return;
    for (const video of videos) video.playbackRate = 1;
    await Promise.all(videos.map((video) => this.start(video)));
    if (abort.signal.aborted || !this.playing) return;
    this.lastMasterTime = master.currentTime;
    this.scheduleLoop();
  }

  async start(video) {
    try {
      await video.play();
    } catch (error) {
      if (error.name !== "NotAllowedError") return;
      this.stop();
      this.hooks.onBlocked?.();
    }
  }

  fail(error) {
    this.halt();
    this.hooks.onError?.(error);
  }

  /** Pause every element without changing the intent. */
  halt() {
    this.alignAbort?.abort();
    this.stopLoop();
    for (const video of this.videos) if (!video.paused) video.pause();
  }

  onReadiness(video) {
    if (!this.playing || video.seeking) return;
    this.sync();
  }

  scheduleLoop() {
    if (this.loop) return;
    const master = this.master;
    const tick = () => {
      this.loop = null;
      if (!this.playing || master !== this.master || master.paused) return;
      this.hooks.onFrame?.(this.currentFrame());
      if (this.correctDrift()) this.scheduleLoop();
    };
    this.loop = hasFrameCallback
      ? { video: master, id: master.requestVideoFrameCallback(tick) }
      : { video: null, id: requestAnimationFrame(tick) };
  }

  stopLoop() {
    if (!this.loop) return;
    if (this.loop.video) this.loop.video.cancelVideoFrameCallback(this.loop.id);
    else cancelAnimationFrame(this.loop.id);
    this.loop = null;
  }

  /**
   * Keep every video within a frame of the clock: nudge rates for small drift, or realign and restart all
   * for large drift. Returns false when the loop should stop.
   */
  correctDrift() {
    const { videos, master, fps } = this;
    const followers = videos.slice(1);
    if (videos.some((video) => video.seeking) || followers.some((video) => video.paused)) return true;
    const duration = master.duration;
    const masterTime = master.currentTime;
    const wrapped = masterTime < this.lastMasterTime - duration / 2;
    this.lastMasterTime = masterTime;
    const frame = 1 / fps;
    const drifts = followers.map((video) => wrapDrift(video.currentTime - masterTime, duration));
    this.drift = Math.max(0, ...drifts.map(Math.abs));
    if (this.drift > (wrapped ? WRAP_RESYNC_FRAMES : RESYNC_FRAMES) * frame) {
      this.realigned += 1;
      for (const video of videos) video.pause();
      this.sync();
      return false;
    }
    followers.forEach((video, index) => {
      const drift = drifts[index];
      const nudge =
        Math.abs(drift) < DEADBAND_FRAMES * frame ? 0 : clamp(drift * NUDGE_PER_SECOND, -MAX_NUDGE, MAX_NUDGE);
      const rate = 1 - nudge;
      if (Math.abs(video.playbackRate - rate) > 1e-3) video.playbackRate = rate;
    });
    return true;
  }
}

/* ---------- Scene buttons ---------- */

/** Scene buttons with thumbnails, grouped by dataset. */
class ScenePicker {
  constructor(data, onSelect) {
    this.buttons = new Map();
    const groups = data.datasets.map((dataset) => {
      const scenes = data.scenes.filter((scene) => scene.dataset === dataset.id);
      const labelId = `hx-var-dataset-${dataset.id}`;
      return el(
        "div",
        { class: "hx-var-dataset", role: "group", "aria-labelledby": labelId },
        el("span", { class: "hx-var-dataset-label", id: labelId }, dataset.label),
        el("div", { class: "hx-var-dataset-scenes" }, ...scenes.map((scene) => this.buildButton(scene, onSelect))),
      );
    });
    this.element = el("div", { class: "hx-var-scenes" }, ...groups);
  }

  buildButton(scene, onSelect) {
    const thumb = el("img", { loading: "lazy", decoding: "async", width: "96", height: "60", alt: "", src: thumbUrl(scene) });
    thumb.addEventListener("error", () => thumb.remove(), { once: true });
    const button = el(
      "button",
      {
        type: "button",
        class: "hx-var-scene",
        "aria-pressed": "false",
        title: scene.group_label ?? null,
        onclick: () => onSelect(scene.id),
      },
      thumb,
      el("span", { class: "hx-var-scene-name" }, scene.label),
    );
    this.buttons.set(scene.id, button);
    return button;
  }

  show(sceneId) {
    for (const [id, button] of this.buttons) button.setAttribute("aria-pressed", String(id === sceneId));
  }
}

/* ---------- The video grid ---------- */

/** Six tiles, each a poster under a video and a label; posters show until a video has a frame. */
class VideoGrid {
  constructor(data, { onPosterError, onVideoError }) {
    const appearances = [...new Set(data.variants.map(({ appearance }) => appearance))];
    const populations = [...new Set(data.variants.map(({ population }) => population))];
    this.tiles = new Map();
    this.order = data.variants.map(({ id }) => id);
    // Fixed variants first in reading order: the grid shows them on its top row.
    const ordered = [...data.variants].sort(
      (a, b) => populations.indexOf(a.population) - populations.indexOf(b.population),
    );
    this.grid = el("div", { class: "hx-var-grid" });
    for (const variant of ordered) {
      const poster = el("img", { class: "hx-var-poster", alt: "", decoding: "async", "aria-hidden": "true" });
      poster.addEventListener("error", () => {
        const url = poster.getAttribute("src");
        poster.removeAttribute("src");
        onPosterError(url);
      });
      const video = el("video", {
        class: "hx-var-video",
        muted: true,
        loop: true,
        playsinline: true,
        preload: "auto",
        disablepictureinpicture: true,
        "aria-hidden": "true",
        "data-variant": variant.id,
      });
      video.muted = true;
      video.addEventListener("error", () => onVideoError(video));
      const label = el(
        "figcaption",
        { class: "hx-var-label" },
        swatch(variant),
        el("span", { class: "hx-var-label-name" }, variant.label),
        el("span", { class: "hx-var-tag" }, variant.short),
      );
      const tile = el(
        "figure",
        {
          class: "hx-var-tile",
          "data-variant": variant.id,
          "data-appearance": variant.appearance,
          "data-population": variant.population,
          style: `--hx-var-col: ${appearances.indexOf(variant.appearance) + 1}; --hx-var-row: ${
            populations.indexOf(variant.population) + 1
          }`,
        },
        poster,
        video,
        label,
      );
      this.tiles.set(variant.id, { tile, poster, video });
      this.grid.append(tile);
    }
    this.grid.style.setProperty("--hx-var-cols", String(appearances.length));
    this.grid.style.setProperty("--hx-var-rows", String(populations.length));
    this.cue = el("span", { class: "hx-hint hx-var-cue", "aria-hidden": "true", hidden: true });
    this.notice = el("div", { class: "hx-var-notice", hidden: true });
    this.element = el("div", { class: "hx-var-stage", tabindex: "0" }, this.grid, this.cue, this.notice);
  }

  /** The videos with the clock first, in the data file's variant order. */
  videos() {
    return this.order.map((id) => this.tiles.get(id).video);
  }

  /** Size the posters as the scene's grid clips. */
  setScene(scene) {
    for (const { poster } of this.tiles.values()) {
      Object.assign(poster, { width: scene.grid_width, height: scene.grid_height });
    }
  }

  setPoster(id, url) {
    const { poster } = this.tiles.get(id);
    if (url && poster.getAttribute("src") !== url) poster.src = url;
  }

  /** Remove every poster, so no picture of another scene shows through a notice. */
  clearPosters() {
    for (const { poster } of this.tiles.values()) poster.removeAttribute("src");
  }

  /** Show how to start playback ("Hover to play", "Click to play", "Tap to play"), or hide the cue with null. */
  setCue(text) {
    this.cue.hidden = !text;
    if (text) this.cue.replaceChildren(icon("play"), ` ${text}`);
  }

  /** Show `text` instead of the videos, or clear the notice with null. */
  setNotice(text) {
    this.notice.hidden = !text;
    this.notice.replaceChildren(...(text ? [icon("film"), el("p", {}, text)] : []));
    this.element.classList.toggle("has-notice", Boolean(text));
  }

  highlight(id) {
    for (const [variant, { tile }] of this.tiles) tile.classList.toggle("is-hot", variant === id);
  }
}

/** Play, frame steps, and a scrubber with a frame counter. */
class Controls {
  constructor(handlers) {
    this.handlers = handlers;
    this.frames = 1;
    this.playButton = el("button", { type: "button", class: "hx-var-play", onclick: handlers.onTogglePlay });
    const stepButton = (label, delta, glyph) =>
      el(
        "button",
        { type: "button", class: "hx-var-icon", "aria-label": label, title: label, onclick: () => handlers.onStep(delta) },
        icon(glyph),
      );
    this.stepButtons = [stepButton("Previous frame", -1, "backward-step"), stepButton("Next frame", 1, "forward-step")];
    this.scrubber = el(
      "div",
      { class: "hx-var-scrubber", role: "slider", tabindex: "0", "aria-label": "Frame", "aria-valuemin": "1" },
      el("div", { class: "hx-var-scrubber-track" }, el("div", { class: "hx-var-scrubber-fill" })),
      el("div", { class: "hx-var-scrubber-thumb" }),
    );
    this.counter = el("span", { class: "hx-var-counter", "aria-hidden": "true" });
    this.element = el(
      "div",
      { class: "hx-var-controls" },
      this.playButton,
      ...this.stepButtons,
      this.scrubber,
      this.counter,
    );
    this.bindScrubber();
    this.setPlaying(false);
  }

  bindScrubber() {
    let dragging = false;
    const frameAtPointer = (event) => {
      const rect = this.scrubber.getBoundingClientRect();
      return Math.round(clamp((event.clientX - rect.left) / rect.width, 0, 1) * (this.frames - 1));
    };
    this.scrubber.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || this.element.classList.contains("is-disabled")) return;
      event.preventDefault();
      dragging = true;
      this.scrubber.setPointerCapture(event.pointerId);
      this.handlers.onScrubStart();
      this.handlers.onScrub(frameAtPointer(event));
    });
    this.scrubber.addEventListener("pointermove", (event) => {
      if (dragging) this.handlers.onScrub(frameAtPointer(event));
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      this.handlers.onScrubEnd();
    };
    this.scrubber.addEventListener("pointerup", end);
    this.scrubber.addEventListener("pointercancel", end);
    this.scrubber.addEventListener("keydown", (event) => {
      const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1, PageDown: -10, PageUp: 10 };
      if (event.key in steps) this.handlers.onStep(steps[event.key]);
      else if (event.key === "Home") this.handlers.onStepTo(0);
      else if (event.key === "End") this.handlers.onStepTo(this.frames - 1);
      else return;
      event.preventDefault();
    });
  }

  setPlaying(playing) {
    this.playButton.replaceChildren(icon(playing ? "pause" : "play"));
    this.playButton.setAttribute("aria-label", playing ? "Pause the six videos" : "Play the six videos");
  }

  setFrame(frame, frames) {
    this.frames = frames;
    const progress = frames > 1 ? frame / (frames - 1) : 0;
    this.scrubber.style.setProperty("--hx-var-progress", `${(progress * 100).toFixed(3)}%`);
    this.scrubber.setAttribute("aria-valuemax", String(frames));
    this.scrubber.setAttribute("aria-valuenow", String(frame + 1));
    this.scrubber.setAttribute("aria-valuetext", `Frame ${frame + 1} of ${frames}`);
    this.counter.textContent = `${frame + 1} / ${frames}`;
  }

  setEnabled(enabled) {
    this.element.classList.toggle("is-disabled", !enabled);
    for (const button of [this.playButton, ...this.stepButtons]) button.disabled = !enabled;
    this.scrubber.tabIndex = enabled ? 0 : -1;
  }
}

/* ---------- Numbers: rows, best values and the table ---------- */

/** The GPU a scene row was measured on when it is not the reference GPU, or null. */
function otherGpu(row, scope) {
  if (scope === "mean") return row.ada_scenes > 0 ? `an RTX 6000 Ada (${row.ada_scenes} of ${row.scenes} scenes)` : null;
  return typeof row.gpu === "string" && row.gpu !== REFERENCE_GPU ? row.gpu : null;
}

/** True when the value of `metricId` in `row` depends on the GPU and was measured on another one. */
function isDaggered(metrics, metricId, row, scope) {
  return Boolean(metrics.get(metricId)?.gpu_dependent) && Boolean(otherGpu(row, scope));
}

/**
 * Keys "variant/metric" of the cells to print in bold: the best printed value of each ranked column, over
 * the rows measured on the reference GPU; FPS within the data file's re-timing spread of the fastest counts as tied.
 */
function bestCells(data, rows, scope) {
  const bold = new Set();
  for (const { id } of TABLE_COLUMNS) {
    const better = data.metrics.get(id).better;
    if (better !== "higher" && better !== "lower") continue;
    const values = data.variants
      .filter((variant) => !isDaggered(data.metrics, id, rows[variant.id], scope))
      .map((variant) => ({ id: variant.id, value: printedNumber(rows[variant.id].text[id]) }))
      .filter(({ value }) => value !== null);
    if (!values.length) continue;
    const numbers = values.map(({ value }) => value);
    const best = better === "higher" ? Math.max(...numbers) : Math.min(...numbers);
    const tie = id === "fps" ? data.fpsTie[scope] : 0;
    for (const { id: variant, value } of values) {
      const tied = better === "higher" ? value >= best * (1 - tie) : value <= best * (1 + tie);
      if (tied) bold.add(`${variant}/${id}`);
    }
  }
  return bold;
}

/** One row per variant and the columns of TABLE_COLUMNS; best values in bold, other-GPU values daggered. */
class MetricsTable {
  constructor(data, onHover) {
    this.data = data;
    this.onHover = onHover;
    this.rows = new Map();
    const head = el(
      "tr",
      {},
      el("th", { scope: "col", class: "hx-var-variant-col" }, "Variant"),
      ...TABLE_COLUMNS.map((column) => {
        const better = data.metrics.get(column.id).better;
        const arrow = better === "higher" ? "↑" : better === "lower" ? "↓" : "";
        const unit = [column.unit, arrow].filter(Boolean).join(" ");
        const description = better ? `, ${better} is better` : "";
        return el(
          "th",
          { scope: "col", class: "hx-var-num", title: `${data.metrics.get(column.id).label}${description}` },
          el("span", { class: "hx-var-head-name" }, column.name),
          el("span", { class: "hx-var-head-unit" }, unit || " "),
        );
      }),
    );
    this.body = el("tbody");
    for (const variant of data.variants) {
      const cells = TABLE_COLUMNS.map(() => el("td", { class: "hx-var-num" }));
      const row = el(
        "tr",
        {
          "data-variant": variant.id,
          "data-appearance": variant.appearance,
          onpointerenter: () => this.onHover(variant.id),
          onpointerleave: () => this.onHover(null),
        },
        el(
          "th",
          { scope: "row" },
          el(
            "span",
            { class: "hx-var-row-name" },
            swatch(variant),
            el("span", {}, variant.label),
            el("span", { class: "hx-var-tag" }, variant.short),
          ),
        ),
        ...cells,
      );
      this.rows.set(variant.id, { row, cells });
      this.body.append(row);
    }
    this.table = el(
      "table",
      { class: "hx-var-table" },
      el("thead", {}, head),
      this.body,
    );
    this.caption = el("caption", { class: "is-sr-only" });
    this.table.prepend(this.caption);
    this.note = el("p", { class: "hx-var-note" });
    this.scroller = el(
      "div",
      { class: "hx-var-table-scroll", role: "region", "aria-label": "Numbers of the six variants", tabindex: "0" },
      this.table,
    );
    this.element = el(
      "div",
      { class: "hx-var-table-card" },
      this.scroller,
      el("p", { class: "hx-var-swipe", "aria-hidden": "true" }, icon("left-right"), " Scroll sideways for every column"),
      this.note,
    );
    // The hint shows only while the table is wider than its card.
    new ResizeObserver(() => {
      this.element.classList.toggle("is-scrollable", this.scroller.scrollWidth > this.scroller.clientWidth + 1);
    }).observe(this.scroller);
  }

  /** Fill the cells with `rows` (variant id -> row of values), described by `title`. */
  render(rows, scope, title) {
    this.caption.textContent = title;
    const bold = bestCells(this.data, rows, scope);
    const gpus = new Set();
    for (const variant of this.data.variants) {
      const values = rows[variant.id];
      const gpu = otherGpu(values, scope);
      TABLE_COLUMNS.forEach((column, index) => {
        const cell = this.rows.get(variant.id).cells[index];
        const marked = isDaggered(this.data.metrics, column.id, values, scope);
        if (marked) gpus.add(gpu);
        cell.classList.toggle("is-best", bold.has(`${variant.id}/${column.id}`));
        cell.replaceChildren(values.text[column.id]);
        if (marked) cell.append(el("sup", { class: "hx-var-dagger", title: `Measured on ${gpu}` }, DAGGER));
      });
    }
    const tie = this.data.fpsTieText[scope];
    const notes = [
      `Bold marks the best value in each column; FPS within ${tie} of the fastest counts as tied.`,
      gpus.size ? `${DAGGER} Mixed hardware (${[...gpus].join(" or ")}), not ranked.` : "",
    ].filter(Boolean);
    this.note.textContent = notes.join(" ");
  }

  highlight(id) {
    for (const [variant, { row }] of this.rows) row.classList.toggle("is-hot", variant === id);
  }
}

/* ---------- Scatter plot ---------- */

/** Smallest 1-2-5 step that splits `span` into at most `count` intervals. */
function tickStep(span, count) {
  const raw = span / Math.max(count, 1);
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((factor) => factor * power).find((step) => step >= raw * (1 - 1e-9));
}

/** Decimals needed to print a 1-2-5 step or a multiple of one. */
function stepDecimals(value) {
  return Math.max(0, -Math.floor(Math.log10(value) + 1e-9));
}

function linearTicks(lo, hi, count) {
  const step = tickStep(hi - lo, count);
  const decimals = stepDecimals(step);
  const ticks = [];
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + step * 1e-9; k += 1) {
    ticks.push({ value: Number((k * step).toFixed(decimals + 2)), decimals });
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

/** Log-axis ticks on [lo, hi]: 1-2-5 per decade, thinned to at most `count`; linear steps for short spans. */
function logTicks(lo, hi, count) {
  const fine = decadeValues(lo, hi, [1, 2, 5]);
  if (fine.length < 3) return linearTicks(lo, hi, count);
  const values = [fine, decadeValues(lo, hi, [1, 3]), decadeValues(lo, hi, [1])].find((list) => list.length <= count) ??
    decadeValues(lo, hi, [1]);
  return values.map((value) => ({ value, decimals: stepDecimals(value) }));
}

/** Map values onto [start, end] pixels, linear or log10, padded, with ticks. */
function makeScale(values, { log, start, end, count }) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (log) {
    const lo = Math.log10(min);
    const hi = Math.log10(max);
    const pad = Math.max((hi - lo) * 0.1, 0.04);
    const [d0, d1] = [lo - pad, hi + pad];
    return {
      log: true,
      map: (value) => start + ((Math.log10(value) - d0) / (d1 - d0)) * (end - start),
      ticks: logTicks(10 ** d0, 10 ** d1, count),
    };
  }
  const span = max - min || Math.abs(max) * 0.05 || 1;
  const [d0, d1] = [min - span * 0.12, max + span * 0.12];
  return { log: false, map: (value) => start + ((value - d0) / (d1 - d0)) * (end - start), ticks: linearTicks(d0, d1, count) };
}

/** Half-pixel offset so 1px lines fall on the pixel grid. */
function crisp(value) {
  return Math.round(value) + 0.5;
}

function rect(left, top, width, height) {
  return { left, top, right: left + width, bottom: top + height };
}

function overlapArea(a, b) {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return Math.max(width, 0) * Math.max(height, 0);
}

function inside(box, bounds) {
  return box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom;
}

/** Segment from the marker's edge to the nearest point of the label box. */
function leaderLine(point, box) {
  const x = clamp(point.x, box.left, box.right);
  const y = clamp(point.y, box.top, box.bottom);
  const start = (point.r + 2) / Math.max(Math.hypot(x - point.x, y - point.y), 1e-6);
  return { x1: point.x + (x - point.x) * start, y1: point.y + (y - point.y) * start, x2: x, y2: y };
}

/** Small boxes along a segment, so labels can keep clear of lines. */
function segmentBoxes(x1, y1, x2, y2) {
  const steps = Math.max(2, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 6));
  return Array.from({ length: steps + 1 }, (_, step) => {
    const x = x1 + ((x2 - x1) * step) / steps;
    const y = y1 + ((y2 - y1) * step) / steps;
    return rect(x - 1.5, y - 1.5, 3, 3);
  });
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
 * Place a label for every point, most crowded points first: the first candidate clear of markers, labels,
 * lines, `obstacles` (boxes such as an axis title) and the plot edge; failing that, the one inside the plot that
 * overlaps the least.
 */
function placeLabels(points, bounds, lineHeight, lines, obstacles = []) {
  const markers = points.map((point) => ({
    id: point.id,
    box: rect(point.x - point.r - 3, point.y - point.r - 3, 2 * point.r + 6, 2 * point.r + 6),
  }));
  const lineBoxes = lines.flatMap((line) => segmentBoxes(line.x1, line.y1, line.x2, line.y2));
  const crowding = (point) =>
    points.filter((other) => other !== point && Math.hypot(other.x - point.x, other.y - point.y) < 48).length;
  const order = [...points].sort((a, b) => crowding(b) - crowding(a));
  const taken = [];
  const placements = new Map();
  for (const point of order) {
    const hard = [...obstacles, ...taken, ...markers.filter(({ id }) => id !== point.id).map(({ box }) => box)];
    let best = null;
    for (const candidate of labelCandidates(point, lineHeight)) {
      if (!inside(candidate.box, bounds)) continue;
      const leaderBoxes = candidate.leader
        ? segmentBoxes(candidate.leader.x1, candidate.leader.y1, candidate.leader.x2, candidate.leader.y2)
        : [];
      const hardOverlap =
        hard.reduce((sum, box) => sum + overlapArea(candidate.box, box), 0) +
        leaderBoxes.reduce((sum, seg) => sum + hard.reduce((inner, box) => inner + overlapArea(seg, box), 0), 0);
      const softOverlap = lineBoxes.reduce((sum, box) => sum + overlapArea(candidate.box, box), 0);
      const score = hardOverlap * 1000 + softOverlap;
      if (score === 0) {
        best = { ...candidate, score };
        break;
      }
      if (!best || score < best.score) best = { ...candidate, score };
    }
    if (best) {
      taken.push(best.box);
      placements.set(point.id, best);
    }
  }
  return placements;
}

/** Quality (y) against a cost (x) for the six variants, with direct labels, a legend and a hover tooltip. */
class TradeoffPlot {
  constructor(data, { onHover }) {
    this.data = data;
    this.onHover = onHover;
    this.state = { x: PLOT_X[0].id, y: PLOT_Y[0].id };
    this.buttons = { x: new Map(), y: new Map() };
    this.rows = null;
    this.description = "";
    this.hot = null;
    this.pinned = null;
    this.width = 0;
    this.drawn = false;
    this.fontFamily = "sans-serif";
    this.svg = svg("svg", { class: "hx-var-svg", role: "group" });
    this.axisLayer = svg("g", { class: "hx-var-axes", "aria-hidden": "true" }, this.svg);
    this.linkLayer = svg("g", { class: "hx-var-links", "aria-hidden": "true" }, this.svg);
    this.labelLayer = svg("g", { class: "hx-var-labels", "aria-hidden": "true" }, this.svg);
    this.pointLayer = svg("g", { class: "hx-var-points" }, this.svg);
    this.points = new Map();
    this.links = new Map();
    this.labels = new Map();
    for (const variant of data.variants) this.buildPoint(variant);
    for (const appearance of new Set(data.variants.map((variant) => variant.appearance))) {
      this.links.set(appearance, svg("line", { class: "hx-var-link", "data-appearance": appearance }, this.linkLayer));
    }
    this.tip = el("div", { class: "hx-var-tip", hidden: true, "aria-hidden": "true" });
    this.chart = el("div", { class: "hx-var-chart" }, this.svg, this.tip);
    this.note = el(
      "p",
      { class: "hx-var-plot-note", hidden: true },
      "The fixed variants keep one shared population, so they line up at one primitive count.",
    );
    this.element = el(
      "div",
      { class: "hx-var-plot-card" },
      el(
        "div",
        { class: "hx-var-plot-controls" },
        this.buildGroup("Y axis", "y", PLOT_Y),
        this.buildGroup("X axis", "x", PLOT_X),
      ),
      this.chart,
      this.note,
      this.buildLegend(),
    );
    this.bindPointer();
    this.updateButtons();
    new ResizeObserver(() => {
      const width = Math.floor(this.chart.clientWidth);
      if (width > 0 && width !== this.width) this.draw(false);
    }).observe(this.chart);
    document.fonts?.ready.then(() => this.draw(false));
  }

  buildGroup(title, axis, options) {
    const labelId = `hx-var-${axis}-label`;
    const buttons = options.map((option) => {
      const button = el(
        "button",
        { type: "button", "data-value": option.id, onclick: () => this.select(axis, option.id) },
        option.button,
      );
      this.buttons[axis].set(option.id, button);
      return button;
    });
    return el(
      "div",
      { class: "hx-var-control", role: "group", "aria-labelledby": labelId },
      el("span", { class: "hx-var-control-label", id: labelId }, title),
      el("div", { class: "hx-var-seg", "data-count": buttons.length }, ...buttons),
    );
  }

  buildLegend() {
    const item = (mark, text) => el("span", { class: "hx-var-legend-item" }, mark, el("span", {}, text));
    const appearances = [...new Map(this.data.variants.map((variant) => [variant.appearance, variant])).values()];
    const population = (id) => this.data.variants.find((variant) => variant.population === id);
    const neutral = (id) => {
      const mark = swatch({ population: id });
      mark.classList.add("is-neutral");
      return mark;
    };
    const line = svg("svg", { class: "hx-var-legend-line", viewBox: "0 0 18 10", width: 18, height: 10, "aria-hidden": "true" });
    svg("line", { x1: 1, y1: 5, x2: 17, y2: 5 }, line);
    return el(
      "div",
      { class: "hx-var-legend" },
      ...appearances.map((variant) =>
        item(swatch({ appearance: variant.appearance, population: "densified" }), variant.appearance),
      ),
      el("span", { class: "hx-var-legend-gap", "aria-hidden": "true" }),
      ...["fixed", "densified"]
        .filter((id) => population(id))
        .map((id) => item(neutral(id), POPULATION_NAMES[id] ?? id)),
      item(line, "Fixed to densified"),
    );
  }

  buildPoint(variant) {
    const point = svg(
      "g",
      {
        class: "hx-var-point",
        tabindex: "0",
        role: "img",
        "data-variant": variant.id,
        "data-appearance": variant.appearance,
        "data-population": variant.population,
      },
      this.pointLayer,
    );
    svg("circle", { class: "hx-var-focus", r: MARKER_RADIUS + 6 }, point);
    svg("path", { class: "hx-var-halo", d: hexagonPath(MARKER_RADIUS + 2.5) }, point);
    svg("path", { class: "hx-var-mark", d: hexagonPath(MARKER_RADIUS) }, point);
    point.addEventListener("focus", () => this.setHot(variant.id, true));
    point.addEventListener("blur", () => this.setHot(null, true));
    this.points.set(variant.id, point);
    const leader = svg("line", { class: "hx-var-leader" }, this.labelLayer);
    const label = svgText(this.labelLayer, "hx-var-point-label", variant.short, {});
    this.labels.set(variant.id, { label, leader });
  }

  bindPointer() {
    const nearest = (event) => {
      if (!this.current) return null;
      const box = this.svg.getBoundingClientRect();
      const x = event.clientX - box.left;
      const y = event.clientY - box.top;
      let best = null;
      for (const point of this.current.points) {
        const distance = Math.hypot(point.x - x, point.y - y);
        if (distance <= HIT_RADIUS && (!best || distance < best.distance)) best = { id: point.id, distance };
      }
      return best?.id ?? null;
    };
    this.svg.addEventListener("pointermove", (event) => {
      if (event.pointerType === "mouse") this.setHot(nearest(event), true);
    });
    this.svg.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "mouse") this.setHot(null, true);
    });
    // On touch screens a tap shows the nearest point's values until the next tap, anywhere on the page.
    this.svg.addEventListener("pointerup", (event) => {
      if (event.pointerType === "mouse") return;
      const id = nearest(event);
      this.pinned = id;
      this.setHot(id, true);
    });
    document.addEventListener("pointerdown", (event) => {
      if (!this.pinned || this.svg.contains(event.target)) return;
      this.pinned = null;
      this.setHot(null, true);
    });
  }

  select(axis, id) {
    if (this.state[axis] === id) return;
    this.state[axis] = id;
    this.updateButtons();
    this.draw(true);
  }

  updateButtons() {
    for (const axis of ["x", "y"]) {
      for (const [id, button] of this.buttons[axis]) button.setAttribute("aria-pressed", String(id === this.state[axis]));
    }
  }

  /** Show `rows` (variant id -> values), described by `description` ("Truck", "Tanks and Temples mean"). */
  update(rows, scope, description, animate) {
    this.rows = rows;
    this.scope = scope;
    this.description = description;
    this.draw(animate);
  }

  font(size, weight = 400) {
    return `${weight} ${size}px ${this.fontFamily}`;
  }

  /** Plot rectangle, type sizes and scales for the current axes. */
  layout(width, x, y) {
    const type = width < COMPACT_WIDTH ? TYPE.compact : TYPE.regular;
    const height = Math.round(clamp(width * 0.6, 250, 340));
    const top = type.title + 20;
    const bottom = height - (type.tick + type.title + 24);
    const ids = this.data.variants.map((variant) => variant.id);
    const yValues = ids.map((id) => this.rows[id][y.id]);
    const yCount = Math.max(3, Math.floor((bottom - top) / 36));
    // Up is always better: LPIPS (lower is better) runs downward.
    const [low, high] = y.better === "lower" ? [top, bottom] : [bottom, top];
    const yScale = makeScale(yValues, { log: false, start: low, end: high, count: yCount });
    const yTexts = yScale.ticks.map((tick) => this.tickText(y, tick));
    const left = Math.ceil(Math.max(...yTexts.map((text) => textWidth(text, this.font(type.tick))))) + 10;
    const right = width - 10;
    const xLog = Boolean(x.log_default);
    const xCount = Math.max(3, Math.floor((right - left) / (xLog ? 62 : 80)));
    const xScale = makeScale(
      ids.map((id) => this.rows[id][x.id]),
      { log: xLog, start: left, end: right, count: xCount },
    );
    return { width, height, type, plot: { left, right, top, bottom }, x: xScale, y: yScale };
  }

  tickText(metric, tick) {
    if (metric.id === "primitives" && tick.value >= 1000) return compactFormat.format(tick.value);
    return formatNumber(tick.value, tick.decimals);
  }

  /** Redraw axes, points, lines and labels; points glide to their new places when `animate`. */
  draw(animate) {
    const width = Math.floor(this.chart.clientWidth);
    if (!this.rows || width <= 0) return;
    this.width = width;
    this.fontFamily = getComputedStyle(this.svg).fontFamily || "sans-serif";
    const x = this.data.metrics.get(this.state.x);
    const y = this.data.metrics.get(this.state.y);
    const frame = this.layout(width, x, y);
    const motion = animate && this.drawn && !reducedMotion.matches;
    this.svg.setAttribute("width", String(width));
    this.svg.setAttribute("height", String(frame.height));
    this.svg.setAttribute("viewBox", `0 0 ${width} ${frame.height}`);
    this.svg.setAttribute("aria-label", `${this.summary(x, y)}. Each variant is listed below with its values.`);
    this.svg.dataset.x = x.id;
    this.svg.dataset.y = y.id;
    this.svg.dataset.xLog = String(frame.x.log);
    const yTitleBox = this.drawAxes(frame, x, y);
    const labelFont = this.font(frame.type.label, 600);
    const points = this.data.variants.map((variant) => {
      const values = this.rows[variant.id];
      const daggered = [x.id, y.id].some((id) => isDaggered(this.data.metrics, id, values, this.scope));
      const text = daggered ? `${variant.short}${DAGGER}` : variant.short;
      return {
        id: variant.id,
        variant,
        x: frame.x.map(values[x.id]),
        y: frame.y.map(values[y.id]),
        r: MARKER_RADIUS,
        text,
        labelWidth: Math.ceil(textWidth(text, labelFont)) + 2,
        xText: values.text[x.id],
        yText: values.text[y.id],
      };
    });
    // Fixed variants keep their initial population, so on the primitives axis they share one position.
    const fixed = this.data.variants.filter((variant) => variant.population === "fixed").map(({ id }) => this.rows[id]);
    const stacked = fixed.length > 1 && fixed.every((row) => row[x.id] === fixed[0][x.id]);
    this.note.hidden = !(x.id === "primitives" && stacked);
    const byId = new Map(points.map((point) => [point.id, point]));
    this.current = { frame, points, byId, x, y };
    for (const point of points) {
      const node = this.points.get(point.id);
      node.style.transition = motion ? "" : "none";
      node.style.transform = `translate(${point.x.toFixed(2)}px, ${point.y.toFixed(2)}px)`;
      node.setAttribute(
        "aria-label",
        `${point.variant.label} (${point.variant.short}): ${y.label} ${point.yText}, ${x.label} ${point.xText}`,
      );
    }
    const lines = [];
    for (const [appearance, line] of this.links) {
      const ends = points.filter((point) => point.variant.appearance === appearance);
      const from = ends.find((point) => point.variant.population === "fixed");
      const to = ends.find((point) => point.variant.population === "densified");
      line.toggleAttribute("hidden", !(from && to));
      if (!from || !to) continue;
      const segment = { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
      for (const [name, value] of Object.entries(segment)) line.setAttribute(name, value.toFixed(2));
      lines.push(segment);
    }
    // Label boxes are as tall as the rendered text box, with the baseline at the font's ascent, so labels placed clear
    // of each other and of the markers also render clear of them.
    const { ascent, descent } = fontBox(labelFont, frame.type.label);
    const lineHeight = Math.ceil(ascent + descent);
    // Labels may use the margin above the plot area, away from the y title and its cue.
    const bounds = { left: frame.plot.left + 2, top: 2, right: width - 2, bottom: frame.plot.bottom - 2 };
    const placements = placeLabels(points, bounds, lineHeight, lines, [yTitleBox]);
    for (const point of points) {
      const { label, leader } = this.labels.get(point.id);
      const placement = placements.get(point.id);
      label.toggleAttribute("hidden", !placement);
      leader.toggleAttribute("hidden", !placement?.leader);
      if (!placement) continue;
      label.textContent = point.text;
      label.setAttribute("x", (placement.box.left + 1).toFixed(1));
      label.setAttribute("y", (placement.box.top + ascent).toFixed(1));
      label.setAttribute("font-size", String(frame.type.label));
      if (placement.leader) {
        const { x1, y1, x2, y2 } = placement.leader;
        for (const [name, value] of Object.entries({ x1, y1, x2, y2 })) leader.setAttribute(name, value.toFixed(1));
      }
    }
    // Lines and labels wait for the points to arrive, then fade in.
    clearTimeout(this.moveTimer);
    if (motion) {
      this.svg.classList.add("is-settling");
      this.moveTimer = setTimeout(() => this.svg.classList.remove("is-settling"), MOVE_MS);
    } else {
      this.svg.classList.remove("is-settling");
    }
    this.drawn = true;
    this.setHot(this.hot, false);
  }

  /** Gridlines, tick labels, axis titles and "better" cues; returns the box of the y title and its cue. */
  drawAxes(frame, x, y) {
    const { plot, type, width, height } = frame;
    const layer = svg("g", {});
    const tickFont = this.font(type.tick);
    for (const tick of frame.y.ticks) {
      const position = crisp(frame.y.map(tick.value));
      if (position < plot.top - 1 || position > plot.bottom + 1) continue;
      svg("line", { class: "hx-var-gridline", x1: plot.left, x2: plot.right, y1: position, y2: position, "data-value": tick.value }, layer);
      svgText(layer, "hx-var-tick", this.tickText(y, tick), {
        x: plot.left - 8,
        y: position,
        dy: "0.35em",
        "text-anchor": "end",
        "font-size": type.tick,
        "data-axis": "y",
        "data-value": tick.value,
      });
    }
    for (const tick of frame.x.ticks) {
      const position = crisp(frame.x.map(tick.value));
      if (position < plot.left - 1 || position > plot.right + 1) continue;
      const text = this.tickText(x, tick);
      const half = textWidth(text, tickFont) / 2;
      svg("line", { class: "hx-var-gridline", x1: position, x2: position, y1: plot.top, y2: plot.bottom, "data-value": tick.value }, layer);
      svgText(layer, "hx-var-tick", text, {
        x: clamp(position, half, width - half),
        y: plot.bottom + type.tick + 7,
        "text-anchor": "middle",
        "font-size": type.tick,
        "data-axis": "x",
        "data-value": tick.value,
      });
    }
    const base = crisp(plot.bottom);
    svg("line", { class: "hx-var-baseline", x1: plot.left, x2: plot.right, y1: base, y2: base }, layer);
    const titleFont = this.font(type.title, 600);
    const yTitle = y.label;
    svgText(layer, "hx-var-axis-title", yTitle, { x: 0, y: type.title, "font-size": type.title });
    const yTitleWidth = textWidth(yTitle, titleFont) + 10;
    const yCueWidth = this.drawCue(layer, yTitleWidth, type.title, "up", type.tick);
    const yTitleBox = rect(0, 0, yTitleWidth + yCueWidth + 6, type.title + 6);
    const xTitle = x.log_default ? `${x.label}, log scale` : x.label;
    const baseline = height - 5;
    let titleLeft = (plot.left + plot.right - textWidth(xTitle, titleFont)) / 2;
    if (x.better === "lower") {
      const cueWidth = this.drawCue(layer, plot.left, baseline, "left", type.tick);
      titleLeft = Math.max(titleLeft, plot.left + cueWidth + 14);
    }
    svgText(layer, "hx-var-axis-title", xTitle, { x: titleLeft, y: baseline, "font-size": type.title });
    this.axisLayer.replaceChildren(layer);
    return yTitleBox;
  }

  /** An arrow and the word "better", starting at `x`; returns its width. */
  drawCue(layer, x, baseline, direction, size) {
    const group = svg("g", { class: "hx-var-cue" }, layer);
    const middle = baseline - size * 0.34;
    svg("path", { class: "hx-var-cue-arrow", d: ARROWS[direction], transform: `translate(${x + 5} ${middle})` }, group);
    svgText(group, "hx-var-cue-text", "better", { x: x + 15, y: baseline, "font-size": size });
    return 15 + textWidth("better", this.font(size));
  }

  summary(x, y) {
    const scale = x.log_default ? " (log scale)" : "";
    return `${y.label} against ${x.label}${scale} for the six Hexels variants: ${this.description}`;
  }

  /** Highlight one variant (null for none) and show its tooltip; `notify` tells the other views. */
  setHot(id, notify) {
    const hot = id ?? this.pinned;
    this.hot = hot;
    for (const [variant, node] of this.points) node.classList.toggle("is-hot", variant === hot);
    this.svg.classList.toggle("has-hot", Boolean(hot));
    this.showTip(hot);
    if (notify) this.onHover(hot);
  }

  /** Highlight from another view (a table row or a video), without a tooltip; null returns to the pinned point. */
  highlight(id) {
    const target = id ?? this.pinned;
    for (const [variant, node] of this.points) node.classList.toggle("is-hot", variant === target);
    this.svg.classList.toggle("has-hot", Boolean(target));
  }

  showTip(id) {
    const point = id && this.current?.byId.get(id);
    this.tip.hidden = !point;
    if (!point) return;
    const { x, y } = this.current;
    const row = (metric, text) =>
      el(
        "div",
        { class: "hx-var-tip-row" },
        el("strong", {}, withUnit(text, metric.unit)),
        el("span", {}, metric.short ?? metric.label),
      );
    this.tip.replaceChildren(
      el(
        "div",
        { class: "hx-var-tip-title" },
        swatch(point.variant),
        el("span", {}, point.variant.label),
        el("span", { class: "hx-var-tag" }, point.variant.short),
      ),
      row(y, point.yText),
      row(x, point.xText),
    );
    const width = this.tip.offsetWidth;
    const height = this.tip.offsetHeight;
    const gap = MARKER_RADIUS + 8;
    let left = point.x + gap;
    if (left + width > this.current.frame.width) left = point.x - gap - width;
    let top = point.y - height - 6;
    if (top < 0) top = point.y + gap;
    this.tip.style.transform = `translate(${Math.round(Math.max(0, left))}px, ${Math.round(top)}px)`;
  }
}

/* ---------- The component ---------- */

/** Wires the scene buttons, the video grid and its playback, the table and the plot together. */
class VariantsPlayer {
  constructor(root, data) {
    this.data = data;
    this.base = mediaBase();
    this.scene = null;
    this.scope = "scene";
    this.savedFrame = 0;
    // Sources attached (active), still loading and restoring savedFrame (loading), and a load or seek that failed and
    // left the error notice up (failed).
    this.active = false;
    this.loading = false;
    this.failed = false;
    this.near = false;
    this.held = false;
    this.missing = false;
    this.loadAbort = null;
    this.scrub = { resume: false, target: null, busy: false };
    this.nearTimer = 0;
    this.releaseTimer = 0;
    this.drawnOnce = false;

    this.picker = new ScenePicker(data, (sceneId) => this.selectScene(sceneId));
    this.grid = new VideoGrid(data, {
      onPosterError: (url) => this.onPosterError(url),
      onVideoError: (video) => {
        if (video.getAttribute("src")) this.showVideoError(new Error(`Video failed to load: ${video.currentSrc || video.src}`));
      },
    });
    this.sync = new SyncedGroup({
      onFrame: (frame) => this.controls.setFrame(frame, this.scene.frames),
      onBlocked: () => playback.stop(this.group),
      onError: (error) => this.showVideoError(error),
    });
    this.sync.setVideos(this.grid.videos());
    this.controls = new Controls({
      onTogglePlay: () => this.togglePlay(),
      onStep: (delta) => this.holdAt(this.shownFrame() + delta),
      onStepTo: (frame) => this.holdAt(frame),
      onScrubStart: () => this.scrubStart(),
      onScrub: (frame) => this.scrubTo(frame),
      onScrubEnd: () => this.scrubEnd(),
    });
    const hover = (id) => this.highlight(id);
    this.table = new MetricsTable(data, hover);
    this.plot = new TradeoffPlot(data, { onHover: hover });
    this.scopeButtons = new Map();
    this.title = el("h3", { class: "hx-var-results-title" });
    this.status = el("p", { class: "is-sr-only", role: "status" });
    this.help = el("p", { class: "hx-var-help" }, this.helpText());

    this.element = el(
      "div",
      { class: `hx-var${mouse ? "" : " is-touch"}` },
      this.picker.element,
      el("div", { class: "hx-var-player" }, this.grid.element, this.controls.element, this.help),
      this.buildKey(),
      el(
        "div",
        { class: "hx-var-results" },
        el("div", { class: "hx-var-results-head" }, this.title, this.buildScope()),
        el("div", { class: "hx-var-results-body" }, this.table.element, this.plot.element),
        this.buildAbout(),
      ),
      this.status,
    );
    root.replaceChildren(this.element);
    this.group = playback.register({
      zone: root.closest("section") ?? root,
      view: this.grid.element,
      // Hovering never ends an explicit pause, and a failed load waits for the visitor (play or another scene) instead
      // of playing under its notice.
      hoverable: () => this.canPlay() && !this.held && !this.failed,
      start: () => this.startPlayback(),
      stop: () => this.stopPlayback(),
    });
    this.bindGrid();
    this.selectScene(data.opening.id);
    this.observeNear();
  }

  /** The appearance and population definitions of the data file, under the controls. */
  buildKey() {
    const { appearance, population } = this.data.definitions;
    const line = (term, text) =>
      text ? el("p", {}, el("span", { class: "hx-var-key-term" }, term), " ", text) : null;
    return el("div", { class: "hx-var-key" }, line("Appearance", appearance), line("Population", population));
  }

  buildScope() {
    const buttons = SCOPES.map((scope) => {
      const button = el(
        "button",
        { type: "button", "aria-pressed": String(scope.id === this.scope), onclick: () => this.setScope(scope.id) },
        scope.button,
      );
      this.scopeButtons.set(scope.id, button);
      return button;
    });
    return el(
      "div",
      { class: "hx-var-control hx-var-scope", role: "group", "aria-labelledby": "hx-var-scope-label" },
      el("span", { class: "hx-var-control-label", id: "hx-var-scope-label" }, "Numbers for"),
      el("div", { class: "hx-var-seg", "data-count": buttons.length }, ...buttons),
    );
  }

  /** How the numbers are measured and why these scenes, folded away under the plot. */
  buildAbout() {
    const { definitions } = this.data;
    const terms = [
      ["Model memory", definitions.memory_mb],
      ["Peak VRAM", definitions.vram_gib],
      ["Training time", definitions.train_min],
      ["PSNR, SSIM and LPIPS", definitions.quality],
      ["FPS", definitions.fps],
      ["Primitives", definitions.primitives],
    ].filter(([, text]) => typeof text === "string" && text);
    const list = el("dl", {}, ...terms.flatMap(([term, text]) => [el("dt", {}, term), el("dd", {}, text)]));
    return el(
      "details",
      { class: "hx-var-about" },
      el("summary", {}, "How the numbers are measured"),
      list,
      ...this.data.notes.map((note) => el("p", {}, note)),
    );
  }

  helpText() {
    const keys = mouse ? " Arrow keys help move between frames." : "";
    return hoverPlays()
      ? `The six videos play in sync while the pointer is over this section. Click them to pause or play.${keys}`
      : `${mouse ? "Click" : "Tap"} the videos to play or pause all six in sync.${keys}`;
  }

  // Selection ---------------------------------------------------------------------------

  /** Select a scene by its id ("tanks_and_temples/Truck"); keeps the play state. */
  selectScene(sceneId) {
    const scene = this.data.scenes.find((item) => item.id === sceneId);
    if (!scene) {
      console.warn(`Unknown scene ${sceneId}`);
      return false;
    }
    this.picker.show(scene.id);
    if (scene === this.scene) return true;
    this.scene = scene;
    this.savedFrame = 0;
    this.missing = false;
    this.failed = false;
    this.grid.setScene(scene);
    this.element.style.setProperty("--hx-var-aspect", (scene.grid_width / scene.grid_height).toFixed(4));
    this.sync.setClip(scene.frame_rate, scene.frames);
    this.controls.setFrame(0, scene.frames);
    this.grid.element.setAttribute(
      "aria-label",
      `Six Hexels variants on ${scene.label} (${this.datasetLabel(scene)}), playing in sync. Space plays or pauses; left and right arrow keys step frames.`,
    );
    this.renderNumbers(this.drawnOnce);
    this.drawnOnce = true;
    if (!this.base) {
      this.grid.setNotice(NO_MEDIA_TEXT);
      this.updatePlayState();
      return true;
    }
    // A clip the media build has not made yet has no bytes: nothing of the scene is requested.
    this.missing = this.data.variants.some((variant) => scene.videos[variant.id].bytes === 0);
    if (this.missing) {
      if (this.active) this.releaseSources(true);
      this.savedFrame = 0;
      playback.stop(this.group);
      this.grid.clearPosters();
      this.grid.setNotice(MISSING_TEXT);
      this.updatePlayState();
      return true;
    }
    this.grid.setNotice(null);
    this.updatePlayState();
    if (this.active) this.attachSources();
    else this.showPosters();
    return true;
  }

  setScope(scope) {
    if (scope === this.scope) return;
    this.scope = scope;
    for (const [id, button] of this.scopeButtons) button.setAttribute("aria-pressed", String(id === scope));
    this.renderNumbers(true);
  }

  datasetLabel(scene) {
    return this.data.datasets.find((dataset) => dataset.id === scene.dataset)?.label ?? scene.dataset;
  }

  /** The table, the plot and the title for the scene or its dataset mean. */
  renderNumbers(animate) {
    const scene = this.scene;
    const dataset = this.datasetLabel(scene);
    let rows;
    let description;
    this.title.replaceChildren();
    if (this.scope === "mean") {
      rows = this.data.means[scene.dataset];
      const count = rows[this.data.variants[0].id].scenes;
      description = `the ${dataset} mean of ${count} scenes`;
      this.title.append(dataset, el("span", { class: "hx-var-results-sub" }, `mean of ${count} scenes`));
    } else {
      rows = scene.values;
      description = `${scene.label} (${dataset})`;
      this.title.append(scene.label, el("span", { class: "hx-var-results-sub" }, scene.group_label ?? dataset));
    }
    this.table.render(rows, this.scope, `Numbers of the six Hexels variants for ${description}`);
    this.plot.update(rows, this.scope, description, animate);
    this.status.textContent = `Showing ${description}.`;
  }

  /** Highlight one variant in the grid, the table and the plot (null for none). */
  highlight(id) {
    this.grid.highlight(id);
    this.table.highlight(id);
    this.plot.highlight(id);
  }

  // Media sources -----------------------------------------------------------------------

  videoUrl(id) {
    return mediaUrl(this.scene.videos[id].key);
  }

  posterUrl(id) {
    return mediaUrl(this.scene.videos[id].poster);
  }

  /** True when the grid can load and play the current scene. */
  canPlay() {
    return Boolean(this.base) && !this.missing;
  }

  showPosters() {
    if (!this.near || !this.canPlay()) return;
    for (const variant of this.data.variants) this.grid.setPoster(variant.id, this.posterUrl(variant.id));
  }

  /** A poster of the current scene that fails to load means its media are missing: show a notice. */
  onPosterError(url) {
    const shown = this.data.variants.some((variant) => this.posterUrl(variant.id) === url);
    if (!shown || this.active) return;
    this.missing = true;
    this.grid.clearPosters();
    this.grid.setNotice(MISSING_TEXT);
    playback.stop(this.group);
    this.updatePlayState();
  }

  /**
   * Load the current scene into all six videos and restore the saved frame; playback waits until then. Frame steps,
   * keys and scrubbing during the load move savedFrame, which the restore reads once the videos have loaded.
   */
  async attachSources() {
    this.loadAbort?.abort();
    const abort = new AbortController();
    this.loadAbort = abort;
    this.active = true;
    this.loading = true;
    this.failed = false;
    this.sync.suspend();
    this.grid.setNotice(null);
    this.showPosters();
    const videos = this.grid.videos();
    for (const video of videos) {
      video.src = this.videoUrl(video.dataset.variant);
      // iOS WebKit caps preload="auto" at metadata until play() or load(): without load() no frame would ever arrive
      // and the grid would never resume.
      video.load();
    }
    this.sync.setVideos(videos);
    try {
      await Promise.all(videos.map((video) => whenLoaded(video, abort.signal)));
      await this.sync.seekFrame(this.savedFrame, abort.signal);
    } catch (error) {
      if (!abort.signal.aborted) {
        this.loading = false;
        this.showVideoError(error);
      }
      return;
    }
    if (abort.signal.aborted) return;
    this.loading = false;
    this.controls.setFrame(this.sync.currentFrame(), this.scene.frames);
    this.sync.resume();
  }

  /** The frame the grid shows, or will show once its videos have loaded: the clock's, else the saved frame. */
  shownFrame() {
    return this.active && !this.loading ? this.sync.currentFrame() : this.savedFrame;
  }

  /** Free the decoders, keeping the frame for the next load; `force` also frees them while playing. */
  releaseSources(force = false) {
    if (!this.active || (playback.isPlaying(this.group) && !force)) return;
    this.savedFrame = this.shownFrame();
    this.active = false;
    this.loading = false;
    this.loadAbort?.abort();
    this.sync.suspend();
    for (const video of this.grid.videos()) releaseVideo(video);
    // A load error is retried on the next start; a scene without media keeps its notice.
    if (!this.missing) {
      this.failed = false;
      this.grid.setNotice(null);
      this.updatePlayState();
    }
  }

  /** Cover the grid with an error notice and stop playback until the visitor plays or picks another scene. */
  showVideoError(error) {
    console.warn(error);
    this.failed = true;
    playback.stop(this.group);
    this.sync.stop();
    this.grid.setNotice(ERROR_TEXT);
    this.updatePlayState();
  }

  // Playback ------------------------------------------------------------------------------

  /** Called by the playback manager: load the videos if needed and play them. */
  startPlayback() {
    this.held = false;
    if (!this.canPlay()) return;
    this.sync.play();
    // Playing after a failed load tries it once more.
    if (!this.active || this.failed) this.attachSources();
    this.updatePlayState();
  }

  /** Called by the playback manager: pause all six on the same frame. */
  stopPlayback() {
    const loaded = this.active && (this.sync.master?.readyState ?? 0) >= HAVE_METADATA;
    if (loaded) {
      this.pauseAt(this.shownFrame());
      return;
    }
    this.sync.stop();
    this.updatePlayState();
  }

  /** The play button, space and clicks or taps on the videos: play, or pause and hold the frame. */
  togglePlay() {
    if (!this.canPlay()) return;
    if (playback.isPlaying(this.group)) {
      this.held = true;
      playback.stop(this.group);
    } else {
      playback.play(this.group);
    }
  }

  /** Hold frame `frame` (frame steps and keys), loading the videos first when needed. */
  holdAt(frame) {
    if (!this.canPlay()) return Promise.resolve();
    this.held = true;
    playback.stop(this.group);
    this.savedFrame = wrapFrame(frame, this.scene.frames);
    if (this.active) return this.pauseAt(frame);
    this.controls.setFrame(this.savedFrame, this.scene.frames);
    this.updatePlayState();
    return this.attachSources();
  }

  /** Pause all six on `frame`; the counter shows it at once, even while the videos still load. */
  async pauseAt(frame) {
    const target = wrapFrame(frame, this.scene.frames);
    const seeking = this.sync.pauseAt(target);
    this.updatePlayState();
    this.controls.setFrame(target, this.scene.frames);
    try {
      await seeking;
    } catch (error) {
      this.showVideoError(error);
      return;
    }
    this.controls.setFrame(this.sync.currentFrame(), this.scene.frames);
  }

  scrubStart() {
    this.scrub.resume = playback.isPlaying(this.group);
    this.held = true;
    playback.stop(this.group);
    this.sync.stop();
    this.updatePlayState();
  }

  /** Seek to `frame`, coalescing requests while a seek is in flight; a load in flight restores this frame. */
  async scrubTo(frame) {
    this.controls.setFrame(frame, this.scene.frames);
    this.savedFrame = frame;
    if (!this.active) return;
    this.scrub.target = frame;
    if (this.scrub.busy) return;
    this.scrub.busy = true;
    while (this.scrub.target !== null) {
      const target = this.scrub.target;
      this.scrub.target = null;
      try {
        await this.sync.seekFrame(target);
      } catch (error) {
        this.showVideoError(error);
        break;
      }
    }
    this.scrub.busy = false;
  }

  scrubEnd() {
    if (this.scrub.resume) playback.play(this.group);
    else if (!this.active && this.canPlay()) this.attachSources();
  }

  /** The play button, the cue and the help line follow the play intent; without playable media they step aside. */
  updatePlayState() {
    const playing = this.sync.wantPlay;
    this.controls.setPlaying(playing);
    this.controls.setEnabled(this.canPlay());
    this.grid.setCue(playing || !this.canPlay() || this.failed ? null : this.cueText());
    this.grid.element.classList.toggle("is-paused", !playing);
    this.help.hidden = !this.canPlay();
  }

  /** How to start playback while it is paused: hovering, unless motion is reduced or the visitor holds a frame. */
  cueText() {
    if (!mouse) return "Tap to play";
    return hoverPlays() && !this.held ? "Hover to play" : "Click to play";
  }

  bindGrid() {
    const stage = this.grid.element;
    stage.addEventListener("click", () => this.togglePlay());
    stage.addEventListener("keydown", (event) => {
      if (event.target !== stage || !this.canPlay()) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        this.holdAt(this.shownFrame() + (event.key === "ArrowLeft" ? -1 : 1));
      } else if (event.key === " " || event.key === "k") {
        event.preventDefault();
        this.togglePlay();
      }
    });
    for (const [id, { tile }] of this.grid.tiles) {
      tile.addEventListener("pointerenter", (event) => {
        if (event.pointerType === "mouse") this.highlight(id);
      });
      tile.addEventListener("pointerleave", (event) => {
        if (event.pointerType === "mouse") this.highlight(null);
      });
    }
  }

  // Visibility ------------------------------------------------------------------------------

  /**
   * Once the grid has stayed near the viewport for NEAR_SETTLE_MS, or the tab with it near becomes visible again,
   * show the posters and load the videos when needed (preload); free the decoders shortly after the grid moves away
   * or the tab is hidden. Playing and pausing is the playback manager's job.
   */
  observeNear() {
    watchNear(this.grid.element, (near) => {
      this.near = near;
      clearTimeout(this.nearTimer);
      if (near) this.nearTimer = setTimeout(() => this.preload(), NEAR_SETTLE_MS);
      this.updateRelease();
    });
    document.addEventListener("visibilitychange", () => {
      this.preload();
      this.updateRelease();
    });
  }

  /**
   * For a visible grid near the viewport whose videos were released: show the posters, and load the videos when
   * hovering can start them (a mouse, without reduced motion) or they must show a frame the posters (frame 0) do not,
   * a held frame or one saved when they were freed. Touch screens and reduced motion load nothing before a tap or
   * click.
   */
  preload() {
    if (!this.near || this.active || document.visibilityState !== "visible") return;
    this.showPosters();
    if (this.canPlay() && (hoverPlays() || this.held || this.savedFrame !== 0)) this.attachSources();
  }

  updateRelease() {
    clearTimeout(this.releaseTimer);
    if (this.near && document.visibilityState === "visible") return;
    this.releaseTimer = setTimeout(() => this.releaseSources(), RELEASE_DELAY_MS);
  }
}

async function initVariants(root) {
  const data = parseData(await loadJSON(root.dataset.src));
  return new VariantsPlayer(root, data);
}

const root = document.getElementById("variants-root");
const ready = root
  ? initVariants(root).catch((error) => {
      console.error("The Hexels variants could not start", error);
      root.replaceChildren(el("p", { class: "hx-var-unavailable" }, LOAD_ERROR_TEXT));
      return null;
    })
  : Promise.resolve(null);

window.HexelsVariants = {
  selectScene: (sceneId) => ready.then((player) => player?.selectScene(sceneId) ?? false),
};
