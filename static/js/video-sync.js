/**
 * Frame-accurate playback helpers for the comparison player.
 *
 * SyncedPair plays two videos of the same clip together. The left (master) video drives
 * the clock; the right (follower) is kept within one frame of it with small playbackRate
 * nudges. When the drift grows beyond about two frames, both videos stop, the follower is
 * seeked to the master's position and both restart together, which converges in one seek
 * however slow seeking is. If either video runs out of data, the other one holds its frame
 * until both can play again. When paused, both videos are seeked to the middle of the same
 * frame so they show identical frames. Media that cannot be seeked (a server without HTTP
 * Range support) is realigned by restarting both videos from the beginning.
 */

const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;

const RESYNC_FRAMES = 2;
const WRAP_RESYNC_FRAMES = 1;
const DEADBAND_FRAMES = 0.25;
const NUDGE_PER_SECOND = 2;
const MAX_NUDGE = 0.08;

const hasFrameCallback =
  typeof HTMLVideoElement !== "undefined" && "requestVideoFrameCallback" in HTMLVideoElement.prototype;
let warnedUnseekable = false;

/** Seek target (s) for frame `index`: the middle of the frame, so rounding never lands on a neighbour. */
export function frameTime(index, fps) {
  return (index + 0.5) / fps;
}

/** Index of the frame shown at `time` seconds, clamped to the clip. */
function frameAt(time, fps, frames) {
  return Math.min(frames - 1, Math.max(0, Math.floor(time * fps + 1e-6)));
}

/** Wrap a frame index into [0, frames). */
export function wrapFrame(index, frames) {
  return ((index % frames) + frames) % frames;
}

function loadError(video) {
  return new Error(`Video failed to load: ${video.currentSrc || video.src}`);
}

/** Resolve on the next `type` event of `video`; reject on a media error or when `signal` aborts. */
function nextEvent(video, type, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const cleanup = () => {
      video.removeEventListener(type, onEvent);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(loadError(video));
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    video.addEventListener(type, onEvent);
    video.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort);
  });
}

/** Resolve once `video` has decoded the frame at its current position. */
export async function whenLoaded(video, signal) {
  if (video.error) throw loadError(video);
  if (video.readyState >= HAVE_CURRENT_DATA) return;
  await nextEvent(video, "loadeddata", signal);
}

/** Resolve once the seek `video` has in progress is done; at once when it is not seeking. */
export async function whenSeeked(video, signal) {
  if (video.seeking) await nextEvent(video, "seeked", signal);
}

/**
 * Resolve once `video` has data to keep playing, or after `timeoutMs` (some browsers do not
 * buffer paused videos, so this only shortens the wait for a smooth start).
 */
export async function whenPlayable(video, signal, timeoutMs = 1500) {
  if (canPlay(video)) return;
  let timer = 0;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([nextEvent(video, "canplay", signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Seek `video` to `time` and resolve once the frame there is decoded. */
async function seekTo(video, time, signal) {
  if (video.error) throw loadError(video);
  if (video.readyState < HAVE_METADATA) await nextEvent(video, "loadedmetadata", signal);
  if (Math.abs(video.currentTime - time) < 1e-4 && !video.seeking && video.readyState >= HAVE_CURRENT_DATA) return;
  const seeked = nextEvent(video, "seeked", signal);
  video.currentTime = time;
  await seeked;
}

/**
 * Seek and also wait for the new frame to be presented, so drawImage() sees it.
 * Videos outside the document never present frames, hence the short timeout.
 */
export async function seekAndPresent(video, time, signal, timeoutMs = 120) {
  const presented = new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    if (hasFrameCallback && video.isConnected) {
      video.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        resolve();
      });
    }
  });
  await seekTo(video, time, signal);
  await presented;
}

/** Stop a video and free its decoder and network resources. */
export function releaseVideo(video) {
  video.pause();
  video.removeAttribute("src");
  video.load();
}

function wrapDrift(drift, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return drift;
  if (drift > duration / 2) return drift - duration;
  if (drift < -duration / 2) return drift + duration;
  return drift;
}

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

/** Two videos of one clip played in lockstep. Play intent is kept separately from element state. */
export class SyncedPair {
  /**
   * @param {object} hooks
   * @param {(frame: number) => void} [hooks.onFrame] called on every presented master frame while playing
   * @param {() => void} [hooks.onBlocked] called when the browser refuses to start playback
   * @param {(error: Error) => void} [hooks.onError] called when a video cannot be loaded or seeked
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.master = null;
    this.follower = null;
    this.fps = 24;
    this.frames = 1;
    this.rate = 1;
    this.wantPlay = false;
    this.suspended = true;
    this.lastMasterTime = 0;
    this.loop = null;
    this.listeners = null;
    this.alignAbort = null;
  }

  /** True when the pair should be playing right now. */
  get playing() {
    return this.wantPlay && !this.suspended;
  }

  /** Set the clip's frame rate and frame count. */
  setClip(fps, frames) {
    this.fps = fps;
    this.frames = frames;
  }

  /** Bind (or rebind after a swap) the two elements; play intent is kept. */
  setVideos(master, follower) {
    this.stopLoop();
    this.alignAbort?.abort();
    this.listeners?.abort();
    this.master = master;
    this.follower = follower;
    this.listeners = new AbortController();
    const options = { signal: this.listeners.signal };
    for (const video of [master, follower]) {
      for (const type of ["waiting", "canplay", "playing"]) {
        video.addEventListener(type, () => this.onReadiness(video), options);
      }
    }
  }

  /** Index of the frame the master shows. */
  currentFrame() {
    return frameAt(this.master.currentTime, this.fps, this.frames);
  }

  play() {
    this.wantPlay = true;
    return this.sync();
  }

  /** Clear the play intent and pause both elements where they are. */
  stop() {
    this.wantPlay = false;
    this.halt();
  }

  /** Pause both videos and show frame `index` in both. */
  pauseAt(index) {
    this.stop();
    return this.seekFrame(index);
  }

  /** Show frame `index` (wrapped into the clip) in both videos without changing the intent. */
  async seekFrame(index) {
    const time = frameTime(wrapFrame(index, this.frames), this.fps);
    if (!warnedUnseekable && this.master.readyState >= HAVE_METADATA && !canSeek(this.master, time)) {
      warnedUnseekable = true;
      console.warn(
        "The media server does not support HTTP Range requests, so videos cannot be seeked; " +
          "paused frames fall back to the first frame.",
      );
    }
    await Promise.all([seekTo(this.master, time), seekTo(this.follower, time)]);
  }

  /** Change the playback speed of both videos. */
  setRate(rate) {
    this.rate = rate;
    this.master.playbackRate = rate;
    this.follower.playbackRate = rate;
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
   * Bring the elements in line with the intent. While one video cannot play yet, it keeps
   * loading (some browsers only load while playing) and the other holds its frame; once
   * both can play, the follower is aligned to the master and both start together.
   */
  async sync() {
    this.alignAbort?.abort();
    if (!this.playing) {
      this.halt();
      return;
    }
    const { master, follower } = this;
    if (!canPlay(master) || !canPlay(follower)) {
      for (const video of [master, follower]) {
        if (canPlay(video)) {
          if (!video.paused) video.pause();
        } else if (video.paused) {
          this.start(video);
        }
      }
      return;
    }
    if (!master.paused && !follower.paused) {
      this.scheduleLoop();
      return;
    }
    const abort = new AbortController();
    this.alignAbort = abort;
    try {
      if (Math.abs(follower.currentTime - master.currentTime) > 0.5 / this.fps) {
        if (canSeek(follower, master.currentTime)) {
          await seekTo(follower, master.currentTime, abort.signal);
        } else {
          await Promise.all([seekTo(master, 0, abort.signal), seekTo(follower, 0, abort.signal)]);
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) this.fail(error);
      return;
    }
    if (abort.signal.aborted || !this.playing) return;
    master.playbackRate = this.rate;
    follower.playbackRate = this.rate;
    await Promise.all([this.start(master), this.start(follower)]);
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

  /** Pause both elements without changing the intent. */
  halt() {
    this.alignAbort?.abort();
    this.stopLoop();
    for (const video of [this.master, this.follower]) {
      if (video && !video.paused) video.pause();
    }
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
   * Keep the follower within one frame of the master: nudge its rate for small drift, or
   * restart both aligned for large drift. Returns false when the loop should stop.
   */
  correctDrift() {
    const { master, follower, fps, rate } = this;
    if (follower.paused || follower.seeking || master.seeking) return true;
    const duration = master.duration;
    const masterTime = master.currentTime;
    const wrapped = masterTime < this.lastMasterTime - duration / 2;
    this.lastMasterTime = masterTime;
    const drift = wrapDrift(follower.currentTime - masterTime, duration);
    const frame = 1 / fps;
    if (Math.abs(drift) > (wrapped ? WRAP_RESYNC_FRAMES : RESYNC_FRAMES) * frame) {
      master.pause();
      follower.pause();
      this.sync();
      return false;
    }
    const nudge =
      Math.abs(drift) < DEADBAND_FRAMES * frame
        ? 0
        : Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, drift * NUDGE_PER_SECOND));
    const target = rate * (1 - nudge);
    if (Math.abs(follower.playbackRate - target) > 1e-3) follower.playbackRate = target;
    return true;
  }
}
