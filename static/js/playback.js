/**
 * Central playback manager for every video on the page: the demo window, the theory animations, the comparison
 * player, the variants grid and the gallery previews.
 *
 * Nothing plays by itself: not when a page loads, scrolls or opens at a deep link. Every group plays on hover:
 * - With a mouse ("(hover: hover) and (pointer: fine)") and no reduced-motion preference, a group plays while the
 *   pointer rests on its zone, HOVER_DELAY_MS after the pointer really moved there, and pauses when the pointer
 *   leaves. A resting pointer that a page load, a scroll or a deep link puts over a zone starts nothing until it moves.
 * - On touch screens, and under prefers-reduced-motion, only a tap or click on the group's play control starts it;
 *   a group a mouse click started still stops when the pointer leaves its zone.
 * At most one group plays at a time: starting one stops the one that played before. A group stops when its view
 * scrolls off screen or the tab is hidden, and a view that is off screen or not displayed never starts on hover. A
 * visitor's pause (toggle()) holds while the pointer stays on the zone. A group can also refuse hover starts through
 * its optional `hoverable()` predicate (the players keep an explicitly paused frame that way), and `enabled = false`
 * switches it off entirely (LoopingVideo.setEnabled).
 *
 * Videos carry no src until their group first starts; only the comparison player and the variants grid load theirs
 * earlier, when they come near the viewport on a mouse screen, so that hovering starts them at once. Stills come from
 * ordinary (lazy) images.
 *
 * A group is any object with a `zone` element and `start()` and `stop()` methods. Optional are a `view` element, the
 * part that must be on screen (the zone itself by default), `hoverable()` and `enabled`. LoopingVideo builds a group
 * for one looping video with a play control.
 */
import { releaseVideo } from "./video-sync.js";

const HOVER_DELAY_MS = 180;
const pointerQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** True when the primary pointer is a mouse-like device, which hover effects such as magnifiers need. */
export function hasMouse() {
  return pointerQuery.matches;
}

/** True when videos follow the pointer: a mouse-like primary pointer and no reduced-motion preference. */
export function hoverPlays() {
  return pointerQuery.matches && !reducedMotion.matches;
}

class PlaybackManager {
  constructor() {
    this.current = null;
    this.groups = new Map(); // view -> group
    this.timers = new Map(); // group -> pending hover start
    this.onScreen = new Set(); // groups whose view intersects the viewport
    this.paused = new Set(); // groups the visitor paused; hovering starts them again once the pointer has left
    this.pointer = null; // the mouse's last position, in client pixels
    this.moveEvent = null; // the last pointermove that really moved the mouse
    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries));
    document.addEventListener("pointermove", (event) => this.trackPointer(event), { capture: true, passive: true });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.halt(this.current);
    });
    const syncMode = () => document.documentElement.classList.toggle("hx-hover", hoverPlays());
    pointerQuery.addEventListener("change", syncMode);
    reducedMotion.addEventListener("change", syncMode);
    syncMode();
  }

  /** Start managing a group; returns it. */
  register(group) {
    const view = group.view ?? group.zone;
    this.groups.set(view, group);
    this.observer.observe(view);
    group.zone.addEventListener("pointermove", (event) => {
      if (event === this.moveEvent && hoverPlays() && this.current !== group && !this.timers.has(group)) {
        this.scheduleHover(group);
      }
    });
    // With a mouse a group plays only while the pointer is on its zone, also when a click started it (reduced motion).
    group.zone.addEventListener("pointerleave", (event) => {
      if (event.pointerType !== "mouse") return;
      this.cancelHover(group);
      this.paused.delete(group);
      this.halt(group);
    });
    return group;
  }

  /**
   * Note the pointermove events that really move the mouse. Browsers also report a resting mouse when the page moves
   * under it (Chromium sends pointerover, Safari repeats the last position in a pointermove), and a page that loads
   * under a resting mouse knows no position yet, so there the first pointermove counts only when it reports movement.
   */
  trackPointer(event) {
    if (event.pointerType !== "mouse") return;
    const { clientX: x, clientY: y } = event;
    const last = this.pointer;
    const moved = last ? x !== last.x || y !== last.y : event.movementX !== 0 || event.movementY !== 0;
    this.pointer = { x, y };
    if (moved) this.moveEvent = event;
  }

  /** Start a hovered group after a short rest, so sweeping past it starts nothing. */
  scheduleHover(group) {
    this.cancelHover(group);
    const timer = setTimeout(() => {
      this.timers.delete(group);
      if (group.zone.matches(":hover") && this.canHover(group)) this.play(group);
    }, HOVER_DELAY_MS);
    this.timers.set(group, timer);
  }

  cancelHover(group) {
    clearTimeout(this.timers.get(group));
    this.timers.delete(group);
  }

  /** Hovering may start `group` while its view is on screen in a visible tab and nobody (visitor or group) holds it. */
  canHover(group) {
    return (
      hoverPlays() &&
      document.visibilityState === "visible" &&
      this.onScreen.has(group) &&
      !this.paused.has(group) &&
      group.enabled !== false &&
      (group.hoverable?.() ?? true)
    );
  }

  /** Make `group` the one playing group, unless it is switched off. */
  play(group) {
    if (this.current === group || group.enabled === false) return;
    const previous = this.current;
    this.current = group;
    previous?.stop();
    group.start();
  }

  /** Stop `group` if it is playing, starting nothing else; returns whether it was playing. */
  halt(group) {
    if (!group || this.current !== group) return false;
    this.current = null;
    group.stop();
    return true;
  }

  /** Stop `group` if it is playing: focus left a gallery tile, a demo tab closed, a video failed, a player paused. */
  stop(group) {
    this.halt(group);
  }

  /** A tap, click or play button: play, or pause; that pause holds while the pointer stays on the zone. */
  toggle(group) {
    if (this.halt(group)) {
      this.paused.add(group);
      return;
    }
    this.paused.delete(group);
    this.play(group);
  }

  isPlaying(group) {
    return this.current === group;
  }

  /** Track which views are on screen; a view that scrolls out, or is no longer displayed, stops its group. */
  onIntersect(entries) {
    for (const entry of entries) {
      const group = this.groups.get(entry.target);
      if (entry.isIntersecting) {
        this.onScreen.add(group);
      } else {
        this.onScreen.delete(group);
        this.halt(group);
      }
    }
  }
}

export const playback = new PlaybackManager();

/** A Font Awesome glyph. */
function glyph(name) {
  const node = document.createElement("i");
  node.className = `fa-solid fa-${name}`;
  node.setAttribute("aria-hidden", "true");
  return node;
}

/**
 * One looping, muted video as a playback group. The video starts without src and preload="none";
 * a still image placed under it in `media` shows until the first frame and whenever the video is
 * released. A round button toggles playback (always shown on touch screens while paused, otherwise
 * only on keyboard focus), and on mouse screens a small hint invites hovering: `hint` puts it over
 * the video ("overlay"), on a line under it ("below") or nowhere (null).
 *
 * When the browser cannot play `type`, or the video fails to load, `fallback` (an animated image URL)
 * takes over: the still image switches to it while the group plays and back when it stops. Without
 * a fallback, `onFail` is called once instead.
 *
 * A stopped video holds its frame, is released (`release`, which frees it until it plays again) or, with
 * `rewind`, returns to its first frame: the theory animations, whose stills equal that frame, so a short
 * hover never leaves a drawing caught in an empty phase of its loop.
 *
 * setEnabled(false) switches the group off (no hover, tap or play button, and it stops) until
 * setEnabled(true), for example while a theory animation shows an interactive view instead.
 */
export class LoopingVideo {
  constructor({ zone, media, video, still, src, label, type = "", fallback = null, release = false, rewind = false, hint = "overlay", onFail = null }) {
    this.zone = zone;
    this.view = media;
    this.media = media;
    this.video = video;
    this.still = still;
    this.stillSrc = still?.getAttribute("src") ?? null;
    this.src = src;
    this.label = label;
    this.fallback = fallback;
    this.release = release;
    this.rewind = rewind;
    this.onFail = onFail;
    this.failed = false;
    this.enabled = true;
    this.useFallback = Boolean(fallback && type && video.canPlayType(type) === "");
    video.muted = true;
    this.button = this.buildButton();
    media.classList.add("hx-media");
    media.append(this.button);
    this.hint = hint ? this.buildHint(hint === "below" ? "hx-hint-below" : "") : null;
    if (hint === "overlay") media.append(this.hint);
    if (hint === "below") media.after(this.hint);
    video.addEventListener("playing", () => media.classList.remove("is-loading"));
    video.addEventListener("waiting", () => media.classList.toggle("is-loading", playback.isPlaying(this)));
    video.addEventListener("error", () => this.fail());
    this.render(false);
    playback.register(this);
  }

  buildButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hx-play";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      playback.toggle(this);
    });
    return button;
  }

  buildHint(variant = "") {
    const hint = document.createElement("span");
    hint.className = `hx-hint ${variant}`.trim();
    hint.setAttribute("aria-hidden", "true");
    hint.append(glyph("play"), " Hover to play");
    return hint;
  }

  /** Allow or refuse playback; refusing also stops the video and hides its play button and hint. */
  setEnabled(enabled) {
    this.enabled = enabled;
    this.button.hidden = !enabled;
    if (this.hint) this.hint.hidden = !enabled;
    if (!enabled) playback.stop(this);
  }

  start() {
    if (this.failed && !this.useFallback) return;
    this.render(true);
    if (this.useFallback) {
      this.still.src = this.fallback;
      return;
    }
    if (!this.video.getAttribute("src")) this.video.src = this.src;
    this.media.classList.add("is-loading");
    this.video.play().catch((error) => {
      // Battery savers can refuse playback; AbortError only means a pause() came first.
      if (error.name === "NotAllowedError") playback.stop(this);
    });
  }

  stop() {
    this.render(false);
    this.media.classList.remove("is-loading");
    if (this.useFallback) {
      this.still.src = this.stillSrc;
    } else if (this.release) {
      if (this.video.getAttribute("src")) releaseVideo(this.video);
    } else {
      this.video.pause();
      if (this.rewind) this.video.currentTime = 0;
    }
  }

  /** Switch to the fallback (or give up) once the video or its still cannot be loaded or decoded. */
  fail() {
    if (this.failed) return;
    this.failed = true;
    console.warn(`Video unavailable: ${this.src}`);
    releaseVideo(this.video);
    this.media.classList.remove("is-loading");
    if (this.fallback) {
      this.useFallback = true;
      if (playback.isPlaying(this)) this.still.src = this.fallback;
      return;
    }
    playback.stop(this);
    this.onFail?.();
  }

  render(playing) {
    this.media.classList.toggle("is-playing", playing);
    this.button.replaceChildren(glyph(playing ? "pause" : "play"));
    this.button.setAttribute("aria-label", `${playing ? "Pause" : "Play"} ${this.label}`);
  }
}
