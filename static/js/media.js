/**
 * Media URL helpers, cached JSON loading and small loading utilities shared by the page components.
 *
 * Media keys (for example "nvs/dtu/scan24/ours.mp4") are resolved against a base URL. Pages served
 * from localhost, 127.0.0.1 or opened from file: use the ?media=<url> query parameter when given (to
 * preview another host, such as the real bucket) and otherwise MEDIA_BASE_URL_LOCAL; every other page
 * uses MEDIA_BASE_URL_PUBLIC from config.js, so a shared link cannot swap the hosted page's media.
 */

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);
const NEAR_MARGIN = "600px 0px";
const jsonRequests = new Map();

export const DATASET_LABELS = { mipnerf360: "Mip-NeRF 360", tanks_and_temples: "Tanks and Temples", dtu: "DTU" };

function siteConfig() {
  return window.HEXELS_CONFIG ?? {};
}

function withoutTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

function isLocalPage() {
  return window.location.protocol === "file:" || LOCAL_HOSTNAMES.has(window.location.hostname);
}

/** Base URL for media keys, or null when no media host is configured. */
export function mediaBase() {
  const { MEDIA_BASE_URL_LOCAL, MEDIA_BASE_URL_PUBLIC } = siteConfig();
  if (isLocalPage()) {
    const override = new URLSearchParams(window.location.search).get("media");
    if (override) return withoutTrailingSlash(override);
    if (MEDIA_BASE_URL_LOCAL) return withoutTrailingSlash(MEDIA_BASE_URL_LOCAL);
  }
  return MEDIA_BASE_URL_PUBLIC ? withoutTrailingSlash(MEDIA_BASE_URL_PUBLIC) : null;
}

/** Full URL of a media key with the cache-busting version, or null without a media base or key. */
export function mediaUrl(key) {
  const base = mediaBase();
  if (!base || !key) return null;
  const version = siteConfig().MEDIA_VERSION;
  const query = version ? `?v=${encodeURIComponent(version)}` : "";
  return `${base}/${String(key).replace(/^\/+/, "")}${query}`;
}

/** Fetch a JSON file relative to the page; every caller of the same file shares one request. */
export function loadJSON(path) {
  const url = new URL(path, document.baseURI).href;
  if (!jsonRequests.has(url)) {
    jsonRequests.set(
      url,
      fetch(url).then((response) => {
        if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
        return response.json();
      }),
    );
  }
  return jsonRequests.get(url);
}

/** The optional per-scene tips (static/data/tips.json), or null when the file is absent or broken. */
export function loadTips() {
  return loadJSON("static/data/tips.json").catch((error) => {
    console.info(`No viewing tips: ${error.message}`);
    return null;
  });
}

/** A tip's text without its leading "Tip:" (the page adds the label), or null; tips are strings or objects with text. */
export function tipText(tip) {
  const text = typeof tip === "string" ? tip : tip?.text;
  return typeof text === "string" && text.trim() ? text.replace(/^\s*tip:\s*/i, "") : null;
}

/** Run `callback` once, when `element` comes within NEAR_MARGIN of the viewport. */
export function whenNear(element, callback) {
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      callback();
    },
    { rootMargin: NEAR_MARGIN },
  );
  observer.observe(element);
}

/** Call `onChange(near)` once now and then whenever `element` comes within NEAR_MARGIN of the viewport or leaves it. */
export function watchNear(element, onChange) {
  const observer = new IntersectionObserver((entries) => onChange(entries.at(-1).isIntersecting), {
    rootMargin: NEAR_MARGIN,
  });
  observer.observe(element);
}
