/**
 * Method comparison player.
 *
 * Mount: <div id="compare-root" data-media="static/data/nvs_media.json"
 *             data-metrics="static/data/nvs_metrics.json">
 *
 * Builds a scene panel (dataset tabs and scene buttons), a method panel (left and right
 * buttons), a stage with two synchronized videos split by a draggable divider, playback
 * controls with frame stepping, close-ups of every method when paused, the per-scene metrics
 * table and the optional viewing tips of static/data/tips.json (a scene tip can jump to its frame and
 * method pair, and "Show me where" also frames its region, x, y, w and h normalized to the video frame,
 * in the close-ups and rings it on the stage). Playback goes through the playback manager
 * (playback.js) as a hover group whose zone is the whole section: with a mouse the videos play while the
 * pointer rests on the section and pause when it leaves, and they load once the stage stays near the
 * viewport, so hovering starts them at once. On touch screens and under prefers-reduced-motion only a tap
 * or click on the stage or the play button plays, and nothing but the posters loads before. An explicit
 * pause (a click or tap, the play button, space, a frame step, scrubbing or a tip's buttons) holds the
 * frame until the visitor plays again, also while hovering and across later visits of the section; only a
 * held frame fills the close-ups, which show dimmed under a notice otherwise.
 * Public API: window.HexelsCompare = { selectScene(dataset, scene), selectMethods(left, right) };
 * the document event "hexels:select-scene" selects a scene and scrolls the player into view.
 */
import { loadJSON, loadTips, mediaBase, mediaUrl, tipText, watchNear } from "./media.js";
import { hasMouse, hoverPlays, playback } from "./playback.js";
import {
  SyncedPair,
  frameTime,
  releaseVideo,
  seekAndPresent,
  whenLoaded,
  whenPlayable,
  whenSeeked,
  wrapFrame,
} from "./video-sync.js";

const NO_MEDIA_TEXT = "Videos will appear here once the media is hosted.";
const MISSING_TEXT = "The videos of this scene are not available.";
const ERROR_TEXT = "This video could not be loaded. Please try another scene or method.";
const CLOSEUP_NOTE = "Hover over the paused video to move the close-ups; scroll to zoom.";
const CLOSEUP_NOTICE = "Pause the video to see close-up comparisons.";
// Paused without a held frame (the pointer left the section, or the video has not played yet): only a held frame has
// close-ups.
const CLOSEUP_NOTICE_MANUAL = "Step to a frame, or play and pause the video, to see close-up comparisons.";
const REFERENCE_GPU = "RTX A5000";
const DAGGER = "†";
const HARDWARE_COLUMNS = new Set(["fps", "vram_gib"]);
const SPLIT_KEY_STEP = 2;
const ZOOM_MIN = 2;
const ZOOM_MAX = 12;
const ZOOM_DEFAULT = 3;
const WHEEL_ZOOM_RATE = 0.0015;
const CLOSEUP_LOADERS = 3;
const CAPTURE_DELAY_MS = 150;
const RELEASE_DELAY_MS = 3000;
// The stage must stay near the viewport this long before its media load, so that a smooth scroll that only passes
// it (the BibTeX button's jump to the end of the page) loads nothing.
const NEAR_SETTLE_MS = 250;
const DRAG_THRESHOLD_PX = 4;
const SPOT_MS = 4000;
const SPOT_ENTRANCE_MS = 350;
const SPEEDS = [1, 0.5];
const SIDES = ["left", "right"];
// The part of the frame a region's centre lies in, by thirds: PLACES[row][column].
const PLACES = [
  ["top left", "top", "top right"],
  ["left side", "center", "right side"],
  ["bottom left", "bottom", "bottom right"],
];
// The player opens on garden; a manifest without garden opens on its first scene.
const OPENING_SCENE = { dataset: "mipnerf360", scene: "garden" };

const mouse = hasMouse();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

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

function icon(name) {
  return el("i", { class: `fa-solid fa-${name}`, "aria-hidden": "true" });
}

function dot() {
  return el("span", { class: "hx-cmp-dot", "aria-hidden": "true" });
}

function shortLabel(method) {
  return method.short ?? method.label;
}

/** A "Tip:" paragraph, hidden while it has no text. */
function tipParagraph(className) {
  return el("p", { class: `hx-tip ${className}`, hidden: true });
}

/** Show `text` after a "Tip:" label, followed by its buttons, which wrap together. */
function setTip(paragraph, text, actions = []) {
  paragraph.hidden = !text;
  const buttons = actions.length ? [" ", el("span", { class: "hx-tip-actions" }, ...actions)] : [];
  paragraph.replaceChildren(...(text ? [el("strong", {}, "Tip:"), ` ${text}`, ...buttons] : []));
}

function tipButton(glyph, label, onclick, className = "hx-tip-action") {
  return el("button", { type: "button", class: className, onclick }, icon(glyph), ` ${label}`);
}

/** A tip's region ({x, y, w, h} normalized to the frame, x and y at its top left) or null; reports a bad one. */
function tipRegion(region, key) {
  if (region === undefined || region === null) return null;
  const { x, y, w, h } = region;
  const inside = (start, size) => start >= 0 && size > 0 && start + size <= 1 + 1e-6;
  if ([x, y, w, h].every(Number.isFinite) && inside(x, w) && inside(y, h)) return { x, y, w, h };
  console.warn(`The tip region of ${key} is not a box inside the frame`, region);
  return null;
}

/** Where a region lies in the frame, in words ("top left", "center"). */
function regionPlace(region) {
  const third = (value) => clamp(Math.floor(value * 3), 0, 2);
  return PLACES[third(region.y + region.h / 2)][third(region.x + region.w / 2)];
}

function percent(fraction) {
  return `${(fraction * 100).toFixed(4)}%`;
}

/** The instructions under the player: hover with a mouse; a click or tap under prefers-reduced-motion and on touch. */
function helpText() {
  const help = {
    hover: "Plays while the pointer is over this section. Click to pause, then hover for close-ups. Drag the divider to compare; arrow keys help move between frames.",
    mouse: "Click to play or pause; while paused, hover for close-ups. Drag the divider to compare; arrow keys help move between frames.",
    touch: "Tap to play or pause, and drag the divider to compare.",
  };
  return help[hoverPlays() ? "hover" : mouse ? "mouse" : "touch"];
}

/** Dataset tabs and a wrapping grid of scene buttons for the active dataset. */
class ScenePanel {
  constructor(datasets, onSelect) {
    this.datasets = datasets;
    this.onSelect = onSelect;
    this.tabs = new Map();
    this.grids = new Map();
    this.buttons = new Map();
    this.lastScene = new Map();
    const list = el("ul", { role: "tablist", "aria-label": "Novel view synthesis dataset" });
    for (const dataset of datasets) {
      const link = el(
        "a",
        {
          role: "tab",
          tabindex: "-1",
          "aria-selected": "false",
          onclick: () => this.pickDataset(dataset.id),
          onkeydown: (event) => this.onTabKey(event, dataset.id),
        },
        // One flex item, so the space before the count survives (Bulma's tab links are flex containers).
        el("span", {}, dataset.label, el("span", { class: "hx-cmp-count" }, ` (${dataset.scenes.length})`)),
      );
      const item = el("li", {}, link);
      this.tabs.set(dataset.id, { item, link });
      list.append(item);
      this.grids.set(dataset.id, this.buildGrid(dataset));
    }
    this.element = el(
      "div",
      { class: "hx-cmp-scenes" },
      el("div", { class: "tabs is-toggle is-toggle-rounded is-small is-centered hx-cmp-tabs" }, list),
      ...this.grids.values(),
    );
  }

  buildGrid(dataset) {
    const grid = el("div", { class: "hx-cmp-scene-grid", role: "tabpanel", "aria-label": `${dataset.label} scenes` });
    for (const scene of dataset.scenes) {
      const button = el(
        "button",
        {
          type: "button",
          class: "hx-cmp-scene",
          "aria-pressed": "false",
          onclick: () => this.onSelect(dataset.id, scene.id),
        },
        el("img", { loading: "lazy", decoding: "async", width: "96", height: "60", alt: "", src: scene.thumb }),
        el("span", { class: "hx-cmp-scene-name" }, scene.label),
      );
      this.buttons.set(`${dataset.id}/${scene.id}`, button);
      grid.append(button);
    }
    return grid;
  }

  /** Switch to a dataset, returning to the scene last chosen there (or its first scene). */
  pickDataset(datasetId) {
    const dataset = this.datasets.find((item) => item.id === datasetId);
    this.onSelect(datasetId, this.lastScene.get(datasetId) ?? dataset.scenes[0].id);
  }

  onTabKey(event, datasetId) {
    const ids = this.datasets.map((dataset) => dataset.id);
    const index = ids.indexOf(datasetId);
    const moves = { ArrowRight: 1, ArrowLeft: -1 };
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.pickDataset(datasetId);
    } else if (event.key in moves) {
      event.preventDefault();
      const next = ids[(index + moves[event.key] + ids.length) % ids.length];
      this.pickDataset(next);
      this.tabs.get(next).link.focus();
    }
  }

  /** Mark a scene as current and show the scenes of its dataset. */
  show(datasetId, sceneId) {
    this.lastScene.set(datasetId, sceneId);
    for (const [id, { item, link }] of this.tabs) {
      const active = id === datasetId;
      item.classList.toggle("is-active", active);
      link.setAttribute("aria-selected", String(active));
      link.tabIndex = active ? 0 : -1;
      this.grids.get(id).hidden = !active;
    }
    for (const [key, button] of this.buttons) {
      button.setAttribute("aria-pressed", String(key === `${datasetId}/${sceneId}`));
    }
  }
}

/** Two rows of method buttons, one for each side of the divider. */
class MethodPanel {
  constructor(methods, onPick) {
    this.rows = {};
    const rows = SIDES.map((side) => {
      const name = side === "left" ? "Left" : "Right";
      const buttons = new Map();
      const group = el("div", { class: "hx-cmp-method-buttons", role: "group", "aria-label": `${name} method` });
      for (const method of methods) {
        const button = el(
          "button",
          {
            type: "button",
            class: "hx-cmp-method",
            "data-method": method.id,
            "aria-pressed": "false",
            title: method.short ? method.label : null,
            onclick: () => onPick(side, method.id),
          },
          dot(),
          el("span", {}, shortLabel(method)),
        );
        buttons.set(method.id, button);
        group.append(button);
      }
      this.rows[side] = buttons;
      return el("div", { class: "hx-cmp-method-row" }, el("span", { class: "hx-cmp-row-label" }, name), group);
    });
    this.element = el("div", { class: "hx-cmp-methods" }, ...rows);
  }

  update(selection) {
    for (const side of SIDES) {
      for (const [id, button] of this.rows[side]) button.setAttribute("aria-pressed", String(id === selection[side]));
      this.reveal(this.rows[side].get(selection[side]));
    }
  }

  /** Scroll a row that overflows (phones) so its pressed button is visible, clear of the row's faded end. */
  reveal(button) {
    const group = button.parentElement;
    if (group.scrollWidth <= group.clientWidth) return;
    // compare.css fades the row out over its right padding.
    const fade = parseFloat(getComputedStyle(group).paddingRight);
    const start = button.getBoundingClientRect().left - group.getBoundingClientRect().left + group.scrollLeft;
    const end = start + button.offsetWidth + fade + 8;
    const left = Math.min(start - 8, Math.max(group.scrollLeft, end - group.clientWidth));
    group.scrollTo({ left, behavior: reducedMotion ? "auto" : "smooth" });
  }
}

/**
 * The two stacked videos over their poster images, the divider, corner labels, magnifier outline,
 * cue and notices. A video without data is transparent, so its poster shows until the first frame
 * and again after the video is released; there is no loading animation.
 */
class Stage {
  constructor({ onVideoError, onPosterError }) {
    this.onVideoError = onVideoError;
    this.posters = { left: this.createPoster("left", onPosterError), right: this.createPoster("right", onPosterError) };
    this.videos = { left: this.createVideo("left"), right: this.createVideo("right") };
    this.tags = {
      left: el("span", { class: "hx-cmp-tag hx-cmp-tag-left" }),
      right: el("span", { class: "hx-cmp-tag hx-cmp-tag-right" }),
    };
    this.handle = el(
      "div",
      {
        class: "hx-cmp-handle",
        role: "slider",
        tabindex: "0",
        "aria-label": "Divider position",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
      },
      icon("arrows-left-right"),
    );
    this.spot = el("div", { class: "hx-cmp-spot", role: "img" });
    this.magnifier = el("div", { class: "hx-cmp-magnifier", hidden: true });
    this.cue = el("span", { class: "hx-hint hx-cmp-cue", "aria-hidden": "true", hidden: true });
    this.notice = el("div", { class: "hx-cmp-notice", hidden: true });
    this.element = el(
      "div",
      { class: "hx-cmp-stage", tabindex: "0", role: "group", "aria-roledescription": "video comparison" },
      this.posters.left,
      this.posters.right,
      this.videos.left,
      this.videos.right,
      el("div", { class: "hx-cmp-divider", "aria-hidden": "true" }),
      this.handle,
      this.tags.left,
      this.tags.right,
      this.spot,
      this.magnifier,
      this.cue,
      this.notice,
    );
    this.split = 50;
    this.spotTimer = 0;
    this.watchers = null;
    this.bindVideos();
  }

  createPoster(side, onError) {
    const poster = el("img", { class: `hx-cmp-poster hx-cmp-poster-${side}`, alt: "", decoding: "async", "aria-hidden": "true" });
    poster.addEventListener("error", () => {
      const url = poster.getAttribute("src");
      poster.removeAttribute("src");
      onError(url);
    });
    return poster;
  }

  /** Show the poster at `url` on `side`; the previous image stays until the new one has loaded. */
  setPoster(side, url) {
    if (url && this.posters[side].getAttribute("src") !== url) this.posters[side].src = url;
  }

  createVideo(side) {
    const video = el("video", {
      class: `hx-cmp-video hx-cmp-video-${side}`,
      muted: true,
      loop: true,
      playsinline: true,
      preload: "auto",
      crossorigin: "anonymous",
      disablepictureinpicture: true,
      "aria-hidden": "true",
    });
    video.muted = true;
    return video;
  }

  /** Watch the current elements for errors. */
  bindVideos() {
    this.watchers?.abort();
    this.watchers = new AbortController();
    for (const video of Object.values(this.videos)) {
      video.addEventListener("error", () => this.onVideoError(video), { signal: this.watchers.signal });
    }
  }

  /** Size the stage for a scene and show its thumbnail behind the videos while they load. */
  setScene(scene) {
    this.element.style.aspectRatio = `${scene.width} / ${scene.height}`;
    this.element.style.backgroundImage = `url("${scene.thumb}")`;
    for (const poster of Object.values(this.posters)) Object.assign(poster, { width: scene.width, height: scene.height });
  }

  setSplit(percent) {
    this.split = clamp(percent, 0, 100);
    this.element.style.setProperty("--hx-split", `${this.split}%`);
    this.handle.setAttribute("aria-valuenow", String(Math.round(this.split)));
    this.updateTagCover();
  }

  /** Fade a corner label out while the divider passes over it. */
  updateTagCover() {
    const x = (this.split / 100) * this.element.clientWidth;
    const left = this.tags.left;
    const right = this.tags.right;
    left.classList.toggle("is-covered", x < left.offsetLeft + left.offsetWidth + 6);
    right.classList.toggle("is-covered", x > right.offsetLeft - 6);
  }

  /** Label both sides with the method names; the narrowest phones show the short names instead (compare.css). */
  setLabels(methods) {
    for (const side of SIDES) {
      const tag = this.tags[side];
      tag.dataset.method = methods[side].id;
      tag.replaceChildren(
        dot(),
        el("span", { class: "hx-cmp-tag-name" }, methods[side].label),
        el("span", { class: "hx-cmp-tag-short" }, shortLabel(methods[side])),
      );
    }
    this.updateTagCover();
  }

  setDescription(text) {
    this.element.setAttribute("aria-label", text);
  }

  /** Show how to start playback ("Hover to play", "Tap to play"), or hide the cue with null. */
  setCue(text) {
    this.cue.hidden = !text;
    if (text) this.cue.replaceChildren(icon("play"), ` ${text}`);
  }

  setDragging(dragging) {
    this.element.classList.toggle("is-dragging", dragging);
  }

  /** Show `text` instead of the videos, or clear the notice with null. */
  setNotice(text) {
    this.notice.hidden = !text;
    this.notice.replaceChildren(...(text ? [icon("film"), el("p", {}, text)] : []));
    this.element.classList.toggle("has-notice", Boolean(text));
  }

  /** Position the magnifier outline (stage pixels), or hide it with null. */
  placeMagnifier(view) {
    this.magnifier.hidden = !view;
    if (!view) return;
    const { style } = this.magnifier;
    style.width = `${view.side}px`;
    style.height = `${view.side}px`;
    style.transform = `translate(${view.x - view.side / 2}px, ${view.y - view.side / 2}px)`;
  }

  /**
   * Ring `region` (normalized to the frame) and dim the rest of the frame for SPOT_MS, then fade out. While
   * the ring shows, the overlays that could cover the region (labels, handle, cue, magnifier) step aside.
   */
  showSpot(region, label) {
    const { spot } = this;
    // Placed by its centre (the stylesheet translates it by half its size), so a ring kept at its minimum size
    // around a tiny region stays centred on it.
    Object.assign(spot.style, {
      left: percent(region.x + region.w / 2),
      top: percent(region.y + region.h / 2),
      width: percent(region.w),
      height: percent(region.h),
    });
    spot.setAttribute("aria-label", label);
    this.element.classList.add("has-spot");
    if (!reducedMotion) {
      spot.animate([{ opacity: 0, scale: 1.3 }, { opacity: 1, scale: 1 }], {
        duration: SPOT_ENTRANCE_MS,
        easing: "ease-out",
      });
    }
    clearTimeout(this.spotTimer);
    this.spotTimer = setTimeout(() => this.hideSpot(), SPOT_MS);
  }

  hideSpot() {
    clearTimeout(this.spotTimer);
    this.element.classList.remove("has-spot");
  }

  /** Exchange the two elements between the sides without reloading them. */
  swapSides() {
    const { left, right } = this.videos;
    left.classList.replace("hx-cmp-video-left", "hx-cmp-video-right");
    right.classList.replace("hx-cmp-video-right", "hx-cmp-video-left");
    this.videos = { left: right, right: left };
    this.bindVideos();
  }

  /** Add a video that loads hidden behind the current one on `side`. */
  addPending(side, video) {
    video.classList.add("is-pending");
    this.videos[side].before(video);
  }

  dropPending(video) {
    releaseVideo(video);
    video.remove();
  }

  /** Make a loaded pending video the visible one on `side` and free the old element. */
  commit(side, video) {
    const old = this.videos[side];
    video.classList.remove("is-pending");
    this.videos[side] = video;
    releaseVideo(old);
    old.remove();
    this.bindVideos();
  }
}

/** Play, frame stepping, a scrubber with a frame counter, and a speed toggle. */
class Controls {
  constructor(handlers) {
    this.handlers = handlers;
    this.frames = 1;
    this.playButton = el("button", { type: "button", class: "hx-cmp-play", onclick: handlers.onTogglePlay });
    const stepButton = (label, delta, glyph) =>
      el(
        "button",
        {
          type: "button",
          class: "hx-cmp-icon",
          "aria-label": label,
          title: label,
          onclick: () => handlers.onStep(delta),
        },
        icon(glyph),
      );
    this.stepButtons = [
      stepButton("Previous frame", -1, "backward-step"),
      stepButton("Next frame", 1, "forward-step"),
    ];
    this.scrubber = el(
      "div",
      { class: "hx-cmp-scrubber", role: "slider", tabindex: "0", "aria-label": "Frame", "aria-valuemin": "1" },
      el("div", { class: "hx-cmp-scrubber-track" }, el("div", { class: "hx-cmp-scrubber-fill" })),
      el("div", { class: "hx-cmp-scrubber-thumb" }),
    );
    this.counter = el("span", { class: "hx-cmp-counter", "aria-hidden": "true" });
    this.speedButtons = SPEEDS.map((rate) =>
      el(
        "button",
        {
          type: "button",
          "aria-pressed": String(rate === 1),
          "aria-label": `${rate}x speed`,
          onclick: () => handlers.onRate(rate),
        },
        `${rate}×`,
      ),
    );
    this.element = el(
      "div",
      { class: "hx-cmp-controls" },
      this.playButton,
      ...this.stepButtons,
      this.scrubber,
      this.counter,
      el("div", { class: "hx-cmp-speed", role: "group", "aria-label": "Playback speed" }, ...this.speedButtons),
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
    this.playButton.setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  setFrame(frame, frames) {
    this.frames = frames;
    const progress = frames > 1 ? frame / (frames - 1) : 0;
    this.scrubber.style.setProperty("--hx-progress", `${(progress * 100).toFixed(3)}%`);
    this.scrubber.setAttribute("aria-valuemax", String(frames));
    this.scrubber.setAttribute("aria-valuenow", String(frame + 1));
    this.scrubber.setAttribute("aria-valuetext", `Frame ${frame + 1} of ${frames}`);
    this.counter.textContent = `${frame + 1} / ${frames}`;
  }

  setRate(rate) {
    SPEEDS.forEach((value, index) => this.speedButtons[index].setAttribute("aria-pressed", String(value === rate)));
  }

  setEnabled(enabled) {
    this.element.classList.toggle("is-disabled", !enabled);
    for (const button of [this.playButton, ...this.stepButtons, ...this.speedButtons]) button.disabled = !enabled;
    this.scrubber.tabIndex = enabled ? 0 : -1;
  }
}

/**
 * One square tile per method showing the same region of the held frame. Frames are drawn
 * once into offscreen canvases at native resolution; moving the pointer only redraws crops.
 * Unless a frame is held, the tiles show dimmed under a notice that says how to fill them (compare.css).
 * The last complete capture is remembered, so a held frame whose videos were freed and loaded again
 * keeps its tiles instead of fetching every method again.
 */
class CloseupGrid {
  constructor(methods, stage) {
    this.stage = stage;
    this.tiles = new Map();
    this.frames = new Map();
    this.zoom = ZOOM_DEFAULT;
    this.point = { u: 0.5, v: 0.5 };
    this.showMagnifier = false;
    this.abort = null;
    // The time (s) whose frames every tile shows, once a capture has filled them all; null otherwise.
    this.capturedTime = null;
    this.drawRequest = 0;
    this.grid = el("div", { class: "hx-cmp-closeup-grid" });
    for (const method of methods) {
      const canvas = el("canvas", { "aria-hidden": "true" });
      const figure = el(
        "figure",
        { class: "hx-cmp-tile", "data-method": method.id, "data-state": "idle" },
        canvas,
        el(
          "figcaption",
          { title: method.label },
          dot(),
          el("span", { class: "hx-cmp-tile-name" }, shortLabel(method)),
          el("span", { class: "hx-cmp-tile-side" }),
        ),
        el("span", { class: "hx-cmp-tile-status", "aria-hidden": "true" }),
      );
      this.tiles.set(method.id, { figure, canvas, context: canvas.getContext("2d") });
      this.grid.append(figure);
    }
    this.zoomLabel = el("span", { class: "hx-cmp-zoom" });
    this.hint = el("div", { class: "hx-cmp-closeup-hint" });
    this.loaderHost = el("div", { class: "hx-cmp-loaders", "aria-hidden": "true" });
    this.element = el(
      "aside",
      { class: "hx-cmp-closeups", "aria-label": "Close-ups of every method" },
      el(
        "div",
        { class: "hx-cmp-closeup-head" },
        el("span", { class: "hx-cmp-closeup-title" }, "Close-ups"),
        this.zoomLabel,
      ),
      el("div", { class: "hx-cmp-closeup-frame" }, this.grid, this.hint),
      el("p", { class: "hx-cmp-closeup-note" }, CLOSEUP_NOTE),
      this.loaderHost,
    );
    new ResizeObserver(() => this.resize()).observe(this.grid);
    this.setZoom(ZOOM_DEFAULT);
  }

  /** "paused" (held, tiles drawn), "playing", "idle" (paused without a held frame) or "unavailable". */
  setMode(mode) {
    if (this.element.dataset.mode === mode) return;
    this.element.dataset.mode = mode;
    // The glyph sits in the paragraph, so a notice that wraps stays centred as one block.
    const hints = {
      playing: ["pause", CLOSEUP_NOTICE],
      idle: ["pause", CLOSEUP_NOTICE_MANUAL],
      unavailable: ["film", NO_MEDIA_TEXT],
    };
    const hint = hints[mode];
    this.hint.replaceChildren(...(hint ? [el("p", {}, icon(hint[0]), ` ${hint[1]}`)] : []));
    if (mode !== "paused") this.showMagnifier = false;
    this.requestDraw();
  }

  setSelection(selection) {
    for (const [id, { figure }] of this.tiles) {
      const side = SIDES.find((item) => selection[item] === id) ?? "";
      figure.classList.toggle("is-picked", Boolean(side));
      figure.querySelector(".hx-cmp-tile-side").textContent = side ? (side === "left" ? "L" : "R") : "";
    }
  }

  setZoom(zoom) {
    this.zoom = clamp(zoom, ZOOM_MIN, ZOOM_MAX);
    this.zoomLabel.textContent = `${this.zoom.toFixed(1)}×`;
    this.requestDraw();
  }

  /** Centre the close-ups on a point given in normalized stage coordinates. */
  pointAt(u, v) {
    this.point = { u: clamp(u, 0, 1), v: clamp(v, 0, 1) };
    this.requestDraw();
  }

  /** Centre the close-ups on a region (normalized to the frame), zoomed so it fills a tile within the zoom range. */
  focus(region) {
    this.pointAt(region.x + region.w / 2, region.y + region.h / 2);
    const { clientWidth, clientHeight } = this.stage.element;
    const extent = Math.max(region.w * clientWidth, region.h * clientHeight);
    const tile = this.tileSize();
    if (tile && extent) this.setZoom(tile / extent);
  }

  /** Width of a tile in CSS pixels; 0 while the close-ups are not displayed (touch screens). */
  tileSize() {
    return this.tiles.values().next().value.canvas.clientWidth;
  }

  setMagnifier(visible) {
    this.showMagnifier = visible;
    this.requestDraw();
  }

  /** Forget all frames (new scene). */
  reset() {
    this.stopLoading();
    this.capturedTime = null;
    this.frames.clear();
    for (const id of this.tiles.keys()) this.setState(id, "idle");
    this.requestDraw();
  }

  /** Stop loading and mark the frames shown so far as outdated until the next capture (the frame changes). */
  invalidate() {
    this.stopLoading();
    this.capturedTime = null;
    for (const [id, { figure }] of this.tiles) {
      if (figure.dataset.state !== "idle") this.setState(id, "loading");
    }
  }

  stopLoading() {
    this.abort?.abort();
    this.abort = null;
  }

  /**
   * Fill every tile with the frame at `time`: methods on the stage are drawn from the stage
   * videos, the others from short-lived videos that are released right after one frame.
   */
  async capture(time, stageVideos, loaders) {
    this.stopLoading();
    this.capturedTime = null;
    const abort = new AbortController();
    this.abort = abort;
    for (const id of this.tiles.keys()) this.setState(id, "loading");
    for (const [id, video] of stageVideos) this.store(id, video);
    const queue = [...loaders];
    const work = async () => {
      while (queue.length && !abort.signal.aborted) {
        const [id, url] = queue.shift();
        await this.load(id, url, time, abort.signal);
      }
    };
    await Promise.all(Array.from({ length: CLOSEUP_LOADERS }, work));
    const complete = [...this.tiles.values()].every(({ figure }) => figure.dataset.state === "ready");
    if (!abort.signal.aborted && complete) this.capturedTime = time;
  }

  async load(id, url, time, signal) {
    const video = el("video", { muted: true, playsinline: true, preload: "auto", crossorigin: "anonymous" });
    video.muted = true;
    this.loaderHost.append(video);
    video.src = url;
    // iOS WebKit caps preload="auto" at metadata until play() or load(); load() lets it fetch the frame.
    video.load();
    try {
      await seekAndPresent(video, time, signal);
      if (!signal.aborted) this.store(id, video);
    } catch (error) {
      if (!signal.aborted) {
        console.warn(`Close-up for ${id} could not be loaded`, error);
        this.setState(id, "error");
      }
    } finally {
      releaseVideo(video);
      video.remove();
    }
  }

  store(id, video) {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) {
      this.setState(id, "error");
      return;
    }
    let canvas = this.frames.get(id);
    if (!canvas) {
      canvas = document.createElement("canvas");
      this.frames.set(id, canvas);
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    this.setState(id, "ready");
    this.requestDraw();
  }

  setState(id, state) {
    const { figure } = this.tiles.get(id);
    figure.dataset.state = state;
    figure.querySelector(".hx-cmp-tile-status").textContent = state === "error" ? "Unavailable" : "";
  }

  resize() {
    const ratio = window.devicePixelRatio || 1;
    for (const { canvas } of this.tiles.values()) {
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    }
    this.requestDraw();
  }

  requestDraw() {
    if (this.drawRequest) return;
    this.drawRequest = requestAnimationFrame(() => {
      this.drawRequest = 0;
      this.draw();
    });
  }

  /** The magnified square in stage pixels, kept inside the frame. */
  view() {
    const width = this.stage.element.clientWidth;
    const height = this.stage.element.clientHeight;
    const tile = this.tileSize();
    if (!width || !height || !tile) return null;
    const side = Math.min(tile / this.zoom, width, height);
    const half = side / 2;
    return {
      x: clamp(this.point.u * width, half, width - half),
      y: clamp(this.point.v * height, half, height - half),
      side,
      width,
      height,
    };
  }

  draw() {
    const view = this.element.dataset.mode === "paused" ? this.view() : null;
    this.stage.placeMagnifier(this.showMagnifier ? view : null);
    if (!view) return;
    for (const [id, { canvas, context }] of this.tiles) {
      const frame = this.frames.get(id);
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (!frame) continue;
      const side = view.side * (frame.width / view.width);
      const x = view.x * (frame.width / view.width) - side / 2;
      const y = view.y * (frame.height / view.height) - side / 2;
      context.imageSmoothingEnabled = canvas.width / side < 4;
      context.drawImage(frame, x, y, side, side, 0, 0, canvas.width, canvas.height);
    }
  }
}

/** The GPU a row ran on when it is not the reference GPU, else null. */
function otherGpu(row) {
  if (typeof row?.gpu === "string") return row.gpu === REFERENCE_GPU ? null : row.gpu;
  // Files without the gpu field mark those rows with a dagger in the FPS and VRAM text.
  return [...HARDWARE_COLUMNS].some((id) => String(row?.[id]?.text ?? "").includes(DAGGER)) ? "another GPU" : null;
}

/** The printed text of a cell without any dagger. */
function cellText(cell) {
  return String(cell?.text ?? "-").replaceAll(DAGGER, "");
}

function displayedNumber(cell) {
  if (!cell || cell.value === null || cell.value === undefined) return null;
  const printed = Number(cellText(cell).replace(/,/g, ""));
  return Number.isFinite(printed) ? printed : cell.value;
}

/**
 * Per-scene metrics: one row per method, best printed value per column in bold. FPS and VRAM of
 * rows measured on another GPU carry a dagger and are left out of the ranking.
 */
class MetricsTable {
  constructor(methods, page) {
    this.methods = methods;
    this.page = page;
    this.element = el("div", { class: "hx-cmp-metrics" });
  }

  render(sceneKey, title, selection) {
    const heading = el("h3", { class: "hx-cmp-metrics-title" }, title);
    const rows = this.page?.scenes?.[sceneKey];
    if (!rows) {
      const empty = el("p", { class: "hx-cmp-metrics-empty" }, "Per-scene metrics will appear here.");
      this.element.replaceChildren(heading, empty);
      return;
    }
    const { columns } = this.page;
    const best = this.bestValues(columns, rows);
    const head = el(
      "tr",
      {},
      el("th", { scope: "col" }, "Method"),
      ...columns.map((column) =>
        el("th", { scope: "col", class: "hx-cmp-num" }, column.label, this.arrow(column.better)),
      ),
    );
    const gpus = new Set();
    const body = this.methods.map((method) => {
      const row = rows[method.id];
      const gpu = otherGpu(row);
      if (gpu) gpus.add(gpu);
      const side = SIDES.find((item) => selection[item] === method.id);
      const cells = columns.map((column) => {
        const cell = row?.[column.id];
        const value = displayedNumber(cell);
        const marked = Boolean(gpu) && HARDWARE_COLUMNS.has(column.id) && value !== null;
        const isBest = value !== null && !marked && best.get(column.id) === value;
        return el(
          "td",
          { class: isBest ? "hx-cmp-num is-best" : "hx-cmp-num" },
          cellText(cell),
          marked ? el("sup", { class: "hx-cmp-dagger", title: `Measured on ${gpu}` }, DAGGER) : null,
        );
      });
      return el(
        "tr",
        { "data-method": method.id, class: side ? `is-picked is-${side}` : null },
        el(
          "th",
          { scope: "row" },
          el("span", { class: "hx-cmp-metrics-method" }, dot(), method.label),
          side ? el("span", { class: "hx-cmp-side-chip" }, side === "left" ? "left" : "right") : null,
        ),
        ...cells,
      );
    });
    const table = el(
      "table",
      { class: "table is-fullwidth is-narrow hx-cmp-metrics-table" },
      el("thead", {}, head),
      el("tbody", {}, ...body),
    );
    const explained = this.page.footnote?.includes(DAGGER);
    const daggerNote = gpus.size && !explained
      ? `${DAGGER} FPS and VRAM measured on ${[...gpus].join(" or ")} instead of an ${REFERENCE_GPU}: not hardware-matched, so not ranked.`
      : null;
    const notes = [this.page.footnote, daggerNote].filter(Boolean);
    this.element.replaceChildren(
      heading,
      el("div", { class: "table-container" }, table),
      // Shown on phones only (index.css), where the table scrolls sideways.
      el("p", { class: "hx-swipe-hint", "aria-hidden": "true" }, icon("left-right"), " Scroll sideways for every column"),
      ...notes.map((text) => el("p", { class: "hx-cmp-metrics-note" }, text)),
    );
  }

  arrow(better) {
    if (better !== "higher" && better !== "lower") return null;
    const text = better === "higher" ? "higher is better" : "lower is better";
    return el(
      "span",
      { class: "hx-cmp-arrow", title: text },
      el("span", { "aria-hidden": "true" }, better === "higher" ? "↑" : "↓"),
      el("span", { class: "is-sr-only" }, text),
    );
  }

  /** Best printed value per ranked column, over the cells measured on the reference GPU. */
  bestValues(columns, rows) {
    const best = new Map();
    for (const column of columns) {
      if (column.better !== "higher" && column.better !== "lower") continue;
      const values = this.methods
        .filter((method) => !(HARDWARE_COLUMNS.has(column.id) && otherGpu(rows[method.id])))
        .map((method) => displayedNumber(rows[method.id]?.[column.id]))
        .filter((value) => value !== null);
      if (values.length) best.set(column.id, column.better === "higher" ? Math.max(...values) : Math.min(...values));
    }
    return best;
  }
}

/** Wires the panels, the stage, playback, close-ups, tips and metrics together. */
class ComparePlayer {
  constructor(root, manifest, metricsPage, tips) {
    this.fps = manifest.fps;
    this.methods = manifest.methods;
    this.methodById = new Map(this.methods.map((method) => [method.id, method]));
    this.datasets = manifest.datasets;
    this.base = mediaBase();
    this.tips = tips;
    const [left, right] = manifest.default_pair;
    this.selection = { left, right };
    this.primary = left;
    this.dataset = null;
    this.scene = null;
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
    this.pending = { left: null, right: null };
    this.hovering = false;
    this.lastPointer = null;
    // After "Show me where" the magnifier stays on the tip's region until the pointer moves over the stage.
    this.pinned = false;
    this.spotRequest = null;
    this.drag = null;
    // A scrub in progress: whether to play on release, the frame still to seek to, the seek loop and the pointer state.
    this.scrub = { resume: false, target: null, seeking: null, dragging: false };
    this.captureTimer = 0;
    this.nearTimer = 0;
    this.releaseTimer = 0;

    this.stage = new Stage({
      onVideoError: (video) => {
        this.showVideoError(new Error(`Video failed to load: ${video.currentSrc || video.src}`));
      },
      onPosterError: (url) => this.onPosterError(url),
    });
    this.pair = new SyncedPair({
      onFrame: (frame) => this.controls.setFrame(frame, this.scene.frames),
      onBlocked: () => playback.stop(this.group),
      onError: (error) => this.showVideoError(error),
    });
    this.pair.setVideos(this.stage.videos.left, this.stage.videos.right);

    this.scenePanel = new ScenePanel(this.datasets, (dataset, scene) => this.selectScene(dataset, scene));
    this.methodPanel = new MethodPanel(this.methods, (side, id) => this.pickMethod(side, id));
    this.controls = new Controls({
      onTogglePlay: () => this.togglePlay(),
      onStep: (delta) => this.stepTo(this.pair.currentFrame() + delta),
      onStepTo: (frame) => this.stepTo(frame),
      onScrubStart: () => this.scrubStart(),
      onScrub: (frame) => this.scrubTo(frame),
      onScrubEnd: () => this.scrubEnd(),
      onRate: (rate) => this.setRate(rate),
    });
    this.closeups = new CloseupGrid(this.methods, this.stage);
    this.metrics = new MetricsTable(this.methods, metricsPage);
    this.generalTip = tipParagraph("hx-tip-general");
    this.sceneTip = tipParagraph("hx-tip-scene");
    this.status = el("p", { class: "is-sr-only", role: "status" });
    setTip(this.generalTip, tipText(tips?.general));

    this.player = el(
      "div",
      { class: "hx-cmp-player" },
      this.stage.element,
      this.controls.element,
      el("p", { class: "hx-cmp-help" }, helpText()),
      this.sceneTip,
      this.status,
    );
    this.element = el(
      "div",
      { class: `hx-compare${mouse ? "" : " is-touch"}` },
      this.generalTip,
      el("div", { class: "hx-cmp-picker" }, this.scenePanel.element, this.methodPanel.element),
      el("div", { class: "hx-cmp-body" }, el("div", { class: "hx-cmp-main" }, this.player), this.closeups.element),
      this.metrics.element,
    );
    root.replaceChildren(this.element);
    this.group = playback.register({
      zone: root.closest("section") ?? root,
      view: this.stage.element,
      // Hovering never ends an explicit pause, and a failed load waits for the visitor (play, another scene or method)
      // instead of playing under its notice.
      hoverable: () => this.canPlay() && !this.held && !this.failed,
      start: () => this.startPlayback(),
      stop: () => this.stopPlayback(),
    });
    this.stage.setSplit(50);
    this.bindStage();
    this.updateSelectionViews();
    this.updatePlayState();
    const listsOpening = this.datasets.some(
      (dataset) =>
        dataset.id === OPENING_SCENE.dataset && dataset.scenes.some((scene) => scene.id === OPENING_SCENE.scene),
    );
    const firstDataset = this.datasets[0];
    const start = listsOpening ? OPENING_SCENE : { dataset: firstDataset.id, scene: firstDataset.scenes[0].id };
    this.selectScene(start.dataset, start.scene);
    this.observeNear();
  }

  // Selection -------------------------------------------------------------------------

  /** Select a scene; keeps the method pair, the divider position and the play state. */
  selectScene(datasetId, sceneId) {
    const dataset = this.datasets.find((item) => item.id === datasetId);
    const scene = dataset?.scenes.find((item) => item.id === sceneId);
    if (!scene) {
      console.warn(`Unknown scene ${datasetId}/${sceneId}`);
      return false;
    }
    this.scenePanel.show(dataset.id, scene.id);
    if (scene === this.scene) return true;
    this.clearSpot();
    this.dataset = dataset;
    this.scene = scene;
    this.savedFrame = 0;
    this.missing = false;
    this.stage.setScene(scene);
    this.element.style.setProperty("--hx-aspect", (scene.width / scene.height).toFixed(4));
    this.pair.setClip(this.fps, scene.frames);
    this.controls.setFrame(0, scene.frames);
    this.closeups.reset();
    this.renderMetrics();
    this.updateDescription();
    this.showSceneTip();
    if (!this.base) {
      this.stage.setNotice(NO_MEDIA_TEXT);
      return true;
    }
    this.failed = false;
    this.stage.setNotice(null);
    this.updatePlayState();
    if (this.active) this.attachSources();
    else this.showPosters();
    return true;
  }

  sceneKey() {
    return `${this.dataset.id}/${this.scene.id}`;
  }

  /**
   * The current scene's tip. A tip that names a frame gets a button that shows the frame and the tip's method
   * pair, and one with a region also gets "Show me where".
   */
  showSceneTip() {
    const key = this.sceneKey();
    const tip = this.tips?.scenes?.[key];
    const text = tipText(tip);
    const frame = Number.isInteger(tip?.frame) ? wrapFrame(tip.frame, this.scene.frames) : null;
    const region = tipRegion(tip?.region, key);
    const actions =
      text && frame !== null && this.base
        ? [
            tipButton("location-crosshairs", `Show frame ${frame + 1}`, () => this.showTipFrame(frame, tip.compare)),
            region
              ? tipButton(
                  "magnifying-glass-location",
                  "Show me where",
                  () => this.showTipRegion(frame, tip.compare, region),
                  "hx-tip-action hx-tip-where",
                )
              : null,
          ].filter(Boolean)
        : [];
    setTip(this.sceneTip, text, actions);
  }

  /** Hold the tip's frame, with our method on the left and the tip's baseline on the right; resolves once it shows. */
  showTipFrame(frame, compare) {
    if (this.methodById.has(compare) && compare !== this.primary) this.selectMethods(this.primary, compare);
    return this.holdAt(frame);
  }

  /**
   * "Show me where": hold the tip's frame and method pair, centre the magnifier and close-ups on the region,
   * then ring the region on the stage once the frame shows. A newer request, playback, another scene or a
   * pointer moving over the stage (clearSpot) cancels it.
   */
  async showTipRegion(frame, compare, region) {
    this.clearSpot();
    const request = {};
    this.spotRequest = request;
    this.pinned = true;
    this.closeups.focus(region);
    this.stage.element.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
    await this.showTipFrame(frame, compare);
    // A method new to the stage loads behind the shown one first (replaceVideo); ring the region once it is in.
    while (this.spotRequest === request && SIDES.some((side) => this.pending[side])) {
      await new Promise(requestAnimationFrame);
    }
    if (this.spotRequest !== request || !this.held || !this.stage.notice.hidden) return;
    const label = `Where to look: the ${regionPlace(region)} of frame ${frame + 1}`;
    // Split the region down its middle, Ours on its left half and the compared method on its right, so both show
    // on the stage itself (phones have no close-ups).
    this.stage.setSplit(100 * (region.x + region.w / 2));
    this.stage.showSpot(region, label);
    this.status.textContent = `${label}.`;
  }

  /** Drop the "Show me where" ring and any request still waiting for its frame; the magnifier stays on its region. */
  cancelSpot() {
    this.spotRequest = null;
    this.stage.hideSpot();
  }

  /** Drop the ring and any waiting request; the magnifier follows the pointer again. */
  clearSpot() {
    this.cancelSpot();
    this.pinned = false;
  }

  /** Apply the swap rule: picking the method shown on the other side swaps the two sides. */
  pickMethod(side, id) {
    const other = side === "left" ? "right" : "left";
    const next = { ...this.selection };
    if (id === next[other]) next[other] = next[side];
    next[side] = id;
    this.selectMethods(next.left, next.right);
  }

  selectMethods(left, right) {
    if (!this.methodById.has(left) || !this.methodById.has(right) || left === right) {
      console.warn(`Invalid method pair ${left} / ${right}`);
      return false;
    }
    this.selection = { left, right };
    this.updateSelectionViews();
    this.updateVideos();
    return true;
  }

  updateSelectionViews() {
    const methods = {
      left: this.methodById.get(this.selection.left),
      right: this.methodById.get(this.selection.right),
    };
    this.methodPanel.update(this.selection);
    this.stage.setLabels(methods);
    this.closeups.setSelection(this.selection);
    if (this.scene) {
      this.renderMetrics();
      this.updateDescription();
    }
  }

  updateDescription() {
    const { left, right } = this.selection;
    const pair = `${this.methodById.get(left).label} on the left, ${this.methodById.get(right).label} on the right`;
    const keys = "Left and right arrow keys step frames, space plays or pauses.";
    this.stage.setDescription(`${this.scene.label} (${this.dataset.label}): ${pair}. ${keys}`);
  }

  renderMetrics() {
    this.metrics.render(this.sceneKey(), `Per-scene metrics: ${this.scene.label} (${this.dataset.label})`, this.selection);
  }

  /** Scroll the player into view after selecting a scene (used by the gallery). */
  reveal(datasetId, sceneId) {
    if (!this.selectScene(datasetId, sceneId)) return;
    this.stage.element.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
  }

  // Media sources -----------------------------------------------------------------------

  videoUrl(method) {
    return mediaUrl(this.scene.videos[method].key);
  }

  /** True when the stage can load and play the current scene. */
  canPlay() {
    return Boolean(this.base) && !this.missing;
  }

  posterUrl(method) {
    return mediaUrl(this.scene.videos[method].poster);
  }

  /** Point a stage video at `method` of the current scene without loading it. */
  assign(video, method) {
    video.dataset.method = method;
  }

  /** Point the stage videos at the selected pair and show its posters once the player is near the viewport or loads. */
  showPosters(load = this.near) {
    for (const side of SIDES) this.assign(this.stage.videos[side], this.selection[side]);
    if (!load) return;
    for (const side of SIDES) this.stage.setPoster(side, this.posterUrl(this.selection[side]));
  }

  /** A poster of the shown pair that fails to load means the scene's media are missing: show a notice. */
  onPosterError(url) {
    const shown = SIDES.some((side) => this.posterUrl(this.selection[side]) === url);
    if (!shown || this.active) return;
    this.missing = true;
    this.stage.setNotice(MISSING_TEXT);
    this.updatePlayState();
  }

  cancelPending() {
    for (const side of SIDES) {
      const pending = this.pending[side];
      if (!pending) continue;
      pending.abort.abort();
      this.stage.dropPending(pending.video);
      this.pending[side] = null;
    }
  }

  /**
   * Load the current scene into both stage videos and restore the saved frame; playback waits until then. The
   * close-ups keep the frame they show, which capture() skips when it is the saved frame.
   */
  async attachSources() {
    this.loadAbort?.abort();
    const abort = new AbortController();
    this.loadAbort = abort;
    this.active = true;
    this.loading = true;
    this.failed = false;
    this.pair.suspend();
    this.cancelPending();
    this.closeups.stopLoading();
    this.stage.setNotice(null);
    this.showPosters(true);
    const { left, right } = this.stage.videos;
    for (const video of [left, right]) {
      const url = this.videoUrl(video.dataset.method);
      // A side whose source is unchanged keeps loading; a new or failed one starts again.
      if (video.getAttribute("src") === url && !video.error) continue;
      video.src = url;
      // iOS WebKit caps preload="auto" at metadata until play() or load(): without load() no frame would ever arrive
      // and the pair would never resume.
      video.load();
    }
    this.pair.setVideos(left, right);
    this.stage.bindVideos();
    try {
      await Promise.all([whenLoaded(left, abort.signal), whenLoaded(right, abort.signal)]);
      await this.pair.seekFrame(this.savedFrame);
    } catch (error) {
      if (!abort.signal.aborted) {
        this.loading = false;
        this.showVideoError(error);
      }
      return;
    }
    if (abort.signal.aborted) return;
    this.loading = false;
    this.controls.setFrame(this.pair.currentFrame(), this.scene.frames);
    this.pair.resume();
    this.scheduleCapture();
  }

  /** Free both stage videos, keeping their frame for the next attachSources() and the close-ups of a held frame. */
  releaseSources() {
    if (!this.active || playback.isPlaying(this.group)) return;
    // A load in flight has not reached savedFrame yet, so it stays the frame to restore.
    if (!this.loading) this.savedFrame = this.pair.currentFrame();
    this.active = false;
    this.loading = false;
    this.loadAbort?.abort();
    this.cancelPending();
    this.closeups.stopLoading();
    clearTimeout(this.captureTimer);
    for (const video of Object.values(this.stage.videos)) releaseVideo(video);
    // A load error is retried on the next start; a scene without media keeps its notice.
    if (!this.missing) {
      this.failed = false;
      this.stage.setNotice(null);
      this.updatePlayState();
    }
  }

  /** Bring the stage videos in line with the selected pair: swap elements or load replacements. */
  updateVideos() {
    const { videos } = this.stage;
    const { left, right } = this.selection;
    if (videos.left.dataset.method === right && videos.right.dataset.method === left) {
      this.cancelPending();
      this.stage.swapSides();
      this.showPosters();
      this.pair.setVideos(this.stage.videos.left, this.stage.videos.right);
      if (this.pair.playing) this.pair.sync();
      return;
    }
    for (const side of SIDES) {
      const wanted = this.selection[side];
      if (videos[side].dataset.method !== wanted && this.pending[side]?.method !== wanted) this.replaceVideo(side);
    }
    const settled = SIDES.every((side) => !this.pending[side] && !this.stage.videos[side].error);
    if (this.active && settled) {
      this.recover();
      if (this.pair.playing) this.pair.sync();
    }
  }

  /** Load the newly selected method hidden behind the current one, then swap it in on the same frame. */
  async replaceVideo(side) {
    const method = this.selection[side];
    const pending = this.pending[side];
    if (pending) {
      pending.abort.abort();
      this.stage.dropPending(pending.video);
      this.pending[side] = null;
    }
    if (this.near) this.stage.setPoster(side, this.posterUrl(method));
    if (!this.active || !this.base || this.loading) {
      this.assign(this.stage.videos[side], method);
      // While the pair still loads, the stage element itself loads the new method: a hidden copy that finished first
      // would free the element that attachSources() waits on, and the pair would never resume.
      if (this.loading) this.attachSources();
      return;
    }
    const abort = new AbortController();
    const video = this.stage.createVideo(side);
    video.dataset.method = method;
    this.pending[side] = { method, video, abort };
    this.stage.addPending(side, video);
    video.src = this.videoUrl(method);
    // iOS WebKit caps preload="auto" at metadata until play() or load(); load() lets it fetch the first frames.
    video.load();
    try {
      await whenLoaded(video, abort.signal);
      // Swap in on the frame the pair shows then. A held frame that a step or a tip moves meanwhile is sought again,
      // and a seek of the element being replaced finishes first, so a pauseAt() waiting on it still resolves.
      let time;
      do {
        time = this.pair.playing ? this.pair.master.currentTime : frameTime(this.pair.currentFrame(), this.fps);
        await seekAndPresent(video, time, abort.signal);
        await whenSeeked(this.stage.videos[side], abort.signal);
      } while (!this.pair.playing && frameTime(this.pair.currentFrame(), this.fps) !== time);
      if (this.pair.playing) await whenPlayable(video, abort.signal);
    } catch (error) {
      if (!abort.signal.aborted) {
        this.pending[side] = null;
        this.stage.dropPending(video);
        this.showVideoError(error);
      }
      return;
    }
    if (abort.signal.aborted) return;
    this.pending[side] = null;
    this.stage.commit(side, video);
    this.pair.setVideos(this.stage.videos.left, this.stage.videos.right);
    if (this.pair.playing) this.pair.sync();
    // A video that failed on the other side keeps the notice up.
    if (SIDES.every((item) => !this.stage.videos[item].error)) this.recover();
  }

  /**
   * Clear the notice once both stage videos are fine. After a failed load the pair, which the load left suspended,
   * may play again, and hovering may start it (unless the visitor holds a frame).
   */
  recover() {
    this.stage.setNotice(null);
    if (!this.failed) return;
    this.failed = false;
    this.pair.resume();
    this.updatePlayState();
  }

  /** Cover the stage with an error notice and stop playback until the visitor plays or picks another scene or method. */
  showVideoError(error) {
    console.warn(error);
    this.failed = true;
    playback.stop(this.group);
    this.pair.stop();
    this.stage.setNotice(ERROR_TEXT);
    this.updatePlayState();
  }

  // Playback ------------------------------------------------------------------------------

  /** Called by the playback manager: load the pair if needed and play it. */
  startPlayback() {
    this.held = false;
    this.clearSpot();
    if (!this.canPlay()) return;
    clearTimeout(this.captureTimer);
    this.closeups.invalidate();
    this.pair.play();
    // Playing after a failed load tries it once more.
    if (!this.active || this.failed) this.attachSources();
    this.updatePlayState();
  }

  /** Called by the playback manager: pause both videos on the same frame. */
  stopPlayback() {
    const loaded = this.active && this.pair.master.readyState >= HTMLMediaElement.HAVE_METADATA;
    if (loaded) {
      this.pauseAt(this.pair.currentFrame());
      return;
    }
    this.pair.stop();
    this.updatePlayState();
  }

  /** The play button, space and clicks or taps on the stage: play, or pause and hold the frame. */
  togglePlay() {
    if (!this.canPlay()) return;
    if (playback.isPlaying(this.group)) {
      this.held = true;
      playback.stop(this.group);
    } else {
      playback.play(this.group);
    }
  }

  /** Hold frame `frame` (frame steps, keys and tips), loading the pair first when needed; resolves once it shows. */
  holdAt(frame) {
    if (!this.canPlay()) return Promise.resolve();
    this.held = true;
    playback.stop(this.group);
    // A load still in flight seeks to savedFrame when it completes, so it must name this frame too.
    this.savedFrame = wrapFrame(frame, this.scene.frames);
    if (this.active) return this.pauseAt(frame);
    this.closeups.invalidate();
    this.controls.setFrame(this.savedFrame, this.scene.frames);
    this.updatePlayState();
    return this.attachSources();
  }

  /** A frame step (buttons, arrow keys, the scrubber's keys): drop the ring of an earlier tip and hold `frame`. */
  stepTo(frame) {
    this.cancelSpot();
    return this.holdAt(frame);
  }

  /** Pause on `frame` in both loaded videos, then refresh the close-ups when the frame is held. */
  async pauseAt(frame) {
    clearTimeout(this.captureTimer);
    this.closeups.invalidate();
    const seeking = this.pair.pauseAt(frame);
    this.updatePlayState();
    this.controls.setFrame(this.pair.currentFrame(), this.scene.frames);
    try {
      await seeking;
    } catch (error) {
      this.showVideoError(error);
      return;
    }
    // Videos without metadata yet only move once it arrives, after the counter above was set. A scrub that paused
    // playback owns the counter until it ends.
    if (!this.scrub.dragging) this.controls.setFrame(this.pair.currentFrame(), this.scene.frames);
    this.scheduleCapture();
  }

  scrubStart() {
    this.scrub.dragging = true;
    this.scrub.resume = playback.isPlaying(this.group);
    this.cancelSpot();
    this.held = true;
    playback.stop(this.group);
    this.pair.stop();
    clearTimeout(this.captureTimer);
    this.closeups.invalidate();
    this.updatePlayState();
  }

  /** Seek to `frame`; requests made while a seek is in flight are coalesced into the latest one. */
  scrubTo(frame) {
    this.controls.setFrame(frame, this.scene.frames);
    if (!this.active) {
      this.savedFrame = frame;
      return;
    }
    this.scrub.target = frame;
    this.scrub.seeking ??= this.seekScrubTarget().finally(() => {
      this.scrub.seeking = null;
    });
  }

  /** Seek to the latest scrub target until none is left. */
  async seekScrubTarget() {
    while (this.scrub.target !== null) {
      const target = this.scrub.target;
      this.scrub.target = null;
      try {
        await this.pair.seekFrame(target);
      } catch (error) {
        this.showVideoError(error);
        return;
      }
    }
  }

  /** Play again after a scrub that began during playback; otherwise capture the close-ups once the last seek is done. */
  scrubEnd() {
    this.scrub.dragging = false;
    if (this.scrub.resume) playback.play(this.group);
    else if (!this.active && this.canPlay()) this.attachSources();
    else Promise.resolve(this.scrub.seeking).then(() => this.scheduleCapture());
  }

  setRate(rate) {
    this.pair.setRate(rate);
    this.controls.setRate(rate);
  }

  updatePlayState() {
    const playing = this.pair.wantPlay;
    const held = this.held && !playing && this.canPlay();
    this.controls.setPlaying(playing);
    this.stage.setCue(playing || !this.canPlay() || this.failed ? null : this.cueText());
    this.controls.setEnabled(this.canPlay());
    this.stage.element.classList.toggle("is-paused", !playing);
    this.stage.element.classList.toggle("is-held", held);
    this.closeups.setMode(!this.canPlay() ? "unavailable" : held ? "paused" : playing ? "playing" : "idle");
    this.closeups.setMagnifier((this.hovering || this.pinned) && held);
  }

  /** How to start playback while it is paused: hovering, unless motion is reduced or the visitor holds a frame. */
  cueText() {
    if (!mouse) return "Tap to play";
    return hoverPlays() && !this.held ? "Hover to play" : "Click to play";
  }

  // Close-ups -------------------------------------------------------------------------------

  /** Capture the close-ups of a held frame shortly after it shows (with a mouse; touch screens have no close-ups). */
  scheduleCapture() {
    clearTimeout(this.captureTimer);
    if (!mouse || !this.held || this.pair.wantPlay || !this.active || this.scrub.dragging) return;
    this.captureTimer = setTimeout(() => this.capture(), CAPTURE_DELAY_MS);
  }

  /** Fill the close-ups with the shown frame, unless they already show it (a held frame loaded again). */
  capture() {
    const time = frameTime(this.pair.currentFrame(), this.fps);
    if (this.closeups.capturedTime === time) return;
    const shown = new Map(Object.values(this.stage.videos).map((video) => [video.dataset.method, video]));
    const loaders = this.methods
      .filter((method) => !shown.has(method.id))
      .map((method) => [method.id, this.videoUrl(method.id)]);
    this.closeups.capture(time, shown, loaders);
  }

  // Stage interaction -----------------------------------------------------------------------

  bindStage() {
    const stage = this.stage.element;
    stage.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    stage.addEventListener("pointermove", (event) => this.onPointerMove(event));
    stage.addEventListener("pointerup", (event) => this.onPointerUp(event));
    stage.addEventListener("pointercancel", (event) => this.endDrag(event));
    stage.addEventListener("pointerenter", (event) => this.onHover(event, true));
    stage.addEventListener("pointerleave", (event) => this.onHover(event, false));
    stage.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
    stage.addEventListener("keydown", (event) => this.onKey(event));
    // Runs after the stage's own listener, which compares a move with the one before (onPointerMove).
    document.addEventListener("pointermove", (event) => {
      this.lastPointer = { x: event.clientX, y: event.clientY };
    });
    new ResizeObserver(() => this.stage.updateTagCover()).observe(stage);
  }

  onPointerDown(event) {
    if (event.button !== 0) return;
    const onHandle = Boolean(event.target.closest(".hx-cmp-handle"));
    this.drag = { id: event.pointerId, x: event.clientX, active: false, onHandle };
    if (onHandle) {
      event.preventDefault();
      this.beginDrag(event);
    }
  }

  beginDrag(event) {
    this.drag.active = true;
    this.stage.element.setPointerCapture(event.pointerId);
    this.stage.setDragging(true);
    this.splitAt(event.clientX);
  }

  onPointerMove(event) {
    // Safari sends a mouse move when the page scrolls under a resting pointer: it repeats the last position.
    const last = this.lastPointer;
    if (event.pointerType === "mouse" && last && event.clientX === last.x && event.clientY === last.y) return;
    this.clearSpot();
    const drag = this.drag;
    if (drag?.id === event.pointerId) {
      if (!drag.active && Math.abs(event.clientX - drag.x) > DRAG_THRESHOLD_PX) this.beginDrag(event);
      if (drag.active) this.splitAt(event.clientX);
    }
    if (event.pointerType === "mouse" && mouse) {
      const rect = this.stage.element.getBoundingClientRect();
      this.closeups.pointAt((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
    }
  }

  /** A press that did not drag the divider is a click or tap on the video: play or pause. */
  onPointerUp(event) {
    const drag = this.drag;
    this.endDrag(event);
    if (drag?.id === event.pointerId && !drag.active && !drag.onHandle) this.togglePlay();
  }

  endDrag(event) {
    if (this.drag?.id !== event.pointerId) return;
    this.drag = null;
    this.stage.setDragging(false);
  }

  /** Track the mouse over the stage for the magnifier; a held frame loads again for its close-ups. */
  onHover(event, inside) {
    if (event.pointerType !== "mouse" || !mouse) return;
    this.hovering = inside;
    if (inside && this.held && !this.active && this.canPlay()) this.attachSources();
    this.updatePlayState();
  }

  splitAt(clientX) {
    const rect = this.stage.element.getBoundingClientRect();
    this.stage.setSplit(((clientX - rect.left) / rect.width) * 100);
  }

  onWheel(event) {
    if (!mouse || !this.held || this.pair.wantPlay || !this.canPlay()) return;
    event.preventDefault();
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    this.closeups.setZoom(this.closeups.zoom * Math.exp(-delta * WHEEL_ZOOM_RATE));
  }

  onKey(event) {
    if (event.target === this.stage.handle) {
      const moves = {
        ArrowLeft: -SPLIT_KEY_STEP,
        ArrowDown: -SPLIT_KEY_STEP,
        ArrowRight: SPLIT_KEY_STEP,
        ArrowUp: SPLIT_KEY_STEP,
      };
      if (event.key in moves) this.stage.setSplit(this.stage.split + moves[event.key]);
      else if (event.key === "Home") this.stage.setSplit(0);
      else if (event.key === "End") this.stage.setSplit(100);
      else return;
      event.preventDefault();
      return;
    }
    if (event.target !== this.stage.element || !this.canPlay()) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      this.stepTo(this.pair.currentFrame() + (event.key === "ArrowLeft" ? -1 : 1));
    } else if (event.key === " " || event.key === "k") {
      event.preventDefault();
      this.togglePlay();
    }
  }

  // Visibility ------------------------------------------------------------------------------

  /**
   * Once the stage has stayed near the viewport for NEAR_SETTLE_MS, show the posters and load the videos when hovering
   * can start them (a mouse, without reduced motion) or they show a held frame, so playback starts at once; free the
   * decoders shortly after the stage moves away or the tab is hidden. Playing and pausing is the playback manager's
   * job.
   */
  observeNear() {
    watchNear(this.stage.element, (near) => {
      this.near = near;
      clearTimeout(this.nearTimer);
      if (near) this.nearTimer = setTimeout(() => this.preload(), NEAR_SETTLE_MS);
      this.updateRelease();
    });
    // Back in a visible tab, a stage freed while the tab was hidden loads again, held frame included.
    document.addEventListener("visibilitychange", () => {
      this.updateRelease();
      if (document.visibilityState === "visible") this.preload();
    });
  }

  /**
   * Show the posters of a stage that is still near the viewport, and load its videos when hovering can start them or
   * a held frame needs them; touch screens and reduced motion load nothing before a tap or click.
   */
  preload() {
    if (!this.near || this.active) return;
    this.showPosters();
    if (this.canPlay() && (hoverPlays() || this.held)) this.attachSources();
  }

  updateRelease() {
    clearTimeout(this.releaseTimer);
    if (this.near && document.visibilityState === "visible") return;
    this.releaseTimer = setTimeout(() => this.releaseSources(), RELEASE_DELAY_MS);
  }
}

async function initCompare(root) {
  const [manifest, metrics, tips] = await Promise.all([
    loadJSON(root.dataset.media),
    loadJSON(root.dataset.metrics).catch((error) => {
      console.warn("Per-scene metrics are not available", error);
      return null;
    }),
    loadTips(),
  ]);
  return new ComparePlayer(root, manifest, metrics?.page ?? null, tips);
}

const root = document.getElementById("compare-root");
const ready = root
  ? initCompare(root).catch((error) => {
      console.error("The comparison player could not start", error);
      root.replaceChildren(el("p", { class: "hx-cmp-unavailable" }, "The comparison could not be loaded."));
      return null;
    })
  : Promise.resolve(null);

window.HexelsCompare = {
  selectScene: (dataset, scene) => ready.then((player) => player?.selectScene(dataset, scene) ?? false),
  selectMethods: (left, right) => ready.then((player) => player?.selectMethods(left, right) ?? false),
};

document.addEventListener("hexels:select-scene", (event) => {
  ready.then((player) => player?.reveal(event.detail.dataset, event.detail.scene));
});
