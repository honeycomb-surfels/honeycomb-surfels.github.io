/**
 * Viewer page (viewer.html): the scene picker, the Compact / Full quality choice of each scene, the embedded
 * WebGL2 viewer and models opened from disk. Nothing downloads before a scene is picked or a file is opened.
 *
 * Scenes come from static/data/viewer_scenes.json: scenes[]
 * with scene, label, setting, thumb, cameras (the media key of the scene's cameras.json with its saved views,
 * default_camera and orbit_target), default_camera, orbit_target and variants[]; each variant has an id (compact
 * or full), a label such as "Compact (Hexels V2)", the media key of its .hexcodec deployment archive, bytes (the
 * download size), primitives, texels, raw_bytes (the decoded float32 rows, which is also the GPU texture), psnr,
 * psnr_source and default. Keys resolve like the page's other media: hosted pages load mediaUrl(key)
 * (static/js/media.js), while pages on localhost, 127.0.0.1 or file: without ?media= load the
 * local mirror that "local_mirror" records ({key_prefix: "viewer/", folder: "viewer_build"}: the folder plus the
 * key without its prefix). While MEDIA_BASE_URL_PUBLIC in config.js is empty, the public page says the models are
 * not hosted yet and offers local files only.
 *
 * The viewer itself is viewer/index.html, shown in an iframe. Every model opens in a fresh iframe, which releases
 * the previous model's memory: a scene through its URL parameters, a local file through postMessage once the new
 * viewer reports hexels-ready. The viewer downloads with byte progress, unpacks .hexcodec archives in a Web
 * Worker (viewer/archive.js, viewer/hexcodec-worker.js) and uploads the model to the GPU, and reports each step,
 * success and errors back with postMessage, tagged with the session number of its iframe. Local files are read
 * inside the browser and never uploaded; a local copy of a hosted archive (the same size in bytes) opens with that
 * scene's cameras.json, start view and orbit focus, like the hosted copy.
 */
import { loadJSON, mediaBase, mediaUrl } from "./media.js";
import { archiveSupport } from "../../viewer/archive.js";
import { fitsTexture } from "../../viewer/renderer.js";

const DATA_URL = "static/data/viewer_scenes.json";
const VIEWER_PAGE = "viewer/index.html";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);
const READY_TIMEOUT_MS = 20000;
// On a phone or tablet, Full quality asks before it downloads; so does any download this large on a device that
// reports little memory (navigator.deviceMemory, in GB).
const LOW_MEMORY_GB = 4;
const CONFIRM_BYTES = 30e6;
// Memory estimate of a model while it opens, per downloaded byte, when the variant gives no primitive count.
const MEMORY_PER_DOWNLOAD_BYTE = 8;
// Marks a large model that was still loading, to explain a tab that the browser reloaded after running out of memory.
const PENDING_KEY = "hexels-viewer-pending";
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;
const APPEARANCE = { none: "V1, spatial color", linear: "V2, linear view dependence", sh3: "V3, SH3 view dependence" };
const TIER_LABELS = { compact: "Compact", full: "Full quality" };
const TIER_NOTES = {
  compact:
    "Hexels V2, a fixed population with a linear view-dependent color, stored losslessly. The smallest downloads, which open quickly on most devices.",
  full:
    "Hexels V3, densified, with degree-3 spherical harmonics for view dependence, stored with its SH appearance product-quantized into 1024-entry codebooks (PQ1024). The best quality and the largest downloads; best on a desktop GPU.",
};

const $ = (id) => document.getElementById(id);
const ui = {
  notice: $("viewer-notice"),
  scenes: $("viewer-scenes"),
  title: $("viewer-title"),
  subtitle: $("viewer-subtitle"),
  choice: $("viewer-choice"),
  variants: $("viewer-variants"),
  choiceNote: $("viewer-choice-note"),
  windowLink: $("viewer-window"),
  fullscreen: $("viewer-fullscreen"),
  confirm: $("viewer-confirm"),
  confirmText: $("viewer-confirm-text"),
  confirmYes: $("viewer-confirm-yes"),
  confirmNo: $("viewer-confirm-no"),
  stage: $("viewer-stage"),
  placeholder: $("viewer-placeholder"),
  progress: $("viewer-progress"),
  progressBar: document.querySelector("#viewer-progress .hx-vprogress-bar"),
  status: $("viewer-status"),
  announce: $("viewer-announce"),
  file: $("viewer-file"),
  drop: $("viewer-drop"),
  legend: $("viewer-legend"),
};
const state = {
  scenes: [],
  scene: null,
  variant: null,
  file: null,
  phase: "idle",
  frame: null,
  session: 0,
  pendingFile: null,
  readyTimer: null,
  expectedName: null,
  device: { webgl2: true, maxTextureSize: 0, floatTarget: true, archives: null },
  hosted: false,
  mirror: null,
  // The progress already announced to screen readers: its stage and quarter (0 to 4) of the work.
  announced: { stage: null, quarter: -1 },
};

/* ---------- Small helpers ---------- */

function element(tag, { className, text, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value !== null && value !== undefined) node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}

function formatBytes(bytes) {
  if (!(bytes > 0)) return null;
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

const formatPsnr = (psnr) => (Number.isFinite(psnr) ? `${psnr.toFixed(2)} dB` : null);
const isLocalPage = () => window.location.protocol === "file:" || LOCAL_HOSTNAMES.has(window.location.hostname);
const absolute = (url) => new URL(url, document.baseURI).href;
const vector = (value) => (Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? value : null);
const touchDevice = () => window.matchMedia("(pointer: coarse)").matches;
const lowMemory = () => Number(navigator.deviceMemory) > 0 && Number(navigator.deviceMemory) <= LOW_MEMORY_GB;
const positive = (value) => (Number(value) > 0 ? Number(value) : null);
const finiteOrNull = (value) => (value !== null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null);

/** Show `text` under the stage; screen readers hear it too unless `announce` is false (byte counts while loading). */
function setStatus(text, tone = "", announce = true) {
  ui.status.textContent = text;
  ui.status.dataset.tone = tone;
  if (announce) ui.announce.textContent = text;
}

/** The page-level progress bar under the stage: a share in [0, 1], null for an indeterminate bar, false to hide. */
function setProgress(fraction) {
  ui.progress.hidden = fraction === false;
  if (fraction === false) return;
  const known = Number.isFinite(fraction);
  ui.progressBar.classList.toggle("is-indeterminate", !known);
  ui.progressBar.firstElementChild.style.width = known ? `${(fraction * 100).toFixed(1)}%` : "";
  if (known) ui.progressBar.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
  else ui.progressBar.removeAttribute("aria-valuenow");
}

function showNotice(headline, text, tone = "info") {
  ui.notice.replaceChildren(element("strong", { text: headline }), ` ${text}`);
  ui.notice.dataset.tone = tone;
  ui.notice.hidden = false;
}

/* ---------- Scene data ---------- */

/** A default camera given as an index, a name, or {index, name}; null when absent. */
function cameraRef(value) {
  if (Number.isInteger(value) && value >= 0) return { index: value, name: null };
  if (typeof value === "string" && value) return { index: null, name: value };
  if (value && typeof value === "object") {
    const index = Number.isInteger(value.index) && value.index >= 0 ? value.index : null;
    const name = typeof value.name === "string" && value.name ? value.name : null;
    return index !== null || name ? { index, name } : null;
  }
  return null;
}

function tierOf(variant) {
  const tier = String(variant.tier ?? variant.id ?? "").toLowerCase();
  if (tier.includes("compact")) return "compact";
  if (tier.includes("full")) return "full";
  return tier || null;
}

/** "Compact (Hexels V2)" -> the toggle label "Compact" and the method "Hexels V2". */
function splitLabel(label) {
  const match = /^(.*?)\s*\((.+)\)\s*$/.exec(String(label ?? ""));
  return match ? { short: match[1], method: match[2] } : { short: label ? String(label) : null, method: null };
}

/** Keep only usable scenes and variants; other fields of the data file pass through. */
function normalizeScenes(data) {
  const scenes = Array.isArray(data?.scenes) ? data.scenes : [];
  return scenes
    .map((scene) => {
      const id = String(scene.scene ?? scene.id ?? "");
      const dataset = scene.dataset ?? "mipnerf360";
      const variants = (Array.isArray(scene.variants) ? scene.variants : [])
        .filter((variant) => variant && typeof variant.key === "string" && variant.key)
        .map((variant) => {
          const tier = tierOf(variant);
          const named = splitLabel(variant.label);
          const cameras = variant.cameras ?? scene.cameras;
          return {
            ...variant,
            tier,
            label: TIER_LABELS[tier] ?? named.short ?? "Model",
            method: named.method,
            bytes: positive(variant.bytes),
            rawBytes: positive(variant.raw_bytes),
            psnr: finiteOrNull(variant.psnr),
            primitives: positive(variant.primitives),
            texels: positive(variant.texels),
            camera: cameraRef(variant.default_camera ?? scene.default_camera),
            orbit: vector(variant.orbit_target ?? scene.orbit_target),
            camerasKey: typeof cameras === "string" && cameras ? cameras : null,
          };
        });
      return { ...scene, id, dataset, label: String(scene.label ?? id), thumb: scene.thumb ?? `static/images/thumbs/${dataset}_${id}.webp`, variants };
    })
    .filter((scene) => scene.id && scene.variants.length);
}

/* ---------- What this device can open ---------- */

const formatOf = (variant) => {
  const key = variant.key.split("?")[0].toLowerCase();
  if (key.endsWith(".hexcodec")) return "hexcodec";
  return key.endsWith(".gz") ? "gzip" : "hexview";
};

const gpuBytes = (variant) => variant.rawBytes ?? (variant.primitives && variant.texels ? variant.primitives * variant.texels * 16 : null);

/** Memory a model needs while it opens: the download, the unpacked primitive rows and their GPU copy. */
const memoryEstimate = (variant) => (gpuBytes(variant) ? (variant.bytes ?? 0) + 2 * gpuBytes(variant) : (variant.bytes ?? 0) * MEMORY_PER_DOWNLOAD_BYTE);

/** Null when this device can open the variant, else the reason it cannot. */
function blocker(variant) {
  const { device } = state;
  if (!device.webgl2) return "This browser cannot run the viewer: WebGL2 is unavailable.";
  const format = formatOf(variant);
  if (format === "hexcodec" && device.archives) return device.archives;
  if (format === "gzip" && typeof DecompressionStream !== "function") {
    return "This browser cannot unpack compressed models. Update it (Chrome or Edge 80+, Safari 16.4+, Firefox 114+).";
  }
  if (variant.primitives && variant.texels && device.maxTextureSize && !fitsTexture(variant.primitives * variant.texels, device.maxTextureSize)) {
    return `This model is too large for this GPU's texture limit (${device.maxTextureSize} pixels per side).`;
  }
  return null;
}

/** The variant a scene opens with: the data's default, or on phones and tablets the smallest one that opens. */
function defaultVariant(scene) {
  const open = scene.variants.filter((variant) => !blocker(variant));
  const pool = open.length ? open : scene.variants;
  if (touchDevice()) return pool.reduce((best, variant) => ((variant.bytes ?? Infinity) < (best.bytes ?? Infinity) ? variant : best));
  return pool.find((variant) => variant.default === true) ?? pool[0];
}

function sceneSubtitle(scene, variant) {
  const dataset = scene.dataset === "mipnerf360" ? "Mip-NeRF 360" : scene.dataset;
  const parts = [dataset, scene.setting, variant.method];
  if (variant.primitives) parts.push(`${variant.primitives.toLocaleString("en-US")} primitives`);
  return parts.filter(Boolean).join(" · ");
}

/* ---------- Media URLs ---------- */

/** The data file's local mirror ({key_prefix, folder}), or null. */
function localMirror(data) {
  const mirror = data?.local_mirror;
  if (!mirror || typeof mirror.folder !== "string" || !mirror.folder) return null;
  return { prefix: typeof mirror.key_prefix === "string" ? mirror.key_prefix : "", folder: mirror.folder.replace(/\/+$/, "") };
}

/** URL of a media key: the local mirror on local pages without ?media=, else mediaUrl (static/js/media.js). */
function keyUrl(key) {
  const clean = key.replace(/^\/+/, "");
  const override = new URLSearchParams(window.location.search).has("media");
  const { mirror } = state;
  if (mirror && isLocalPage() && !override && clean.startsWith(mirror.prefix)) {
    return absolute(`${mirror.folder}/${clean.slice(mirror.prefix.length)}`);
  }
  const url = mediaUrl(clean);
  return url ? absolute(url) : null;
}

/** The scene's cameras.json: its own key when the data names one, else beside the variant's archive. */
function camerasUrl(variant) {
  const key = variant.camerasKey ?? `${variant.key.split("?")[0].replace(/\/[^/]*$/, "")}/cameras.json`;
  return keyUrl(key);
}

/* ---------- Picker ---------- */

function cardLabel(scene, variant) {
  const details = [scene.setting && `${scene.setting} scene`, formatBytes(variant.bytes) && `${variant.label}, ${formatBytes(variant.bytes)} download`];
  return [scene.label, ...details.filter(Boolean)].join(", ");
}

function renderCards() {
  const cards = state.scenes.map((scene) => {
    const variant = defaultVariant(scene);
    const button = element(
      "button",
      {
        className: "hx-vcard",
        attrs: { type: "button", "aria-pressed": "false", "data-scene": scene.id, "aria-label": cardLabel(scene, variant) },
      },
      [
        element("span", { className: "hx-vcard-thumb" }, [
          element("img", { attrs: { src: scene.thumb, width: "320", height: "208", alt: "", loading: "lazy", decoding: "async" } }),
        ]),
        element("span", { className: "hx-vcard-text" }, [
          element("span", { className: "hx-vcard-name", text: scene.label }),
          element("span", { className: "hx-vsize", text: formatBytes(variant.bytes) ?? "" }),
        ]),
      ],
    );
    if (!state.hosted || blocker(variant)) button.setAttribute("aria-disabled", "true");
    button.addEventListener("click", () => chooseScene(scene));
    return element("li", {}, [button]);
  });
  ui.scenes.replaceChildren(...cards);
  ui.scenes.removeAttribute("aria-busy");
}

function markCards() {
  for (const button of ui.scenes.querySelectorAll(".hx-vcard")) {
    button.setAttribute("aria-pressed", String(button.dataset.scene === state.scene?.id));
  }
}

/** One line per model version: the tier's description, else its method from the data. */
function renderLegend() {
  const seen = new Map();
  for (const scene of state.scenes) {
    for (const variant of scene.variants) {
      const text = TIER_NOTES[variant.tier] ?? (variant.method ? `${variant.method}.` : null);
      if (text && !seen.has(variant.label)) seen.set(variant.label, text);
    }
  }
  if (!seen.size) return;
  ui.legend.replaceChildren(...[...seen].map(([label, text]) => element("li", {}, [element("strong", { text: label }), `: ${text}`])));
  ui.legend.hidden = false;
}

function variantButton(scene, variant) {
  const reason = blocker(variant);
  const button = element(
    "button",
    {
      className: "hx-vvariant",
      attrs: {
        type: "button",
        "aria-pressed": String(variant === state.variant),
        "aria-disabled": reason ? "true" : null,
        "data-tier": variant.tier,
        title: reason ?? variant.method ?? null,
      },
    },
    [
      element("span", { className: "hx-vvariant-label", text: variant.label }),
      element("span", { className: "hx-vvariant-meta" }, [
        element("span", { className: "hx-vsize", text: formatBytes(variant.bytes) ?? "" }),
        element("span", {
          className: "hx-vpsnr",
          text: formatPsnr(variant.psnr) ? `${formatPsnr(variant.psnr)} PSNR` : "",
          attrs: { title: "Mean PSNR on the held-out test views" },
        }),
      ]),
    ],
  );
  button.addEventListener("click", () => {
    if (reason) {
      setStatus(`${variant.label} cannot open on this device. ${reason}`, "error");
      return;
    }
    if (variant !== state.variant || ["error", "canceled", "idle"].includes(state.phase)) openVariant(scene, variant);
  });
  return button;
}

function choiceNote(scene) {
  const full = scene.variants.find((variant) => variant.tier === "full");
  if (!full) return "";
  const reason = blocker(full);
  if (reason) return `Full quality cannot open here: ${reason.replace(/^This /, "this ")}`;
  const size = formatBytes(full.bytes);
  const download = size ? `a ${size} download` : "a large download";
  const ask = touchDevice() ? " On phones and tablets, the page asks before downloading it." : "";
  return `Full quality is ${download} and runs best on a desktop GPU.${ask}`;
}

function renderChoice(scene) {
  ui.variants.replaceChildren(...scene.variants.map((variant) => variantButton(scene, variant)));
  ui.choiceNote.textContent = choiceNote(scene);
  ui.choice.hidden = scene.variants.length < 2 && !ui.choiceNote.textContent;
}

function chooseScene(scene) {
  if (!state.device.webgl2) {
    setStatus("This browser cannot run the viewer: WebGL2 is unavailable.", "error");
    return;
  }
  if (!state.hosted) {
    setStatus("The pretrained models are not hosted yet. You can open a model of your own from disk below.", "error");
    return;
  }
  if (scene === state.scene && ["starting", "loading", "loaded"].includes(state.phase)) {
    revealStage();
    return;
  }
  const variant = defaultVariant(scene);
  const reason = blocker(variant);
  if (reason) {
    setStatus(`${scene.label} cannot open on this device. ${reason}`, "error");
    return;
  }
  openVariant(scene, variant);
}

/* ---------- Large downloads ---------- */

function needsConfirmation(variant) {
  if (variant.tier === "full" && touchDevice()) return true;
  return (variant.bytes ?? 0) >= CONFIRM_BYTES && (touchDevice() || lowMemory());
}

/** Ask before a large download; Cancel puts the bar back to the model that stays on screen. */
function askToConfirm(scene, variant) {
  const previous = { scene: state.scene, variant: state.variant };
  if (scene !== state.scene) {
    Object.assign(state, { scene, variant: null });
    markCards();
    showScene(scene, variant);
  }
  const memory = formatBytes(memoryEstimate(variant));
  const where = touchDevice() ? "Phones and tablets may close the page when they run out of memory." : "This device reports little memory and may close the page.";
  ui.confirmText.textContent =
    `${scene.label} · ${variant.label} downloads ${formatBytes(variant.bytes) ?? "a large file"}` +
    (memory ? ` and needs about ${memory} of memory while it opens. ` : ". ") +
    `${where} Continue?`;
  ui.confirmYes.onclick = () => openVariant(scene, variant, true);
  ui.confirmNo.onclick = () => {
    ui.confirm.hidden = true;
    Object.assign(state, previous);
    markCards();
    if (previous.scene) showScene(previous.scene, previous.variant ?? defaultVariant(previous.scene));
    else {
      ui.title.textContent = state.file?.name ?? "No scene selected";
      ui.choice.hidden = true;
    }
    if (state.phase !== "loaded") setStatus("Download not started.");
  };
  ui.confirm.hidden = false;
  ui.confirmYes.focus();
}

function rememberPending(label) {
  try {
    if (label) sessionStorage.setItem(PENDING_KEY, JSON.stringify({ label, at: Date.now() }));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch (error) {
    console.info(`Session storage unavailable: ${error.message}`);
  }
}

function previousCrash() {
  try {
    const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null");
    sessionStorage.removeItem(PENDING_KEY);
    return pending && Date.now() - pending.at < PENDING_MAX_AGE_MS ? pending.label : null;
  } catch (error) {
    console.info(`Session storage unavailable: ${error.message}`);
    return null;
  }
}

/* ---------- The embedded viewer ---------- */

function revealStage() {
  const bar = $("viewer-bar").getBoundingClientRect();
  const stage = ui.stage.getBoundingClientRect();
  if (bar.top < 0 || stage.bottom > window.innerHeight) $("viewer-bar").scrollIntoView({ block: "start" });
}

/** Replace the viewer iframe with a fresh one; returns its session number. */
function startViewer(query) {
  state.session += 1;
  state.announced = { stage: null, quarter: -1 };
  const params = new URLSearchParams({ embed: "1", session: String(state.session), ...query });
  const frame = element("iframe", {
    className: "hx-vframe",
    attrs: { title: "Hexels 3D viewer", allow: "fullscreen", src: `${VIEWER_PAGE}?${params}` },
  });
  if (state.frame) state.frame.replaceWith(frame);
  else ui.stage.append(frame);
  state.frame = frame;
  ui.placeholder.hidden = true;
  ui.fullscreen.disabled = false;
  clearTimeout(state.readyTimer);
  const session = state.session;
  state.readyTimer = setTimeout(() => {
    if (session === state.session && state.phase === "starting") failLoad("The viewer did not start. Reload the page and try again.");
  }, READY_TIMEOUT_MS);
  return session;
}

function viewerQuery(scene, variant, url) {
  const query = { model: url, name: `${scene.label} · ${variant.label}`, nav: "orbit" };
  const cameras = camerasUrl(variant);
  if (cameras) query.cameras = cameras;
  if (variant.bytes) query.bytes = String(Math.round(variant.bytes));
  if (variant.camera) query.view = variant.camera.name ?? String(variant.camera.index);
  if (variant.orbit) query.orbit = variant.orbit.join(",");
  if (variant.tier === "full" && (window.devicePixelRatio >= 2 || touchDevice())) query.quality = "adaptive";
  return query;
}

function openVariant(scene, variant, confirmed = false) {
  if (!confirmed && needsConfirmation(variant)) {
    askToConfirm(scene, variant);
    return;
  }
  ui.confirm.hidden = true;
  const url = keyUrl(variant.key);
  Object.assign(state, { scene, variant, file: null, phase: "starting", expectedName: `${scene.label} · ${variant.label}` });
  markCards();
  showScene(scene, variant);
  revealStage();
  if (!url) {
    failLoad("The pretrained models are not hosted yet.");
    return;
  }
  const query = viewerQuery(scene, variant, url);
  setStatus(`Starting the viewer for ${scene.label} · ${variant.label}`);
  setProgress(null);
  startViewer(query);
  ui.windowLink.href = `${VIEWER_PAGE}?${new URLSearchParams(query)}`;
  ui.windowLink.hidden = false;
  rememberPending(variant.tier === "full" || (variant.bytes ?? 0) >= CONFIRM_BYTES ? state.expectedName : null);
}

function showScene(scene, variant) {
  ui.title.textContent = scene.label;
  ui.subtitle.textContent = sceneSubtitle(scene, variant);
  renderChoice(scene);
}

function openFile(file) {
  if (!state.device.webgl2) {
    setStatus("This browser cannot run the viewer: WebGL2 is unavailable.", "error");
    return;
  }
  ui.confirm.hidden = true;
  Object.assign(state, { scene: null, variant: null, file, phase: "starting", expectedName: null });
  markCards();
  ui.title.textContent = file.name;
  ui.subtitle.textContent = `Local file · ${formatBytes(file.size) ?? "0 MB"} · read in this browser, never uploaded`;
  ui.choice.hidden = true;
  ui.windowLink.hidden = true;
  setStatus(`Opening ${file.name}`);
  setProgress(null);
  revealStage();
  const query = { nav: "orbit" };
  if (file.size >= CONFIRM_BYTES && (window.devicePixelRatio >= 2 || touchDevice())) query.quality = "adaptive";
  // A local copy of a hosted archive (the same size in bytes) carries no cameras: it opens at its scene's start view
  // with the saved training views, as the hosted copy does.
  const copy = state.scenes.flatMap((scene) => scene.variants).find((variant) => variant.bytes === file.size);
  if (copy) {
    const cameras = camerasUrl(copy);
    if (cameras) query.cameras = cameras;
    if (copy.camera) query.view = copy.camera.name ?? String(copy.camera.index);
    if (copy.orbit) query.orbit = copy.orbit.join(",");
  }
  state.pendingFile = { session: startViewer(query), file };
  rememberPending(file.size >= CONFIRM_BYTES ? file.name : null);
}

function failLoad(message) {
  state.phase = "error";
  rememberPending(null);
  setProgress(false);
  setStatus(message, "error");
}

const PHASE_STEPS = { unzip: "step 1 of 3", decode: "step 2 of 3", pack: "step 3 of 3" };

function progressText({ stage, phase, fraction, done, size }) {
  const percent = Number.isFinite(fraction) ? `${Math.round(fraction * 100)}%` : null;
  if (phase in PHASE_STEPS) return `${stage} (${PHASE_STEPS[phase]})${percent ? `: ${percent}` : ""}`;
  const bytes = size ? `${formatBytes(done) ?? "0.0 MB"} of ${formatBytes(size)}` : formatBytes(done);
  if (bytes) return `${stage}: ${bytes}${percent ? ` (${percent})` : ""}`;
  return stage;
}

/** A visitor-facing explanation of a failed load, by the error kind the viewer reports. */
function errorText(message, kind) {
  const hints = [message || "The model could not be opened."];
  const preview = state.mirror && isLocalPage() && !new URLSearchParams(window.location.search).has("media");
  if (kind === "not-found" && state.variant && preview) hints.push(`This local preview reads ${state.mirror.folder}/, the local copy of the viewer models, which lacks this one.`);
  if (kind === "memory" && state.variant?.tier === "full") hints.push("Compact needs far less memory than Full quality.");
  if (kind === "texture" && state.variant?.tier === "full") hints.push("The Compact version fits this GPU.");
  return hints.join(" ");
}

function onViewerMessage(event) {
  if (event.origin !== window.location.origin || !state.frame || event.source !== state.frame.contentWindow) return;
  const data = event.data ?? {};
  if (data.session !== String(state.session)) return;
  switch (data.type) {
    case "hexels-ready":
      clearTimeout(state.readyTimer);
      if (!data.webgl2) {
        failLoad(data.message || "This browser cannot run the viewer.");
        return;
      }
      if (state.phase === "starting") state.phase = "loading";
      if (state.pendingFile?.session === state.session) {
        state.frame.contentWindow.postMessage({ type: "hexels-open-file", file: state.pendingFile.file }, window.location.origin);
        state.pendingFile = null;
      }
      return;
    case "hexels-progress": {
      if (state.phase === "error") return;
      state.phase = "loading";
      // The line under the stage follows every update (up to ten a second); screen readers hear each new stage and
      // every quarter of it.
      const quarter = Number.isFinite(data.fraction) ? Math.floor(data.fraction * 4) : -1;
      const fresh = data.stage !== state.announced.stage || quarter > state.announced.quarter;
      if (fresh) state.announced = { stage: data.stage, quarter };
      setStatus(progressText(data), "", fresh);
      setProgress(Number.isFinite(data.fraction) ? data.fraction : null);
      return;
    }
    case "hexels-loaded": {
      state.phase = "loaded";
      rememberPending(null);
      setProgress(false);
      if (state.expectedName && data.name !== state.expectedName) {
        // A file dropped straight onto the viewer replaced the scene.
        Object.assign(state, { scene: null, variant: null, expectedName: null });
        markCards();
        ui.title.textContent = data.name || "Local file";
        ui.subtitle.textContent = "Local file · read in this browser, never uploaded";
        ui.choice.hidden = true;
        ui.windowLink.hidden = true;
      }
      const count = Number(data.count).toLocaleString("en-US");
      const appearance = APPEARANCE[data.view_model] ?? data.view_model;
      const how = touchDevice() ? "Drag the scene to orbit." : "Click the scene, then drag to orbit.";
      setStatus(`${data.name || "Model"}: ${count} Hexels (${appearance}), rendered by your GPU. ${how}`, "ok");
      return;
    }
    case "hexels-canceled":
      state.phase = "canceled";
      rememberPending(null);
      setProgress(false);
      setStatus("Loading canceled.");
      return;
    case "hexels-error":
      failLoad(errorText(data.message, data.kind));
      return;
    default:
  }
}

/* ---------- Fullscreen, files and drops ---------- */

function setupFullscreen() {
  const enabled = document.fullscreenEnabled || document.webkitFullscreenEnabled;
  if (!enabled) {
    ui.fullscreen.hidden = true;
    return;
  }
  ui.fullscreen.addEventListener("click", () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document);
      return;
    }
    const request = ui.stage.requestFullscreen ?? ui.stage.webkitRequestFullscreen;
    Promise.resolve(request?.call(ui.stage))
      .then(() => state.frame?.focus())
      .catch((error) => setStatus(`Fullscreen is not available here: ${error.message}`, "error"));
  });
  const update = () => {
    const active = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    ui.fullscreen.querySelector("[data-label]").textContent = active ? "Exit fullscreen" : "Fullscreen";
  };
  document.addEventListener("fullscreenchange", update);
  document.addEventListener("webkitfullscreenchange", update);
}

function setupFiles() {
  // iOS greys out files whose extension it does not know, so it gets an unfiltered picker.
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios) ui.file.removeAttribute("accept");
  ui.file.addEventListener("change", () => {
    const file = ui.file.files[0];
    ui.file.value = "";
    if (file) openFile(file);
  });
  const hasFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  let depth = 0;
  const dragging = (on) => document.body.classList.toggle("hx-vdragging", on);
  window.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    depth += 1;
    dragging(true);
  });
  window.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) dragging(false);
  });
  window.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    dragging(false);
    const file = event.dataTransfer.files[0];
    if (file) openFile(file);
  });
}

/* ---------- Start ---------- */

function deviceSupport() {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) return { webgl2: false, maxTextureSize: 0, floatTarget: false, archives: archiveSupport() };
  const support = {
    webgl2: true,
    maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0,
    floatTarget: Boolean(gl.getExtension("EXT_color_buffer_float")),
    archives: archiveSupport(),
  };
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return support;
}

async function init() {
  window.addEventListener("message", onViewerMessage);
  window.addEventListener("pagehide", () => rememberPending(null));
  setupFullscreen();
  setupFiles();
  const crashed = previousCrash();
  state.device = deviceSupport();
  state.hosted = Boolean(mediaBase());
  if (!state.device.webgl2) {
    showNotice(
      "This browser cannot show the viewer.",
      "It needs WebGL2: use a current Chrome, Edge, Firefox or Safari (15 or newer) with hardware acceleration turned on.",
      "error",
    );
    ui.file.disabled = true;
    ui.drop.classList.add("is-disabled");
  } else if (crashed) {
    showNotice(
      `The page reloaded while ${crashed} was loading.`,
      "The browser probably ran out of memory; try the Compact version, or a computer with more memory.",
      "error",
    );
  } else if (state.device.archives) {
    showNotice("The hosted models need a newer browser.", state.device.archives, "error");
  } else if (!state.hosted) {
    showNotice("The pretrained models are not online yet.", "You can already open a Hexels model of your own from disk below.");
  } else if (!state.device.floatTarget) {
    showNotice("Preview quality only.", "This device cannot blend in floating point, so the viewer shows a lower-precision 8-bit preview.");
  }
  try {
    const data = await loadJSON(DATA_URL);
    state.mirror = localMirror(data);
    state.scenes = normalizeScenes(data);
    if (!state.scenes.length) throw new Error("no scenes with models");
    renderCards();
    renderLegend();
  } catch (error) {
    console.info(`Viewer scenes unavailable: ${error.message}`);
    ui.scenes.removeAttribute("aria-busy");
    ui.scenes.replaceChildren(
      element("li", { className: "hx-vscenes-empty", text: "The scene list is not available right now. You can still open a model from disk below." }),
    );
  }
}

init();
