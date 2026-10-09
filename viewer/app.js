import {parseBundle, parseCameras, navigationRadius} from "./core.js";
import {Controls} from "./controls.js";
import {HexelRenderer} from "./renderer.js";
import {FrameRate, modelDetails} from "./telemetry.js";
import {LoadingNotice, nextPaint} from "./loading.js";
import {LoadError, fetchModel, megabytes, readFileModel} from "./stream.js";
import {ARCHIVE_STAGES, archiveSupport, decodeArchive} from "./archive.js";

// URL parameters: model (URL of a .hexcodec archive or a .hexview bundle), cameras (URL of the scene's
// cameras.json with its saved views), name, bytes (expected download size), view (saved camera, by name or
// index), orbit (x,y,z focus), nav (fly|orbit), quality (full|adaptive), panel (open|closed), scale (0.35 to 1).
// embed=1 marks the copy inside viewer.html; it then reports to the parent page with postMessage
// (hexels-ready, -progress, -loaded, -canceled, -error, each tagged with the session parameter) and
// accepts {type: "hexels-open-file", file} and {type: "hexels-cancel"} from that same-origin parent only.
const element = name => document.getElementById(name);
const canvas = element("viewport");
const parameters = new URLSearchParams(location.search);
const embedded = parameters.get("embed") === "1" && window.parent !== window;
const session = parameters.get("session") || "";
const modes = ["rgb", "primitives", "wireframe", "depth", "normals", "opacity"];
const notes = {
    rgb: "Soft boundary, spatial color and trained view dependence.",
    primitives: "Diagnostic IDs, not RGB: each hexagon in a flat random color.",
    wireframe: "Colored hexagon boundaries, not a fused or watertight mesh.",
    depth: "Alpha-weighted depth preview; Depth range sets the white point.",
    normals: "Camera-facing normals, blended per primitive.",
    opacity: "Accumulated coverage, not per-primitive opacity.",
};
const appearance = {none: "V1, spatial color", linear: "V2, linear view dependence", sh3: "V3, SH3 view dependence"};
// Touch screens get touch wording; the keys and the wheel need a keyboard and a mouse.
const hints = matchMedia("(pointer: coarse)").matches ? {
    fly: "Drag to look · pinch to move · two fingers to pan · the arrow pad walks",
    orbit: "Drag to orbit · pinch to zoom · two fingers to pan",
} : {
    fly: "Click the scene · drag to look · WASD move · Q/E down/up · Shift faster · ? help",
    orbit: "Click the scene · drag to orbit · scroll to zoom · WASD move · O fly mode · ? help",
};
let dirty = true, sortDirty = true, renderer = null, metadata = null, worker = null, current = null;
let generation = 0, sorting = false, sortMs = 0, frameMs = 16, lastTime = performance.now();
let scaleFactor = 1, lastStats = 0, lastAdaptation = 0;
const displayedFrames = new FrameRate();
const controls = new Controls(canvas, navigation => {
    dirty = true; sortDirty = true;
    if (navigation) setNavigation(navigation);
}, {wheelNeedsFocus: embedded});
const status = message => { element("status").textContent = message; };
const loading = new LoadingNotice(element("loading-notice"), status);
const post = (type, data = {}) => { if (embedded) window.parent.postMessage({type, session, ...data}, location.origin); };

function fail(error) {
    console.error(error);
    status(error.message || String(error));
}

const welcomeText = [element("welcome-title").textContent, element("welcome-text").textContent];

/** Show a problem in the empty stage (no model on screen) or in the status bar (a model stays on screen). */
function problem(title, message) {
    status(message);
    if (metadata) return;
    element("welcome-title").textContent = title;
    element("welcome-text").textContent = message;
    element("welcome").classList.add("is-error");
    element("welcome").hidden = false;
}

function clearProblem() {
    element("welcome").classList.remove("is-error");
    [element("welcome-title").textContent, element("welcome-text").textContent] = welcomeText;
}

function setNavigation(navigation) {
    controls.navigation = navigation;
    element("navigation").value = navigation;
    element("navigation-hint").textContent = hints[navigation];
}

function setPanel(open) {
    element("panel").hidden = !open;
    element("touch-pad").hidden = open;
    element("toggle-panel").setAttribute("aria-expanded", String(open));
}

const vector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? value.map(Number) : null;

function presetsFromUrl() {
    const bytes = Number(parameters.get("bytes"));
    const view = parameters.get("view");
    return {
        name: parameters.get("name") || null,
        bytes: bytes > 0 ? bytes : null,
        view: view && /^\d+$/.test(view) ? Number(view) : null,
        viewName: view && !/^\d+$/.test(view) ? view : null,
        orbit: vector((parameters.get("orbit") || "").split(",").filter(Boolean).map(Number)),
        camerasUrl: parameters.get("cameras") || null,
    };
}

/** Saved views of a hosted scene; a missing or broken cameras.json only costs the presets, never the model. */
async function fetchCameras(url, signal) {
    try {
        const response = await fetch(new URL(url, location.href), {signal});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return parseCameras(await response.json());
    } catch (error) {
        if (!signal.aborted) console.info(`Saved views unavailable from ${url}: ${error.message}`);
        return null;
    }
}

/**
 * Starting view and orbit focus: URL presets first (view by name, then by index), then the defaults that
 * cameras.json or the bundle carries (default_camera by name or index, orbit_target).
 */
function applyPresets(info, presets, saved) {
    if (saved?.cameras.length) info.cameras = saved.cameras;
    const cameras = info.cameras || [];
    const bundled = saved?.defaultCamera ?? info.default_camera;
    const byName = name => typeof name === "string" ? cameras.findIndex(camera => camera.name === name) : -1;
    const candidates = [
        byName(presets.viewName), presets.view,
        byName(typeof bundled === "string" ? bundled : bundled?.name), typeof bundled === "number" ? bundled : bundled?.index,
    ];
    info.default_view = candidates.find(index => Number.isInteger(index) && index >= 0 && index < cameras.length) ?? 0;
    const orbit = presets.orbit || saved?.orbitTarget || vector(info.orbit_target);
    if (orbit) info.orbit_target = orbit; else delete info.orbit_target;
    const generic = !info.name || info.name === "model";
    info.name = presets.name || (presets.file && generic ? presets.file : info.name);
}

function scene(info) {
    metadata = info;
    controls.reset(info);
    element("scene-name").textContent = info.name || `Hexels · ${info.count.toLocaleString()} primitives`;
    element("scene-chip").textContent = element("scene-name").textContent;
    element("scene-chip").hidden = false;
    element("intro").textContent = `${appearance[info.view_model] || info.view_model} · ${info.count.toLocaleString()} Hexels`;
    element("model-details").textContent = modelDetails(info);
    element("welcome").hidden = true;
    element("depth-scale").value = Math.max(1, navigationRadius(info) * 4).toFixed(2);
    element("camera").replaceChildren(new Option("Free camera", "-1"));
    info.cameras?.forEach((camera, index) => element("camera").add(new Option(camera.name, String(index))));
    if (info.cameras?.length) element("camera").value = String(info.default_view);
    dirty = true; sortDirty = true;
}

function stillCurrent(token) {
    if (token.controller.signal.aborted) throw new LoadError("Loading canceled.", "aborted");
    return token === current;
}

function stage(text, phase) {
    loading.stage(text);
    post("hexels-progress", {stage: text, phase, fraction: null});
}

/** Decode a .hexcodec archive in the worker, showing each decoder stage with its own progress bar. */
async function decode(source, token) {
    const unsupported = archiveSupport();
    if (unsupported) throw new LoadError(unsupported, "unsupported");
    const names = Object.keys(ARCHIVE_STAGES);
    let shown = null, lastPost = 0;
    const onStage = (name, fraction) => {
        if (token !== current) return;
        const label = ARCHIVE_STAGES[name] || "Decoding the model";
        const step = names.includes(name) ? `Step ${names.indexOf(name) + 1} of ${names.length}` : null;
        if (name !== shown) {
            shown = name;
            loading.stage(label);
        }
        loading.progress({fraction, done: 0, size: null, note: step});
        const now = performance.now();
        if (now - lastPost > 100 || fraction === 1) {
            lastPost = now;
            post("hexels-progress", {stage: label, phase: name, fraction, step});
        }
    };
    onStage("unzip", 0);
    const {rows, meta} = await decodeArchive(source.buffer, {signal: token.controller.signal, onStage});
    meta.archive_bytes = source.received;
    return {info: meta, rows};
}

async function load(source, presets, token) {
    let info, rows;
    if (source.format === "hexcodec") {
        ({info, rows} = await decode(source, token));
    } else {
        stage(`Checking ${megabytes(source.buffer.byteLength)} of model data`, "check");
        await nextPaint();
        if (!stillCurrent(token)) return false;
        ({metadata: info, rows} = parseBundle(source.buffer));
        info.bundle_bytes = source.buffer.byteLength;
    }
    if (!stillCurrent(token)) return false;
    const saved = presets.cameras ? await presets.cameras : null;
    if (!stillCurrent(token)) return false;
    applyPresets(info, presets, saved);
    displayedFrames.times = [];
    stage(`Uploading ${info.count.toLocaleString()} primitives to the GPU`, "upload");
    loading.progress({fraction: null, done: 0, size: null, note: `${megabytes(rows.byteLength)} of GPU memory`});
    await nextPaint();
    if (!stillCurrent(token)) return false;
    try {
        renderer.load(info, rows);
    } catch (error) {
        metadata = null;
        if (error.kind) throw new LoadError(error.message, error.kind);
        throw error;
    }
    const positions = new Float32Array(info.count * 3);
    for (let index = 0; index < info.count; index++) positions.set(rows.subarray(index * info.texels * 4, index * info.texels * 4 + 3), index * 3);
    worker?.terminate();
    worker = new Worker(new URL("./sort-worker.js", import.meta.url), {type: "module"});
    worker.postMessage({positions}, [positions.buffer]);
    generation++; sorting = false;
    worker.onmessage = ({data}) => {
        if (data.generation !== generation) return;
        renderer.setOrder(data.order); sortMs = data.milliseconds; sorting = false; dirty = true;
    };
    worker.onerror = event => { sorting = false; fail(new Error(event.message)); };
    scene(info);
    status(renderer.floatTarget ? `Loaded · float${renderer.float32Blend ? 32 : 16} blending, close to but not bit-exact with the CUDA renderer` : "Preview only: float framebuffer unavailable, RGB clips per layer");
    return true;
}

/** Load one model; a newer request or Cancel aborts this one, and a canceled load keeps the model on screen. */
async function openModel(read, label, presets) {
    if (!renderer) return;
    current?.controller.abort();
    const token = current = {controller: new AbortController()};
    presets.cameras = presets.camerasUrl ? fetchCameras(presets.camerasUrl, token.controller.signal) : null;
    loading.start(label);
    element("welcome").hidden = true;
    canvas.setAttribute("aria-busy", "true");
    post("hexels-progress", {stage: label, phase: "download", fraction: null, done: 0, size: null});
    let lastProgress = 0;
    const onProgress = progress => {
        const now = performance.now();
        if (token !== current || (now - lastProgress < 100 && progress.fraction !== 1)) return;
        lastProgress = now;
        loading.progress(progress);
        post("hexels-progress", {stage: label, phase: "download", ...progress});
    };
    try {
        await nextPaint();
        const source = await read(token.controller.signal, onProgress);
        if (!stillCurrent(token)) return;
        if (await load(source, presets, token)) {
            post("hexels-loaded", {
                name: metadata.name, count: metadata.count, view_model: metadata.view_model, format: source.format,
                bundle_bytes: metadata.bundle_bytes ?? null, archive_bytes: metadata.archive_bytes ?? null,
                cameras: metadata.cameras?.length ?? 0,
                blending: renderer.float32Blend ? "float32" : renderer.floatTarget ? "float16" : "8-bit preview",
            });
        }
    } catch (error) {
        if (token !== current) return;
        if (error.kind === "aborted") {
            status(metadata ? "Canceled; the previous model stays on screen" : "Canceled");
            post("hexels-canceled");
        } else {
            // Expected failures (wrong file, missing download, too little memory) are shown to the visitor; only
            // unexpected exceptions are console errors.
            if (error instanceof LoadError) console.info(`Model not opened (${error.kind}): ${error.message}`);
            else console.error(error);
            problem("Could not open this model", error.message || String(error));
            post("hexels-error", {message: error.message || String(error), kind: error.kind || "error"});
        }
    } finally {
        if (token === current) {
            current = null;
            loading.stop();
            element("file").value = "";
            canvas.setAttribute("aria-busy", "false");
            element("welcome").hidden = Boolean(metadata);
        }
    }
}

function loadFile(file, presets = {}) {
    clearProblem();
    return openModel((signal, onProgress) => readFileModel(file, {signal, onProgress}), `Reading ${file.name} · ${megabytes(file.size)}`, {...presets, file: file.name});
}

async function loadUrl(url, presets = {}) {
    if (!url) return;
    const parsed = new URL(url, location.href);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Use an HTTP(S) model URL");
    clearProblem();
    const label = presets.name ? `Downloading ${presets.name}` : "Downloading model";
    await openModel((signal, onProgress) => fetchModel(parsed.href, {transferBytes: presets.bytes, signal, onProgress}), label, presets);
}

function download(blob, name) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob); link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function resolution() {
    const adaptive = element("quality").value === "adaptive";
    const density = adaptive ? Math.min(devicePixelRatio, 1.5) : devicePixelRatio;
    let width = Math.round(innerWidth * density * Number(element("resolution").value) * (adaptive ? scaleFactor : 1));
    let height = Math.round(innerHeight * density * Number(element("resolution").value) * (adaptive ? scaleFactor : 1));
    const cap = adaptive ? 1440 * 1080 : 4096 * 2160;
    const reduction = Math.min(1, Math.sqrt(cap / (width * height)), 4096 / Math.max(width, height));
    return [Math.max(16, Math.floor(width * reduction)), Math.max(16, Math.floor(height * reduction))];
}

function updateComparison() {
    const enabled = element("compare-enabled").checked;
    element("comparison-layer").hidden = !enabled;
    element("compare-controls").hidden = !enabled;
    element("comparison-left").textContent = element("mode").selectedOptions[0].text;
    element("comparison-right").textContent = element("compare-mode").selectedOptions[0].text;
    dirty = true;
}

function divider(value) {
    const position = Math.max(0, Math.min(100, value));
    element("comparison-position").value = String(position);
    element("comparison-handle").style.left = `${position}%`;
    element("comparison-handle").setAttribute("aria-valuenow", String(Math.round(position)));
    dirty = true;
}

/** Draw the current view, and the right side of a two-mode comparison, at width x height. */
function draw(width, height) {
    renderer.resize(width, height);
    renderer.render(controls.camera(), modes.indexOf(element("mode").value), Number(element("depth-scale").value));
    if (element("compare-enabled").checked) {
        const split = Math.round(width * Number(element("comparison-position").value) / 100);
        renderer.render(controls.camera(), modes.indexOf(element("compare-mode").value), Number(element("depth-scale").value), [split, width - split]);
    }
}

function frame(now) {
    requestAnimationFrame(frame);
    const elapsed = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;
    if (document.hidden || !metadata || loading.active) return;
    controls.tick(elapsed);
    const adaptive = element("quality").value === "adaptive";
    const budget = adaptive ? Number(element("budget").value) || metadata.count : metadata.count;
    if (sortDirty && !sorting) {
        sorting = true; sortDirty = false;
        worker.postMessage({forward: controls.forward, position: controls.position, budget, generation});
    }
    const [width, height] = resolution();
    if (dirty || canvas.width !== width || canvas.height !== height) {
        draw(width, height);
        dirty = false;
        displayedFrames.record(performance.now());
        frameMs = frameMs * 0.9 + elapsed * 1000 * 0.1;
        if (adaptive && controls.keys.size && now - lastAdaptation > 1000) {
            lastAdaptation = now;
            if (frameMs > 40) scaleFactor = Math.max(0.5, scaleFactor * 0.9);
            if (frameMs < 22) scaleFactor = Math.min(1, scaleFactor * 1.05);
        }
    }
    if (now - lastStats > 500) {
        lastStats = now;
        const detail = adaptive ? "PREVIEW" : "FULL";
        const fps = displayedFrames.value(performance.now()).toFixed(1);
        element("stats").textContent = `${detail} · ${renderer.visible.toLocaleString()} drawn · ${fps} displayed fps · ${sortMs.toFixed(1)} ms sort · ${width}×${height}`;
    }
}

element("file").onchange = event => { const file = event.target.files[0]; if (file) loadFile(file).catch(fail); };
element("load-url").onclick = () => loadUrl(element("model-url").value).catch(fail);
element("loading-cancel").onclick = () => current?.controller.abort();
window.addEventListener("dragover", event => event.preventDefault());
window.addEventListener("drop", event => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) loadFile(file).catch(fail); });
window.addEventListener("message", event => {
    if (event.source !== window.parent || event.origin !== location.origin || !embedded) return;
    const {type, file, name} = event.data || {};
    // The URL's presets apply to a file the page posts: viewer.html passes the saved views of the hosted scene that
    // a local archive copies.
    if (type === "hexels-open-file" && file instanceof Blob) loadFile(file, {...presetsFromUrl(), name: typeof name === "string" ? name : null}).catch(fail);
    if (type === "hexels-cancel") current?.controller.abort();
});
element("mode").onchange = () => { updateComparison(); element("mode-note").textContent = notes[element("mode").value]; };
element("compare-enabled").onchange = updateComparison;
element("compare-mode").onchange = updateComparison;
element("comparison-position").oninput = event => divider(Number(event.target.value));
element("comparison-handle").onpointerdown = event => { event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); };
element("comparison-handle").onpointermove = event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) divider(event.clientX / innerWidth * 100); };
element("comparison-handle").onkeydown = event => {
    const value = Number(element("comparison-position").value);
    const positions = {ArrowLeft: value - 2, ArrowRight: value + 2, Home: 0, End: 100};
    if (event.key in positions) { event.preventDefault(); divider(positions[event.key]); }
};
element("help-toggle").onclick = () => element("help-dialog").showModal();
window.addEventListener("keydown", event => {
    if (event.key === "?" && !/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) element("help-dialog").showModal();
});
element("navigation").onchange = () => setNavigation(element("navigation").value);
element("camera").onchange = () => { const selected = Number(element("camera").value); if (selected >= 0) controls.setView(metadata.cameras[selected]); };
element("reset").onclick = () => metadata && controls.reset(metadata);
element("fullscreen").onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(fail); };
element("toggle-panel").onclick = () => setPanel(element("panel").hidden);
for (const name of ["quality", "resolution", "budget", "depth-scale"]) element(name).oninput = () => { dirty = true; sortDirty = true; element("scale-value").textContent = `${Math.round(Number(element("resolution").value) * 100)}%`; };
element("save-camera").onclick = () => download(new Blob([JSON.stringify(controls.camera(), null, 2)], {type: "application/json"}), "hexels-camera.json");
element("camera-file").onchange = async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
        const camera = JSON.parse(await file.text());
        if (!["position", "forward", "up"].every(name => Array.isArray(camera[name]) && camera[name].length === 3 && camera[name].every(Number.isFinite)) || !(camera.fov >= 10 && camera.fov <= 140)) throw new Error("Invalid camera JSON");
        if (Math.hypot(...camera.forward) < 0.001 || Math.hypot(...camera.up) < 0.001) throw new Error("Camera axes cannot be zero");
        controls.setView(camera);
        element("camera").value = "-1";
    } catch (error) { fail(error); }
};
// The canvas does not keep its drawing buffer between frames, so the view is drawn again and read in the same task.
element("screenshot").onclick = () => {
    if (renderer && metadata && !loading.active) draw(canvas.width, canvas.height);
    canvas.toBlob(blob => blob && download(blob, "hexels-view.png"));
};
window.addEventListener("resize", () => { dirty = true; });
canvas.addEventListener("pointerdown", () => element("navigation-hint").classList.add("dismissed"), {once: true});
canvas.addEventListener("webglcontextlost", event => {
    event.preventDefault();
    metadata = null;
    const message = "The GPU stopped the viewer, often because the model needs more graphics memory than this device has. Reload the page or try a smaller model.";
    problem("The viewer stopped", message);
    post("hexels-error", {message, kind: "memory"});
});

if (embedded) {
    document.body.classList.add("embedded");
    element("url-controls").hidden = true;
    setPanel(false);
} else element("back-link").hidden = false;
if (matchMedia("(pointer: coarse)").matches) { element("quality").value = "adaptive"; setPanel(false); }
if (["full", "adaptive"].includes(parameters.get("quality"))) element("quality").value = parameters.get("quality");
if (["open", "closed"].includes(parameters.get("panel"))) setPanel(parameters.get("panel") === "open");
setNavigation(["fly", "orbit"].includes(parameters.get("nav")) ? parameters.get("nav") : "fly");
if (parameters.has("scale")) {
    const requested = Number(parameters.get("scale"));
    if (Number.isFinite(requested)) element("resolution").value = String(Math.max(0.35, Math.min(1, requested)));
    element("scale-value").textContent = `${Math.round(Number(element("resolution").value) * 100)}%`;
}
if (!document.fullscreenEnabled) element("fullscreen").hidden = true;

try {
    renderer = new HexelRenderer(canvas);
} catch (error) {
    console.error(error);
    element("file").disabled = true;
    element("load-url").disabled = true;
    problem("This browser cannot run the viewer", error.message);
}
post("hexels-ready", {webgl2: Boolean(renderer), message: renderer ? "" : element("welcome-text").textContent});
if (renderer && !renderer.floatTarget) {
    element("quality").value = "adaptive";
    element("quality").options[0].disabled = true;
}
if (renderer && parameters.get("model")) loadUrl(parameters.get("model"), presetsFromUrl()).catch(fail);
requestAnimationFrame(frame);
