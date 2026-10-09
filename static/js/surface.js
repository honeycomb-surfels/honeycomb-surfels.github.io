/**
 * Surface reconstruction viewer: the meshes of two methods next to each other under one shared camera, beside
 * the scene's ground-truth scan.
 *
 * Mount: <div id="surface-root" data-src="static/data/surface_vis.json"></div>
 *
 * The manifest (version 1) lists the methods and, per dataset, a few curated scenes with each method's metric
 * value, mesh (a media key resolved by mediaUrl), camera and notes, plus an optional ablation of Hexels on one
 * dataset. The viewer shows dataset tabs (and an Ablation tab), scene buttons, two rows of method buttons
 * (picking the method shown on the other side swaps the sides, as in the novel-view player), the stage, a
 * toolbar (shading, layout, zoom, reset), the observations for the scene and a table of every method's value.
 * Optional manifest fields add to that table: per-method descriptions ("About the methods"), metric
 * components (accuracy and completeness, precision and recall), the T&T threshold, dataset means (a toggle
 * between the scene and the whole dataset), a second ablation table (table_all15) and caveats.
 *
 * Ground truth: a scene (or an ablation showcase scan, which falls back to its dataset scene's) may carry a
 * reference, {key, bytes, points, label, note}: a glTF binary of the scan's points with normals, in the frame of
 * the scene's meshes and camera, and an optional note on what the scan holds (added to the help under the stage
 * while the scan is on it, and the tooltip of its tag). On wide stages it is a third pane (Side by side: left
 * method, right method, ground truth; Wipe: the wipe of the two methods, then the ground truth beside it), loaded
 * after the two meshes. On narrow stages, where a third stacked pane would not fit one screen, a "Ground truth"
 * toggle (off by default, nothing downloaded until then) shows the scan in place of the second method, so each
 * pane keeps its size; the second row of method buttons, or a tip's "Show me where", gives that pane back to a
 * method. A scene without a reference (or with one not built yet, points 0) shows two panes and no toggle. The
 * points are drawn as round splats sized in world units from the scan's own point spacing (so they grow as the
 * camera closes in), lit by their normals in Clay mode and colored by them in Normals mode, each normal turned
 * toward the camera as the flat-shaded meshes' normals are.
 *
 * Tips: a scene (or an ablation showcase scan) may carry a tip, {text, compare, camera}, shown under the stage
 * as in the novel-view player. "Show me where" puts the primary method (ours, or the full model) on the left
 * and the tip's method on the right, and flies the shared camera to the tip's close-up camera (scene units, as
 * the scene camera) over FLY_MS with an ease-in-out, or at once under prefers-reduced-motion. The stage then
 * reads "Showing where to look" until the visitor moves the camera (on touch screens the label takes the place
 * of "Tap to rotate and zoom" for WHERE_LABEL_MS, then hands it back); Reset view returns to the scene camera.
 *
 * Rendering: one WebGLRenderer draws every pane into one canvas through scissored viewports from one
 * PerspectiveCamera driven by one OrbitControls, so the views are linked by construction. three.js and its
 * loaders come from jsDelivr's +esm builds, imported only when the stage comes near the viewport; meshes (glTF
 * binary, meshopt or Draco compressed) download on demand behind a progress bar, a few recently used ones stay
 * decoded and older ones are disposed (phones keep two meshes and only the reference on the stage). Frames are
 * drawn on demand, never in a constant loop, and not at all while the stage is off screen or the tab is hidden.
 *
 * Input: drag rotates, right-drag or Shift-drag pans, double-click resets the view, and the wheel zooms once the
 * visitor has clicked into the stage (Ctrl or Cmd with the wheel always zooms). On touch screens the stage stays
 * inert, so the page scrolls over it, until a tap activates it; one finger then rotates, two fingers pinch and
 * pan, and "Done", a tap outside or scrolling away releases it. With the stage focused, the arrow keys rotate,
 * + and - zoom and 0 resets.
 *
 * Public API: window.HexelsSurface = { selectScene(view, scene), selectMethods(left, right), showTip(),
 * showGroundTruth(on), state() }, where a view is a dataset id or "ablation", showTip() acts as the current tip's
 * "Show me where", showGroundTruth() sets the narrow stages' toggle and state() reports what the stage shows
 * (for tests and other components).
 */
import { loadJSON, mediaBase, mediaUrl, tipText, whenNear } from "./media.js";

const THREE_VERSION = "0.185.1";
const THREE_CDN = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}`;
// The +esm builds import "three" as /npm/three@VERSION/+esm, so the addons share one copy of three.js
// without an import map. Never mix these URLs with an import map: two copies break instanceof checks.
const MODULES = {
  three: `${THREE_CDN}/+esm`,
  gltf: `${THREE_CDN}/examples/jsm/loaders/GLTFLoader.js/+esm`,
  orbit: `${THREE_CDN}/examples/jsm/controls/OrbitControls.js/+esm`,
  meshopt: `${THREE_CDN}/examples/jsm/libs/meshopt_decoder.module.js/+esm`,
  draco: `${THREE_CDN}/examples/jsm/loaders/DRACOLoader.js/+esm`,
};
const DRACO_DECODERS = `${THREE_CDN}/examples/jsm/libs/draco/gltf/`;

const SIDES = ["left", "right"];
// The stage's panes: the two methods and the scene's reference scan (ground truth).
const PANES = [...SIDES, "reference"];
const ABLATION = "ablation";
const SHADINGS = [
  { id: "clay", label: "Clay" },
  { id: "normals", label: "Normals" },
];
const LAYOUTS = [
  { id: "split", label: "Side by side", stacked: "Stacked" },
  { id: "wipe", label: "Wipe" },
];
const METRIC_SHORT = { chamfer_mm: "Chamfer", f1: "F1" };
// Column names for a scene's metric components (the two halves of a Chamfer distance, or of an F-score).
const COMPONENTS = { accuracy_mm: "Accuracy", completeness_mm: "Completeness", precision: "Precision", recall: "Recall" };
const COUNT_WORDS = { 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine" };
const FULL_VARIANT_IDS = new Set(["full", "ours", "both"]);
const CLAY_COLOR = 0xcac3b7;
const STACK_BELOW_PX = 640;
const DEFAULT_FOV = 35;
// Default view direction (front, slightly above) in the frame whose +y is the scene's up axis.
const DEFAULT_DIRECTION = [0, 0.42, 1];
// Distances in units of the scene camera's distance to its target.
const MIN_DISTANCE = 0.06;
const MAX_DISTANCE = 6;
// A camera pose within this (squared distance, frame units; or 1 - |cos| of half the turn) of the last frame
// drawn needs no new frame.
const POSE_EPSILON = 1e-18;
const ORBIT_KEY_STEP = Math.PI / 24;
const ZOOM_STEP = 1.25;
const SPLIT_KEY_STEP = 2;
const PREFETCH_DELAY_MS = 150;
const HINT_MS = 1800;
const BUFFERS_KEPT = 3;
const MESHOPT_WORKERS = 2;
const DEGREES = Math.PI / 180;
// "Show me where": the camera's flight to a tip's close-up.
const FLY_MS = 700;
// How long "Showing where to look" stands in for "Tap to rotate and zoom" on touch screens (the novel-view
// player's ring also shows for 4 s while its overlays step aside).
const WHERE_LABEL_MS = 4000;
// A tip camera whose up vector turns its view by more than this (about its axis) cannot be shown as is.
const ROLL_TOLERANCE = 1 * DEGREES;
// Reference splats: radius in units of the scan's point spacing (discs that close the gaps of a voxel-thinned
// scan and cover about 99% of a randomly thinned one), the smallest drawn size in device pixels, and the
// subsample that measures the spacing with the points of it whose nearest neighbours are searched (the median
// of 500 is within a few percent).
const SPLAT_RADIUS = 1.2;
const SPLAT_MIN_PX = 1.5;
const SPACING_SAMPLE = 4000;
const SPACING_QUERIES = 500;

const TEXT = {
  noMedia: "The meshes will appear here once the media is hosted.",
  noRuntime: "The 3D viewer could not be loaded. Please check the connection and reload the page.",
  noWebgl: "This browser cannot display the 3D meshes because WebGL is not available.",
  missing: "No mesh of this method is available for this scene.",
  failed: "This mesh could not be loaded.",
  starting: "Loading the 3D viewer",
  activate: "Tap to rotate and zoom",
  wheel: "Click the viewer first to zoom with the scroll wheel",
  unavailable: "The surface comparison could not be loaded.",
  showWhere: "Show me where",
  where: "Showing where to look",
  groundTruth: "Ground truth",
  referenceLoading: "Loading the ground truth",
  referenceFailed: "The ground truth could not be loaded.",
};

const mouseQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
const smallScreen = window.matchMedia("(max-width: 600px)");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/* ---------- Small helpers ---------- */

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
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

/** Replace the children of `node`, skipping missing (null or undefined) ones. */
function fill(node, ...children) {
  node.replaceChildren(...children.filter((child) => child !== null && child !== undefined));
}

function icon(name) {
  return el("i", { class: `fa-solid fa-${name}`, "aria-hidden": "true" });
}

function dot() {
  return el("span", { class: "hx-surf-dot", "aria-hidden": "true" });
}

function otherSide(side) {
  return side === "left" ? "right" : "left";
}

function sceneLabel(id) {
  const scan = /^scan(\d+)$/i.exec(id);
  return scan ? `Scan ${scan[1]}` : id;
}

function textList(value) {
  return (Array.isArray(value) ? value : []).filter((item) => typeof item === "string" && item.trim());
}

/** A finite number or null. */
function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** An array of three finite numbers, or null. */
function vector3(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? value : null;
}

/** The part of `vector` perpendicular to `axis`, normalized, or null when they are parallel. */
function perpendicular(vector, axis) {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const along = dot(vector, axis) / dot(axis, axis);
  const rest = vector.map((value, index) => value - along * axis[index]);
  const length = Math.hypot(...rest);
  return length > 1e-9 ? rest.map((value) => value / length) : null;
}

/* ---------- Metrics ---------- */

/** Display rules for a manifest metric ({id, label, better, decimals}). */
function metricInfo(metric) {
  const label = metric.label ?? metric.id;
  const unit = metric.unit ?? /\(([^)]*)\)\s*$/.exec(label)?.[1] ?? "";
  const name = label.replace(/\s*\([^)]*\)\s*$/, "");
  return {
    id: metric.id,
    label,
    name,
    short: metric.short ?? METRIC_SHORT[metric.id] ?? name,
    unit,
    lower: metric.better !== "higher",
    decimals: Number.isInteger(metric.decimals) ? metric.decimals : 2,
  };
}

/** A value with its unit ("0.648 mm", "51.30%"), or "n/a". */
function formatValue(metric, value) {
  if (number(value) === null) return "n/a";
  const text = value.toFixed(metric.decimals);
  if (!metric.unit) return text;
  return metric.unit === "%" ? `${text}%` : `${text} ${metric.unit}`;
}

/** A value without its unit, for table cells whose header names the unit. */
function formatNumber(metric, value) {
  return number(value) === null ? "n/a" : value.toFixed(metric.decimals);
}

/** "Chamfer (mm)" for a table header. */
function withUnit(text, metric) {
  return metric.unit ? `${text} (${metric.unit})` : text;
}

/** A component key such as "accuracy_mm" or "recall" as a column name. */
function componentName(key) {
  if (COMPONENTS[key]) return COMPONENTS[key];
  const text = key.replace(/_(mm|m|percent)$/, "").replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function countWord(count) {
  return COUNT_WORDS[count] ?? String(count);
}

/** True when `value` is strictly better than `other` (both finite). */
function isBetter(metric, value, other) {
  if (number(value) === null || number(other) === null || value === other) return false;
  return metric.lower ? value < other : value > other;
}

/** The best finite value of a list, or null. */
function bestOf(metric, values) {
  const finite = values.filter((value) => number(value) !== null);
  if (!finite.length) return null;
  return metric.lower ? Math.min(...finite) : Math.max(...finite);
}

function arrow(metric) {
  return metric.lower ? "↓" : "↑";
}

/* ---------- Manifest ---------- */

/** The meshes of a scene that name a known method and a key; reports the others. */
function validMeshes(meshes, ids, where) {
  const valid = {};
  for (const [id, mesh] of Object.entries(meshes ?? {})) {
    if (!ids.has(id)) {
      console.warn(`surface_vis.json: ${where} has a mesh for the unknown method "${id}"`);
    } else if (typeof mesh?.key !== "string" || !mesh.key) {
      console.warn(`surface_vis.json: the ${id} mesh of ${where} has no key`);
    } else {
      valid[id] = { key: mesh.key, bytes: Number(mesh.bytes) || 0, faces: Number(mesh.faces) || 0, poster: mesh.poster ?? null };
    }
  }
  return valid;
}

/**
 * A scene's optional tip: its text without the "Tip:" label (a string tip is text only), the method that
 * "Show me where" puts next to `primary`, and its close-up camera ({position, target, up, fov, aspect} in scene
 * units, as the scene camera). A tip without a usable camera keeps its text but gets no "Show me where".
 */
function parseTip(tip, scene, meshes, ids, primary, where) {
  const text = tipText(tip);
  if (!text) return null;
  let compare = tip?.compare ?? null;
  if (compare !== null && (!ids.has(compare) || compare === primary)) {
    console.warn(`surface_vis.json: the tip of ${where} compares with "${compare}", which is not another method of the view`);
    compare = null;
  } else if (compare !== null && !meshes[compare]) {
    console.warn(`surface_vis.json: the tip of ${where} compares with "${compare}", which has no mesh there`);
  }
  const camera = tip?.camera ?? null;
  const position = vector3(camera?.position);
  const target = vector3(camera?.target);
  const usable = Boolean(position && target && position.some((value, axis) => value !== target[axis]));
  if (camera && !usable) console.warn(`surface_vis.json: the tip camera of ${where} needs a position and a distinct target`);
  // The viewer keeps the scene's up axis (its orbit axis), so a tip camera rolled away from it would not show
  // the view it was checked with.
  const tipUp = usable ? vector3(camera.up) : null;
  if (tipUp) {
    const view = target.map((value, axis) => value - position[axis]);
    const ours = perpendicular(vector3(scene.camera?.up) ?? [0, 1, 0], view);
    const theirs = perpendicular(tipUp, view);
    if (ours && theirs && ours.reduce((sum, value, axis) => sum + value * theirs[axis], 0) < Math.cos(ROLL_TOLERANCE)) {
      console.warn(`surface_vis.json: the tip camera of ${where} is rolled away from the scene's up axis, which the viewer keeps`);
    }
  }
  return { text, compare, camera: usable ? camera : null };
}

/**
 * A scene's optional ground-truth reference ({key, bytes, points, label, note}), or null. A scene without one
 * simply has no reference pane, and so does one whose scan is planned but not built yet (points 0, the manifest
 * build's placeholder); only an entry without a key is reported.
 */
function parseReference(reference, where) {
  if (reference === undefined || reference === null || reference.points === 0) return null;
  if (typeof reference?.key !== "string" || !reference.key) {
    console.warn(`surface_vis.json: the reference of ${where} has no key`);
    return null;
  }
  const label = typeof reference.label === "string" && reference.label.trim() ? reference.label.trim() : TEXT.groundTruth;
  const note = typeof reference.note === "string" ? reference.note.trim() : "";
  return { key: reference.key, bytes: Number(reference.bytes) || 0, points: Number(reference.points) || 0, label, note };
}

function parseScene(scene, ids, where, primary = null) {
  const meshes = validMeshes(scene.meshes, ids, where);
  return {
    id: scene.id,
    label: scene.label ?? sceneLabel(scene.id),
    metrics: scene.metrics ?? {},
    // Optional per-method parts of the metric, {method: {accuracy_mm, completeness_mm}} or {precision, recall}.
    components: scene.components && typeof scene.components === "object" ? scene.components : null,
    threshold: number(scene.threshold_m),
    meshes,
    reference: parseReference(scene.reference, where),
    camera: scene.camera ?? null,
    notes: textList(scene.notes),
    pair: Array.isArray(scene.default_pair) ? scene.default_pair : null,
    tip: scene.tip ? parseTip(scene.tip, scene, meshes, ids, primary, where) : null,
  };
}

/** An ablation table ({scenes, values, variants?, note?}), restricted to known variants. */
function parseTable(table, variantIds) {
  const scenes = (table?.scenes ?? []).filter((scene) => typeof scene === "string");
  if (!scenes.length) return null;
  const variants = Array.isArray(table.variants) ? table.variants.filter((id) => variantIds.includes(id)) : variantIds;
  return { scenes, variants, values: table.values ?? {}, note: typeof table.note === "string" ? table.note : null };
}

/** The ablation view: its variants act as the methods and its showcase entries as the scenes. */
function parseAblation(ablation, views, methods) {
  const variants = (ablation?.variants ?? []).filter((variant) => variant?.id && variant.label);
  const showcase = (ablation?.showcase ?? []).filter((entry) => entry?.scene);
  if (variants.length < 2 || !showcase.length) {
    if (ablation) console.warn("surface_vis.json: the ablation needs two variants and a showcase scene");
    return null;
  }
  const base = views.find((view) => view.id === ablation.dataset) ?? null;
  const metric =
    base?.metric ?? metricInfo({ id: "chamfer_mm", label: "Chamfer distance (mm)", better: "lower", decimals: 3 });
  const oursRun = methods.find((method) => method.id === "ours")?.run;
  let fullFound = false;
  let tone = 0;
  const list = variants.map((variant) => {
    const full =
      !fullFound &&
      (FULL_VARIANT_IDS.has(variant.id) || (oursRun && [oursRun, `${oursRun}_both`].includes(variant.run)));
    fullFound ||= Boolean(full);
    return {
      id: variant.id,
      label: variant.label,
      short: variant.short ?? null,
      description: typeof variant.description === "string" ? variant.description : "",
      tone: full ? "ours" : `variant-${++tone}`,
      full: Boolean(full),
    };
  });
  const ids = new Set(list.map((variant) => variant.id));
  const primary = list.find((variant) => variant.full)?.id ?? null;
  const values = ablation.table?.values ?? {};
  const scenes = showcase.map((entry) => {
    const datasetScene = base?.scenes.find((scene) => scene.id === entry.scene);
    const metrics = Object.fromEntries(
      list.map((variant) => [variant.id, number(values[variant.id]?.[entry.scene])]).filter(([, value]) => value !== null),
    );
    return parseScene(
      {
        id: entry.scene,
        label: entry.label ?? datasetScene?.label,
        metrics,
        meshes: entry.meshes,
        // The scan is the dataset's, so a showcase scan without its own reference uses its dataset scene's.
        reference: entry.reference ?? datasetScene?.reference ?? null,
        camera: entry.camera ?? datasetScene?.camera ?? null,
        notes: entry.notes,
        default_pair: entry.pair,
        tip: entry.tip,
      },
      ids,
      `ablation/${entry.scene}`,
      primary,
    );
  });
  // The contract's table, plus the optional table_all15 (more scans, fewer variants) behind a toggle.
  const variantIds = list.map((variant) => variant.id);
  const tables = [parseTable(ablation.table, variantIds), parseTable(ablation.table_all15, variantIds)].filter(Boolean);
  return {
    id: ABLATION,
    label: "Ablation",
    kind: "ablation",
    title: ablation.title ?? null,
    description: ablation.description ?? null,
    datasetLabel: base?.label ?? ablation.dataset ?? "",
    metric,
    methods: list,
    primary,
    scenes,
    tables,
    sceneName: (id) => base?.scenes.find((scene) => scene.id === id)?.label ?? sceneLabel(id),
  };
}

/** Check and normalize the manifest into views (the datasets, then the ablation). */
function parseManifest(raw) {
  if (raw?.version !== 1) throw new Error(`surface_vis.json: unsupported version ${raw?.version}`);
  const methods = (raw.methods ?? [])
    .filter((method) => method?.id && method.label)
    .map((method) => ({
      id: method.id,
      label: method.label,
      short: method.short ?? null,
      run: method.run ?? null,
      description: typeof method.description === "string" ? method.description : "",
      tone: method.id,
    }));
  if (methods.length < 2) throw new Error("surface_vis.json: needs at least two methods");
  const ids = new Set(methods.map((method) => method.id));
  const primary = ids.has("ours") ? "ours" : null;
  const views = [];
  for (const dataset of raw.datasets ?? []) {
    if (!dataset?.id || !dataset.metric) continue;
    const scenes = (dataset.scenes ?? [])
      .filter((scene) => scene?.id)
      .map((scene) => parseScene(scene, ids, `${dataset.id}/${scene.id}`, primary));
    if (!scenes.length) continue;
    const means = Object.fromEntries(Object.entries(dataset.means ?? {}).filter(([id, value]) => ids.has(id) && number(value) !== null));
    views.push({
      id: dataset.id,
      label: dataset.label ?? dataset.id,
      kind: "dataset",
      metric: metricInfo(dataset.metric),
      methods,
      primary,
      scenes,
      // Optional means over every scene of the dataset (not only the curated ones), for context.
      means: Object.keys(means).length && Number.isInteger(dataset.scene_count) ? { values: means, count: dataset.scene_count } : null,
    });
  }
  const ablation = parseAblation(raw.ablation, views, methods);
  if (ablation) views.push(ablation);
  if (!views.length) throw new Error("surface_vis.json: no scenes");
  return {
    views,
    meshNote: typeof raw.mesh_note === "string" ? raw.mesh_note : null,
    caveats: textList(raw.caveats),
  };
}

/* ---------- three.js runtime and mesh loading ---------- */

// Reference splats, added to the clay, normal and plain materials' shaders: the point size (device pixels) of a
// world-space diameter at the point's depth, and a round footprint once a point is a few pixels across.
const SPLAT_VERTEX_HEAD = "uniform float splatSize;\nuniform float splatMinimum;\nvarying float vSplatSize;\nvoid main() {";
const SPLAT_VERTEX = `#include <project_vertex>
	gl_PointSize = max( splatSize * projectionMatrix[ 1 ][ 1 ] / - mvPosition.z, splatMinimum );
	vSplatSize = gl_PointSize;`;
// Normals turned toward the camera, as the meshes' screen-space normals are, so a scan lights the same from
// either side whatever the orientation of its normals.
const SPLAT_FACING = `
	#ifndef FLAT_SHADED
		vNormal = faceforward( vNormal, mvPosition.xyz, vNormal );
	#endif`;
const SPLAT_FRAGMENT_HEAD = `varying float vSplatSize;
void main() {
	vec2 splatOffset = 2.0 * gl_PointCoord - 1.0;
	if ( vSplatSize > 2.5 && dot( splatOffset, splatOffset ) > 1.0 ) discard;`;

/**
 * Materials for a reference scan's points (THREE.Points): the meshes' clay and normal materials, and a plain clay
 * color for a scan without normals, drawn as splats. `size` holds the splat diameter as device pixels at unit
 * depth and unit focal length (the stage sets it for the reference pane's viewport before drawing it).
 */
function splatMaterials(THREE) {
  const size = { value: 0 };
  const minimum = { value: SPLAT_MIN_PX };
  const splat = (material, facing) => {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.splatSize = size;
      shader.uniforms.splatMinimum = minimum;
      shader.vertexShader = shader.vertexShader
        .replace("void main() {", SPLAT_VERTEX_HEAD)
        .replace("#include <project_vertex>", facing ? SPLAT_VERTEX + SPLAT_FACING : SPLAT_VERTEX);
      shader.fragmentShader = shader.fragmentShader.replace("void main() {", SPLAT_FRAGMENT_HEAD);
    };
    // Programs are cached by this key: the splat versions must never be shared with the meshes' materials.
    material.customProgramCacheKey = () => `hexels-splat-${material.type}`;
    return material;
  };
  return {
    size,
    clay: splat(new THREE.MeshStandardMaterial({ color: CLAY_COLOR, roughness: 0.92, metalness: 0 }), true),
    normals: splat(new THREE.MeshNormalMaterial(), true),
    plain: splat(new THREE.MeshBasicMaterial({ color: CLAY_COLOR }), false),
  };
}

let runtimeRequest = null;

/** three.js, the glTF loader with the meshopt decoder, OrbitControls and the shared materials, loaded once. */
function loadRuntime() {
  runtimeRequest ??= Promise.all([
    import(MODULES.three),
    import(MODULES.gltf),
    import(MODULES.orbit),
    import(MODULES.meshopt),
  ]).then(([THREE, { GLTFLoader }, { OrbitControls }, { MeshoptDecoder }]) => {
    // Decoding in workers keeps large meshes from stalling scrolling on phones.
    MeshoptDecoder.useWorkers?.(MESHOPT_WORKERS);
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const materials = {
      // Flat shading takes its normals from screen-space derivatives: they face the camera whatever the
      // triangle winding, so meshes with inconsistent winding shade like every other mesh.
      clay: new THREE.MeshStandardMaterial({
        color: CLAY_COLOR,
        roughness: 0.92,
        metalness: 0,
        flatShading: true,
        side: THREE.DoubleSide,
      }),
      normals: new THREE.MeshNormalMaterial({ flatShading: true, side: THREE.DoubleSide }),
      splat: splatMaterials(THREE),
    };
    let dracoRequest = null;
    const useDraco = () => {
      dracoRequest ??= import(MODULES.draco).then(({ DRACOLoader }) => {
        loader.setDRACOLoader(new DRACOLoader().setDecoderPath(DRACO_DECODERS));
      });
      return dracoRequest;
    };
    return { THREE, OrbitControls, loader, materials, useDraco };
  });
  runtimeRequest.catch(() => {
    runtimeRequest = null;
  });
  return runtimeRequest;
}

/** True when the browser can create a WebGL 2 context, which three.js needs; probed before downloading it. */
function webgl2Available() {
  const gl = document.createElement("canvas").getContext("webgl2");
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
  return Boolean(gl);
}

/** Download `url` into an ArrayBuffer, reporting progress (0 to 1) against Content-Length or `expected` bytes. */
async function fetchBuffer(url, expected, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const length = response.headers.get("Content-Encoding") ? 0 : Number(response.headers.get("Content-Length"));
  const total = length > 0 ? length : expected;
  if (!response.body?.getReader || !total) {
    const buffer = await response.arrayBuffer();
    onProgress(1);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(Math.min(received / total, 0.99));
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress(1);
  return bytes.buffer;
}

/** The extensionsUsed of a glTF binary, read from its JSON chunk. */
function glbExtensions(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(16, true) !== 0x4e4f534a) {
    return [];
  }
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, view.getUint32(12, true))));
  return json.extensionsUsed ?? [];
}

/** Parse a GLB into a mesh entry: its root object, local bounding sphere, triangle count and dispose(). */
async function decodeMesh(runtime, buffer) {
  const { THREE, loader, materials } = runtime;
  if (glbExtensions(buffer).includes("KHR_draco_mesh_compression")) await runtime.useDraco();
  const gltf = await loader.parseAsync(buffer, "");
  const root = gltf.scene;
  const geometries = new Set();
  root.traverse((object) => {
    if (!object.isMesh) return;
    for (const material of [object.material].flat()) material?.dispose();
    object.material = materials.clay;
    geometries.add(object.geometry);
  });
  // Bounds through the node transforms: gltfpack keeps the dequantization scale and offset in the nodes.
  root.updateMatrixWorld(true);
  const sphere = new THREE.Box3().setFromObject(root).getBoundingSphere(new THREE.Sphere());
  let faces = 0;
  for (const geometry of geometries) faces += (geometry.index ?? geometry.attributes.position).count / 3;
  return {
    root,
    sphere,
    faces,
    dispose: () => {
      for (const geometry of geometries) geometry.dispose();
    },
  };
}

/**
 * The spacing of a scan's points, in scene units (the side of the surface area per point), or null when the
 * scan is too small to measure. A pseudo-random sample of at most a fifth of the points (SPACING_SAMPLE) is close
 * to a Poisson sample of the surface whatever the scan's own regularity, and a Poisson sample whose median
 * distance to the nearest neighbour is r holds ln 2 / (pi r^2) points per unit area; the full scan holds
 * total / count times as many. Neighbours are searched in a hashed grid of cells several times the expected
 * distance, for the first SPACING_QUERIES sample points (a point without one in its 27 cells counts as farthest).
 */
function pointSpacing(THREE, clouds) {
  const attributes = clouds.map((cloud) => cloud.geometry.attributes.position);
  const total = attributes.reduce((sum, attribute) => sum + attribute.count, 0);
  const count = Math.min(SPACING_SAMPLE, Math.floor(total / 5));
  if (count < 64) return null;
  // A fixed 32-bit linear congruential sequence, so a scan always gets the same splats.
  let seed = 0x2545f491;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const points = new Float64Array(count * 3);
  const point = new THREE.Vector3();
  const box = new THREE.Box3();
  for (let i = 0; i < count; i += 1) {
    let index = Math.floor(random() * total);
    let cloud = 0;
    while (index >= attributes[cloud].count) index -= attributes[cloud++].count;
    point.fromBufferAttribute(attributes[cloud], index).applyMatrix4(clouds[cloud].matrixWorld);
    point.toArray(points, i * 3);
    box.expandByPoint(point);
  }
  const [long, middle] = box
    .getSize(new THREE.Vector3())
    .toArray()
    .sort((a, b) => b - a);
  // The expected neighbour distance on a surface as large as the box's largest face, times four; at most 500
  // cells along any axis, so that the cell coordinates (plus one) fit nine bits each in a small-integer key.
  const cell = Math.max(4 * Math.sqrt((long * middle) / count), long / 500);
  if (!(cell > 0)) return null;
  const origin = box.min.toArray();
  const cells = new Int32Array(count * 3);
  for (let i = 0; i < count * 3; i += 1) cells[i] = Math.floor((points[i] - origin[i % 3]) / cell) + 1;
  const key = (x, y, z) => (x * 512 + y) * 512 + z;
  const grid = new Map();
  for (let i = 0; i < count; i += 1) {
    const id = key(cells[i * 3], cells[i * 3 + 1], cells[i * 3 + 2]);
    const list = grid.get(id);
    if (list) list.push(i);
    else grid.set(id, [i]);
  }
  const queries = Math.min(count, SPACING_QUERIES);
  const distances = new Float64Array(queries);
  for (let i = 0; i < queries; i += 1) {
    const [x, y, z] = [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]];
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          for (const j of grid.get(key(cells[i * 3] + dx, cells[i * 3 + 1] + dy, cells[i * 3 + 2] + dz)) ?? []) {
            const squared = (points[j * 3] - x) ** 2 + (points[j * 3 + 1] - y) ** 2 + (points[j * 3 + 2] - z) ** 2;
            // Repeated points (distance 0) are not neighbours.
            if (squared > 0 && squared < best) best = squared;
          }
        }
      }
    }
    distances[i] = Math.sqrt(best);
  }
  distances.sort();
  const median = distances[queries >> 1];
  // Most points without a neighbour nearby: the area of the box's largest face per point instead.
  if (!Number.isFinite(median)) return Math.sqrt((long * middle) / total) || null;
  return median * Math.sqrt((Math.PI * count) / (Math.LN2 * total));
}

/**
 * Parse a reference scan (a GLB of points with normals; a triangle mesh is accepted too) into an entry like
 * decodeMesh's, plus its point count and spacing. The stage gives its objects their materials.
 */
async function decodeReference(runtime, buffer) {
  const { THREE, loader } = runtime;
  if (glbExtensions(buffer).includes("KHR_draco_mesh_compression")) await runtime.useDraco();
  const gltf = await loader.parseAsync(buffer, "");
  const root = gltf.scene;
  const geometries = new Set();
  const clouds = [];
  let faces = 0;
  root.traverse((object) => {
    if (!object.isPoints && !object.isMesh) return;
    for (const material of [object.material].flat()) material?.dispose();
    geometries.add(object.geometry);
    if (object.isPoints) clouds.push(object);
    else faces += (object.geometry.index ?? object.geometry.attributes.position).count / 3;
  });
  root.updateMatrixWorld(true);
  const sphere = new THREE.Box3().setFromObject(root).getBoundingSphere(new THREE.Sphere());
  return {
    root,
    sphere,
    faces,
    points: clouds.reduce((sum, cloud) => sum + cloud.geometry.attributes.position.count, 0),
    spacing: clouds.length ? pointSpacing(THREE, clouds) : null,
    dispose: () => {
      for (const geometry of geometries) geometry.dispose();
    },
  };
}

/**
 * Downloads and decoded meshes by media key. Decoded meshes in use stay; of the others, the most recently used
 * stay while the total is within `limit`, and older ones are disposed. A few prefetched downloads are kept.
 * `decode(runtime, buffer)` turns a download into an entry (decodeMesh, or decodeReference for scans).
 */
class MeshStore {
  constructor(limit, decode = decodeMesh) {
    this.limit = limit;
    this.decode = decode;
    this.entries = new Map();
    this.inUse = new Set();
    this.runtime = null;
    this.clock = 0;
  }

  entry(key) {
    if (!this.entries.has(key)) {
      this.entries.set(key, { key, request: null, buffer: null, decoding: null, mesh: null, progress: 0, listeners: new Set(), used: 0 });
    }
    return this.entries.get(key);
  }

  /** Start (or join) the download of `key`. */
  download(key, url, expected) {
    const entry = this.entry(key);
    if (!entry.mesh && !entry.request) {
      entry.progress = 0;
      entry.request = fetchBuffer(url, expected, (fraction) => {
        entry.progress = fraction;
        for (const listener of entry.listeners) listener(fraction);
      }).then(
        (buffer) => {
          entry.buffer = buffer;
          this.trim();
          return buffer;
        },
        (error) => {
          entry.request = null;
          throw error;
        },
      );
    }
    return entry;
  }

  /** Fetch the bytes of a mesh the visitor is likely to pick next; errors are left to the real load. */
  prefetch(key, url, expected) {
    if (this.entries.get(key)?.mesh) return;
    this.download(key, url, expected).request?.catch(() => {});
  }

  /** The decoded mesh of `key`, downloaded first when needed; `onProgress` follows the download. */
  async mesh(key, url, expected, onProgress) {
    const entry = this.download(key, url, expected);
    entry.used = ++this.clock;
    if (entry.mesh) return entry.mesh;
    entry.listeners.add(onProgress);
    onProgress(entry.progress);
    try {
      entry.decoding ??= entry.request
        .then((buffer) => this.decode(this.runtime, buffer))
        .then(
          (mesh) => {
            mesh.key = key;
            entry.mesh = mesh;
            entry.buffer = null;
            entry.request = null;
            return mesh;
          },
          (error) => {
            // Forget the bytes too, so that a retry downloads the file again.
            Object.assign(entry, { decoding: null, request: null, buffer: null });
            throw error;
          },
        );
      return await entry.decoding;
    } finally {
      entry.listeners.delete(onProgress);
      this.trim();
    }
  }

  /** Mark the meshes on (or about to go on) the stage; they are never disposed. */
  setInUse(keys) {
    this.inUse = new Set(keys.filter(Boolean));
    this.trim();
  }

  trim() {
    const entries = [...this.entries.values()].sort((a, b) => a.used - b.used);
    const decoded = entries.filter((entry) => entry.mesh);
    let excess = decoded.length - this.limit;
    for (const entry of decoded) {
      if (excess <= 0) break;
      if (this.inUse.has(entry.key)) continue;
      entry.mesh.dispose();
      this.entries.delete(entry.key);
      excess -= 1;
    }
    const buffered = entries.filter((entry) => entry.buffer && !entry.mesh && !entry.decoding && !this.inUse.has(entry.key));
    for (const entry of buffered.slice(0, Math.max(0, buffered.length - BUFFERS_KEPT))) this.entries.delete(entry.key);
  }

  decodedKeys() {
    return [...this.entries.values()].filter((entry) => entry.mesh).map((entry) => entry.key);
  }
}

/* ---------- Stage ---------- */

/**
 * The stage: backdrops, the shared canvas (once started), per-pane overlays (label, progress bar, veil and
 * message) for the two methods and the reference scan, the split separators or wipe divider, the touch
 * activation layer and notices. The reference pane is hidden (data-gt "none"), beside the methods ("beside":
 * a third pane, or beside the wipe) or in place of the right method ("swap").
 */
class Stage {
  constructor({ onActivity }) {
    this.onActivity = onActivity;
    this.views = Object.fromEntries(PANES.map((pane) => [pane, this.buildSide(pane)]));
    this.handle = el(
      "div",
      {
        class: "hx-surf-handle",
        role: "slider",
        tabindex: "0",
        "aria-label": "Divider position",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": "50",
      },
      icon("arrows-left-right"),
    );
    this.activator = el(
      "button",
      { type: "button", class: "hx-surf-activate", "aria-label": "Interact with the 3D viewer" },
      el("span", { class: "hx-surf-pill" }, icon("hand-pointer"), ` ${TEXT.activate}`),
    );
    this.done = el("button", { type: "button", class: "hx-surf-done", hidden: true }, "Done");
    this.hint = el("span", { class: "hx-surf-pill hx-surf-hint", "aria-hidden": "true" });
    // Shown while the camera holds a tip's close-up; the viewer's status line announces it.
    this.wherePill = el(
      "span",
      { class: "hx-surf-pill hx-surf-where", "aria-hidden": "true" },
      icon("magnifying-glass-location"),
      ` ${TEXT.where}`,
    );
    this.notice = el("div", { class: "hx-surf-notice", hidden: true });
    this.element = el(
      "div",
      {
        class: "hx-surf-stage",
        tabindex: "0",
        role: "group",
        "aria-roledescription": "3D viewer",
        "data-layout": "split",
        "data-orient": "row",
        "data-gt": "none",
      },
      ...PANES.map((pane) => this.views[pane].backdrop),
      ...PANES.map((pane) => this.views[pane].overlay),
      el("div", { class: "hx-surf-separator", "aria-hidden": "true" }),
      el("div", { class: "hx-surf-separator is-second", "aria-hidden": "true" }),
      el("div", { class: "hx-surf-divider", "aria-hidden": "true" }),
      this.handle,
      this.activator,
      this.done,
      this.hint,
      this.wherePill,
      this.notice,
    );
    this.layout = "split";
    this.orient = "row";
    this.gt = "none";
    this.split = 50;
    this.size = { width: 0, height: 0 };
    this.shading = "clay";
    this.touch = !mouseQuery.matches;
    this.active = false;
    this.engaged = false;
    this.onScreen = false;
    this.renderer = null;
    this.framed = false;
    this.raf = 0;
    this.renders = 0;
    this.shown = { left: null, right: null, reference: null };
    this.hintTimer = 0;
    // A tip's camera flight in progress, whether the camera holds a tip's close-up ("Showing where to look"),
    // and whether the visitor is moving the camera (from their first gesture until the next flight).
    this.flight = null;
    this.where = false;
    this.whereTimer = 0;
    this.userMoving = false;
    this.element.classList.toggle("is-touch", this.touch);
    this.bindInput();
    new ResizeObserver(([entry]) => this.resize(entry.contentRect)).observe(this.element);
    new IntersectionObserver(([entry]) => this.onIntersect(entry.isIntersecting)).observe(this.element);
    document.addEventListener("visibilitychange", () => this.invalidate());
  }

  buildSide(side) {
    const poster = el("img", { class: "hx-surf-poster", alt: "", decoding: "async", hidden: true });
    const bar = el("span");
    const view = {
      backdrop: el("div", { class: `hx-surf-backdrop hx-surf-side-${side}`, "aria-hidden": "true" }, poster),
      poster,
      bar,
      tag: el("span", { class: "hx-surf-tag" }),
      message: el("div", { class: "hx-surf-msg", hidden: true }),
    };
    view.overlay = el(
      "div",
      { class: `hx-surf-view hx-surf-side-${side}` },
      el("div", { class: "hx-surf-veil", "aria-hidden": "true" }),
      el("div", { class: "hx-surf-progress", "aria-hidden": "true" }, bar),
      view.tag,
      view.message,
    );
    return view;
  }

  // Overlays ---------------------------------------------------------------------------------

  setLabel(side, { method, value, better }) {
    const { tag } = this.views[side];
    tag.dataset.method = method.tone;
    tag.replaceChildren(
      dot(),
      el("span", { class: "hx-surf-tag-name" }, method.label),
      el("span", { class: `hx-surf-tag-value${better ? " is-better" : ""}` }, value),
    );
    tag.title = better ? `${method.label}: ${value} (better of the two)` : `${method.label}: ${value}`;
  }

  /** Name the reference pane after the scan (no metric: it is what the methods are scored against). */
  setReferenceLabel(label, note = "") {
    const { tag } = this.views.reference;
    tag.dataset.method = "reference";
    tag.replaceChildren(dot(), el("span", { class: "hx-surf-tag-name" }, label));
    tag.title = note || label;
  }

  /** Show the download progress of `side` (0 to 1), or hide the bar with null. */
  setProgress(side, fraction) {
    const { overlay, bar } = this.views[side];
    overlay.classList.toggle("is-loading", fraction !== null);
    bar.style.transform = `scaleX(${fraction ?? 0})`;
  }

  /** Dim the mesh of `side` while its replacement loads. */
  setStale(side, stale) {
    this.views[side].overlay.classList.toggle("is-stale", stale);
  }

  /** A message over `side`, with an optional action button ({label, onclick}); null clears it. Quiet messages
   * (loading) are a small pill. */
  setMessage(side, text, action = null, quiet = false) {
    const { message } = this.views[side];
    message.hidden = !text;
    message.classList.toggle("is-quiet", quiet);
    message.replaceChildren(
      ...(text ? [el("p", {}, text)] : []),
      ...(text && action ? [el("button", { type: "button", class: "hx-surf-retry", onclick: action.onclick }, action.label)] : []),
    );
  }

  setPoster(side, url) {
    const { poster } = this.views[side];
    poster.hidden = !url;
    if (url && poster.getAttribute("src") !== url) poster.src = url;
    else if (!url) poster.removeAttribute("src");
  }

  /** Cover the stage with `text`, or remove the notice with null. */
  setNotice(text) {
    this.notice.hidden = !text;
    this.notice.replaceChildren(...(text ? [icon("cube"), el("p", {}, text)] : []));
    this.element.classList.toggle("has-notice", Boolean(text));
  }

  setDescription(text) {
    this.element.setAttribute("aria-label", text);
  }

  showHint(text) {
    this.hint.textContent = text;
    this.hint.classList.add("is-shown");
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => this.hint.classList.remove("is-shown"), HINT_MS);
  }

  setLayout(layout) {
    this.layout = layout;
    this.element.dataset.layout = layout;
    this.invalidate();
  }

  /** Where the reference pane goes: "none", "beside" (wide stages) or "swap" (in the right method's place). */
  setReferenceMode(mode) {
    if (mode === this.gt) return;
    this.gt = mode;
    this.element.dataset.gt = mode;
    this.invalidate();
  }

  /** The width (CSS pixels) of the pane that holds the wipe: half the stage when the reference is beside it. */
  wipeWidth() {
    return this.gt === "beside" ? Math.round(this.size.width / 2) : this.size.width;
  }

  setSplit(percent) {
    this.split = clamp(percent, 0, 100);
    this.element.style.setProperty("--hx-surf-split", `${this.split}%`);
    this.handle.setAttribute("aria-valuenow", String(Math.round(this.split)));
    this.invalidate();
  }

  resize({ width, height }) {
    this.size = { width, height };
    const orient = width && width < STACK_BELOW_PX ? "column" : "row";
    if (orient !== this.orient) {
      this.orient = orient;
      this.element.dataset.orient = orient;
      this.onActivity?.("orient");
    }
    if (this.renderer && width && height) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, smallScreen.matches ? 1.5 : 2));
      this.renderer.setSize(width, height, false);
      // A synchronous frame after the drawing buffer is resized avoids a blank flash.
      if (this.canDraw()) this.frame();
    }
  }

  // Input ------------------------------------------------------------------------------------

  bindInput() {
    const { element } = this;
    element.addEventListener("keydown", (event) => this.onKey(event));
    element.addEventListener(
      "pointerdown",
      (event) => {
        if (event.pointerType === "mouse") this.setEngaged(true);
      },
      true,
    );
    element.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "mouse") this.setEngaged(false);
    });
    // Until the visitor clicks into the stage, the wheel scrolls the page; stopping the event here keeps it
    // from reaching OrbitControls on the canvas, and the page still scrolls.
    element.addEventListener(
      "wheel",
      (event) => {
        if (this.engaged || event.ctrlKey || event.metaKey || this.active) return;
        event.stopPropagation();
        if (this.renderer && this.notice.hidden) this.showHint(TEXT.wheel);
      },
      { capture: true, passive: true },
    );
    this.activator.addEventListener("click", () => this.setActive(true));
    this.done.addEventListener("click", () => this.setActive(false));
    this.onOutside = (event) => {
      if (!this.element.contains(event.target)) this.setActive(false);
    };
    this.bindHandle();
  }

  setEngaged(engaged) {
    this.engaged = engaged;
    this.element.classList.toggle("is-engaged", engaged && Boolean(this.renderer));
  }

  /** Touch screens: let one finger orbit (active) or let the page scroll over the stage (inactive). */
  setActive(active) {
    if (active === this.active) return;
    this.active = active;
    this.element.classList.toggle("is-active", active);
    this.done.hidden = !active;
    if (this.controls) this.controls.enabled = !this.touch || active;
    if (active) document.addEventListener("pointerdown", this.onOutside, true);
    else document.removeEventListener("pointerdown", this.onOutside, true);
    this.onActivity?.(active ? "activate" : "release");
  }

  bindHandle() {
    const { handle } = this;
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handle.setPointerCapture(event.pointerId);
      this.element.classList.add("is-dragging");
    });
    handle.addEventListener("pointermove", (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const rect = this.element.getBoundingClientRect();
      // The split is a percentage of the wipe's pane, which starts at the stage's left edge.
      const width = rect.width * (this.size.width ? this.wipeWidth() / this.size.width : 1);
      this.setSplit(((event.clientX - rect.left) / width) * 100);
    });
    const end = (event) => {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      this.element.classList.remove("is-dragging");
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("keydown", (event) => {
      const moves = { ArrowLeft: -SPLIT_KEY_STEP, ArrowRight: SPLIT_KEY_STEP, ArrowDown: -SPLIT_KEY_STEP, ArrowUp: SPLIT_KEY_STEP };
      if (event.key in moves) this.setSplit(this.split + moves[event.key] * (event.shiftKey ? 5 : 1));
      else if (event.key === "Home") this.setSplit(0);
      else if (event.key === "End") this.setSplit(100);
      else return;
      event.preventDefault();
      event.stopPropagation();
    });
  }

  onKey(event) {
    if (event.target !== this.element || !this.controls || !this.framed) return;
    const step = event.shiftKey ? ORBIT_KEY_STEP * 3 : ORBIT_KEY_STEP;
    // The mesh turns the way the arrow points, as it does when dragged in that direction.
    const actions = {
      ArrowLeft: () => this.orbit(step, 0),
      ArrowRight: () => this.orbit(-step, 0),
      ArrowUp: () => this.orbit(0, step),
      ArrowDown: () => this.orbit(0, -step),
      "+": () => this.zoom(1 / ZOOM_STEP),
      "=": () => this.zoom(1 / ZOOM_STEP),
      "-": () => this.zoom(ZOOM_STEP),
      _: () => this.zoom(ZOOM_STEP),
      0: () => this.resetView(),
      Home: () => this.resetView(),
    };
    const action = actions[event.key];
    if (!action || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    action();
  }

  onIntersect(visible) {
    this.onScreen = visible;
    if (visible) this.invalidate();
    else {
      this.setActive(false);
      this.setEngaged(false);
    }
  }

  // Rendering --------------------------------------------------------------------------------

  /** Create the renderer, camera, controls and the scenes of the panes; false when WebGL is not available. */
  start(runtime) {
    const { THREE, OrbitControls } = runtime;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    } catch (error) {
      console.warn("The surface viewer could not create a WebGL context", error);
      return false;
    }
    this.runtime = runtime;
    this.renderer = renderer;
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    const canvas = renderer.domElement;
    canvas.classList.add("hx-surf-canvas");
    canvas.setAttribute("aria-hidden", "true");
    // Above every backdrop, under every overlay.
    this.views.reference.backdrop.after(canvas);

    this.camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, 0.01, 100);
    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, {
      enableDamping: !reducedMotion.matches,
      dampingFactor: 0.14,
      rotateSpeed: 0.8,
      panSpeed: 0.8,
      zoomSpeed: 0.9,
      minDistance: MIN_DISTANCE,
      maxDistance: MAX_DISTANCE,
      screenSpacePanning: true,
      enabled: !this.touch,
    });
    // OrbitControls sets touch-action: none, which would trap page scrolling under a mouse-driven layout
    // on hybrid devices; with a mouse the page keeps vertical panning. Touch screens reach the canvas only
    // after activation, when the controls need every gesture.
    if (!this.touch) canvas.style.touchAction = "pan-y";
    // The controls start a gesture (drag, pinch or wheel) only for the visitor; a gesture that moves the camera
    // ends a tip's "where to look" view, while a click into the stage leaves it.
    this.controls.addEventListener("start", () => this.takeOver());
    this.controls.addEventListener("change", () => {
      if (this.userMoving) this.setWhere(false);
      // At a zoom limit every update() reports a change (the clamped distance and the one read back from the
      // camera differ by rounding), which would draw frames for as long as the camera stays there.
      if (!this.drawnPose()) this.invalidate();
    });
    canvas.addEventListener("dblclick", () => this.resetView());

    this.scenes = {};
    for (const pane of PANES) {
      const scene = new THREE.Scene();
      const world = new THREE.Group();
      world.matrixAutoUpdate = false;
      const holder = new THREE.Group();
      world.add(holder);
      // Clay rig: a soft sky and ground fill plus a key light that follows the camera (placed in render()).
      const key = new THREE.DirectionalLight(0xffffff, 1.8);
      scene.add(world, new THREE.HemisphereLight(0xffffff, 0xa8a297, 1.6), key, key.target);
      this.scenes[pane] = { scene, world, holder, key };
    }
    this.frameMatrix = new THREE.Matrix4();
    // Frame units per scene unit (the frame puts the scene camera at distance 1), for the splat size.
    this.frameScale = 1;
    this.baseFov = DEFAULT_FOV;
    this.referenceAspect = 1;
    // The scene camera's lens, which Reset view restores after a tip's close-up.
    this.home = { fov: DEFAULT_FOV, aspect: 1 };
    this.spherical = new THREE.Spherical();
    this.bounds = new THREE.Sphere(new THREE.Vector3(), 0);
    this.lightOffset = new THREE.Vector3();
    // The camera pose of the last frame drawn (none yet).
    this.drawn = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), target: new THREE.Vector3(), any: false };
    this.setEngaged(this.engaged);
    this.resize(this.element.getBoundingClientRect());
    return true;
  }

  canDraw() {
    return Boolean(this.renderer) && this.framed && this.onScreen && !document.hidden && this.size.width > 0;
  }

  /** Whether the camera holds the pose of the last frame drawn (so a "change" from the controls needs no frame). */
  drawnPose() {
    const { drawn, camera, controls } = this;
    return (
      drawn.any &&
      drawn.position.distanceToSquared(camera.position) < POSE_EPSILON &&
      drawn.target.distanceToSquared(controls.target) < POSE_EPSILON &&
      1 - Math.abs(drawn.quaternion.dot(camera.quaternion)) < POSE_EPSILON
    );
  }

  /** Ask for a frame; frames are drawn on demand and never while the stage is off screen. */
  invalidate() {
    if (this.raf || !this.canDraw()) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.canDraw()) this.frame();
    });
  }

  frame() {
    if (this.flight) this.stepFlight(performance.now());
    // With damping, a moving camera fires "change" from update(), which asks for the next frame.
    this.controls.update();
    this.render();
    // A flight asks for its next frame itself, in case a step moves the camera too little to fire "change".
    if (this.flight) this.invalidate();
  }

  /**
   * Viewports and scissor boxes in CSS pixels, y from the bottom as WebGL expects, of the panes on the stage;
   * a pane that is not on the stage has none. The second method's place goes to the reference in "swap" mode.
   */
  viewports() {
    const { width, height } = this.size;
    const box = (x, y, w, h) => ({ x, y, w, h, sx: x, sw: w, sy: y, sh: h });
    const second = this.gt === "swap" ? "reference" : "right";
    if (this.layout === "wipe") {
      const pane = this.wipeWidth();
      const x = Math.round((pane * this.split) / 100);
      return {
        left: { x: 0, y: 0, w: pane, h: height, sx: 0, sw: x, sy: 0, sh: height },
        [second]: { x: 0, y: 0, w: pane, h: height, sx: x, sw: pane - x, sy: 0, sh: height },
        ...(this.gt === "beside" ? { reference: box(pane, 0, width - pane, height) } : {}),
      };
    }
    if (this.orient === "column") {
      const top = Math.round(height / 2);
      return { left: box(0, height - top, width, top), [second]: box(0, 0, width, height - top) };
    }
    if (this.gt === "beside") {
      const [first, last] = [Math.round(width / 3), Math.round((width * 2) / 3)];
      return { left: box(0, 0, first, height), right: box(first, 0, last - first, height), reference: box(last, 0, width - last, height) };
    }
    const half = Math.round(width / 2);
    return { left: box(0, 0, half, height), [second]: box(half, 0, width - half, height) };
  }

  render() {
    const { renderer, camera, controls } = this;
    const { width, height } = this.size;
    renderer.setViewport(0, 0, width, height);
    renderer.setScissor(0, 0, width, height);
    renderer.clear();
    // Near and far planes hug the meshes on the stage, for depth precision at any zoom.
    const distance = camera.position.distanceTo(this.bounds.center);
    const radius = this.bounds.radius || 1;
    camera.near = Math.max(distance - radius * 1.05, radius * 0.002);
    camera.far = distance + radius * 1.05;
    // The key light follows the camera, above and to the left of the viewer.
    const reach = camera.position.distanceTo(controls.target);
    this.lightOffset.set(-0.45, 0.8, 0.25).multiplyScalar(reach).applyQuaternion(camera.quaternion).add(camera.position);
    const viewports = this.viewports();
    for (const pane of PANES) {
      const view = viewports[pane];
      if (!view || view.sw <= 0 || view.sh <= 0 || view.w <= 0 || view.h <= 0) continue;
      this.project(view.w / view.h);
      renderer.setViewport(view.x, view.y, view.w, view.h);
      renderer.setScissor(view.sx, view.sy, view.sw, view.sh);
      if (pane === "reference") this.sizeSplats(view.h);
      const { scene, key } = this.scenes[pane];
      key.position.copy(this.lightOffset);
      key.target.position.copy(controls.target);
      renderer.render(scene, camera);
    }
    this.drawn.position.copy(camera.position);
    this.drawn.quaternion.copy(camera.quaternion);
    this.drawn.target.copy(controls.target);
    this.drawn.any = true;
    this.renders += 1;
  }

  /**
   * The reference's splat diameter, SPLAT_RADIUS point spacings across, as device pixels at unit depth and unit
   * focal length in a viewport `height` CSS pixels tall (the vertex shader scales it by the projection and the
   * point's depth). Without a measured spacing the splats keep their smallest size.
   */
  sizeSplats(height) {
    const spacing = this.shown.reference?.spacing;
    const diameter = spacing ? 2 * SPLAT_RADIUS * spacing * this.frameScale : 0;
    this.runtime.materials.splat.size.value = (diameter * height * this.renderer.getPixelRatio()) / 2;
  }

  /** Keep the scene camera's field of view, widened on viewports narrower than it was framed for. */
  project(aspect) {
    const { camera } = this;
    const half = DEGREES * (this.baseFov / 2);
    const fov = aspect < this.referenceAspect ? 2 * Math.atan((Math.tan(half) * this.referenceAspect) / aspect) : 2 * half;
    camera.fov = fov / DEGREES;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }

  // Scene frame and meshes -------------------------------------------------------------------

  /**
   * Put every pane's scene in the frame of a manifest camera ({position, target, up, fov, aspect}, scene units) and
   * reset the view to it. The frame maps the target to the origin, the up axis to +y and the camera distance
   * to 1. Without a position or target, `sphere` (a mesh's bounds in scene units) frames the view; without
   * either, the stage waits for a mesh (returns false).
   */
  setFrame(spec, sphere = null) {
    const { THREE } = this.runtime;
    this.leaveTip();
    const vector = (value) => (Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? new THREE.Vector3(...value) : null);
    const up = vector(spec?.up)?.normalize() ?? new THREE.Vector3(0, 1, 0);
    const rotation = new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(0, 1, 0));
    const fov = Number.isFinite(spec?.fov) ? clamp(spec.fov, 5, 120) : DEFAULT_FOV;
    let target = vector(spec?.target);
    let position = vector(spec?.position);
    if (!target || !position || position.distanceTo(target) === 0) {
      if (!sphere) {
        this.framed = false;
        return false;
      }
      target ??= sphere.center.clone();
      const direction = new THREE.Vector3(...DEFAULT_DIRECTION).normalize().applyQuaternion(rotation.clone().invert());
      const distance = (sphere.radius / Math.sin(DEGREES * (fov / 2))) * 0.9;
      position = target.clone().addScaledVector(direction, distance);
    }
    const scale = 1 / position.distanceTo(target);
    this.frameMatrix
      .makeTranslation(-target.x, -target.y, -target.z)
      .premultiply(new THREE.Matrix4().makeRotationFromQuaternion(rotation))
      .premultiply(new THREE.Matrix4().makeScale(scale, scale, scale));
    this.frameScale = scale;
    for (const pane of PANES) {
      const { world } = this.scenes[pane];
      world.matrix.copy(this.frameMatrix);
      world.matrixWorldNeedsUpdate = true;
    }
    this.baseFov = fov;
    this.referenceAspect = Number.isFinite(spec?.aspect) && spec.aspect > 0 ? spec.aspect : 1;
    this.home = { fov: this.baseFov, aspect: this.referenceAspect };
    const { camera, controls } = this;
    controls.minDistance = MIN_DISTANCE;
    controls.maxDistance = MAX_DISTANCE;
    const damping = controls.enableDamping;
    // Without damping, update() drops the inertia left from the previous scene before the new view is saved.
    controls.enableDamping = false;
    controls.update();
    camera.up.set(0, 1, 0);
    camera.position.copy(position).applyMatrix4(this.frameMatrix);
    controls.target.set(0, 0, 0);
    controls.update();
    controls.saveState();
    controls.enableDamping = damping;
    this.framed = true;
    this.updateBounds();
    this.invalidate();
    // A tip requested before the stage had its frame can fly now.
    this.onActivity?.("framed");
    return true;
  }

  /** Forget the frame and take every mesh and scan off the stage (a new scene is coming). */
  clearScene() {
    this.leaveTip();
    this.framed = false;
    for (const pane of PANES) this.show(pane, null);
  }

  /** Put `mesh` (a decoded entry) on `side` (a pane), or clear the pane with null. */
  show(side, mesh) {
    if (!this.renderer) return;
    const { holder } = this.scenes[side];
    holder.clear();
    this.shown[side] = mesh;
    if (mesh) {
      // One object cannot sit in two scenes: should both sides ever show one mesh, the second gets a
      // clone that shares its geometry.
      const object = mesh.root.parent && mesh.root.parent !== holder ? mesh.root.clone() : mesh.root;
      holder.add(object);
      this.applyMaterial(holder);
    }
    this.updateBounds();
    this.invalidate();
  }

  hasMesh(side) {
    return Boolean(this.shown[side]);
  }

  setShading(shading) {
    this.shading = shading;
    if (!this.renderer) return;
    for (const pane of PANES) this.applyMaterial(this.scenes[pane].holder);
    this.invalidate();
  }

  /** The shading's material for meshes, and its splat version for points (plain clay for points without normals). */
  applyMaterial(holder) {
    const { materials } = this.runtime;
    const material = materials[this.shading] ?? materials.clay;
    const splat = materials.splat[this.shading] ?? materials.splat.clay;
    holder.traverse((object) => {
      if (object.isMesh) object.material = material;
      else if (object.isPoints) object.material = object.geometry.attributes.normal ? splat : materials.splat.plain;
    });
  }

  /** The bounding sphere of the meshes and scan on the stage, in the frame (for the near and far planes). */
  updateBounds() {
    if (!this.renderer) return;
    const { THREE } = this.runtime;
    const spheres = PANES.map((pane) => this.shown[pane])
      .filter(Boolean)
      .map((mesh) => mesh.sphere.clone().applyMatrix4(this.frameMatrix));
    if (!spheres.length) {
      this.bounds.set(new THREE.Vector3(), 1);
      return;
    }
    this.bounds.copy(spheres[0]);
    for (const sphere of spheres.slice(1)) this.bounds.union(sphere);
  }

  // Camera -----------------------------------------------------------------------------------

  /** Rotate the camera around the target by azimuth and polar angles (radians). */
  orbit(azimuth, polar) {
    const { THREE } = this.runtime;
    const { camera, controls } = this;
    this.takeOver();
    const offset = camera.position.clone().sub(controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta += azimuth;
    spherical.phi = clamp(spherical.phi + polar, 0.02, Math.PI - 0.02);
    camera.position.copy(controls.target).add(offset.setFromSpherical(spherical));
    controls.update();
  }

  /** Move the camera toward (factor below 1) or away from the target. */
  zoom(factor) {
    if (!this.controls || !this.framed) return;
    const { camera, controls } = this;
    this.takeOver();
    const offset = camera.position.clone().sub(controls.target);
    // The controls' limits: those of the scene view, widened while a tip's close-up needs it.
    offset.setLength(clamp(offset.length() * factor, controls.minDistance, controls.maxDistance));
    camera.position.copy(controls.target).add(offset);
    controls.update();
  }

  resetView() {
    if (!this.controls || !this.framed) return;
    const { controls } = this;
    this.leaveTip();
    // A tip's close-up may have changed the lens and the zoom limits.
    this.baseFov = this.home.fov;
    this.referenceAspect = this.home.aspect;
    controls.minDistance = MIN_DISTANCE;
    controls.maxDistance = MAX_DISTANCE;
    const damping = controls.enableDamping;
    // Without damping, update() also drops any remaining inertia.
    controls.enableDamping = false;
    controls.update();
    controls.reset();
    controls.enableDamping = damping;
    this.invalidate();
  }

  /**
   * Fly the camera to `spec` ({position, target, fov, aspect} in scene units, as a scene camera) over `duration`
   * ms with an ease-in-out, or at once when it is 0, and show "Showing where to look" until the visitor moves
   * the camera. On its way the camera orbits the moving target (log distance, polar angle and the shorter way
   * around), so it never cuts through the meshes; the view keeps the scene's up axis. False before a frame.
   */
  flyTo(spec, duration) {
    if (!this.controls || !this.framed) return false;
    const { THREE } = this.runtime;
    const { camera, controls } = this;
    const damping = controls.enableDamping;
    // Without damping, update() also drops any remaining inertia, so the flight starts from a still camera.
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = damping;
    const target = new THREE.Vector3(...spec.target).applyMatrix4(this.frameMatrix);
    const from = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    const to = new THREE.Spherical().setFromVector3(new THREE.Vector3(...spec.position).applyMatrix4(this.frameMatrix).sub(target));
    // A close-up may sit nearer (or a wide view farther) than the scene view's zoom limits; Reset restores them.
    controls.minDistance = Math.min(MIN_DISTANCE, to.radius);
    controls.maxDistance = Math.max(MAX_DISTANCE, to.radius);
    const turn = THREE.MathUtils.euclideanModulo(to.theta - from.theta + Math.PI, 2 * Math.PI) - Math.PI;
    this.flight = {
      start: performance.now(),
      duration,
      target: [controls.target.clone(), target],
      distance: [Math.log(from.radius), Math.log(to.radius)],
      phi: [from.phi, to.phi],
      theta: [from.theta, from.theta + turn],
      fov: [this.baseFov, Number.isFinite(spec.fov) ? clamp(spec.fov, 5, 120) : this.home.fov],
      aspect: [this.referenceAspect, Number.isFinite(spec.aspect) && spec.aspect > 0 ? spec.aspect : this.home.aspect],
    };
    this.userMoving = false;
    this.setWhere(true);
    if (duration <= 0) {
      this.stepFlight(performance.now());
      controls.update();
    }
    this.invalidate();
    return true;
  }

  /** Place the camera where the flight is at time `now`; the last step ends the flight. */
  stepFlight(now) {
    const { flight, camera, controls } = this;
    const t = flight.duration > 0 ? clamp((now - flight.start) / flight.duration, 0, 1) : 1;
    // Cubic ease-in-out.
    const k = t < 0.5 ? 4 * t ** 3 : 1 - (2 - 2 * t) ** 3 / 2;
    const at = ([start, end]) => start + (end - start) * k;
    controls.target.lerpVectors(flight.target[0], flight.target[1], k);
    this.spherical.set(Math.exp(at(flight.distance)), at(flight.phi), at(flight.theta));
    camera.position.setFromSpherical(this.spherical).add(controls.target);
    this.baseFov = at(flight.fov);
    this.referenceAspect = at(flight.aspect);
    if (t >= 1) this.flight = null;
  }

  /** The visitor takes the camera: a flight stops where it is, and the first move ends "where to look". */
  takeOver() {
    if (this.flight) {
      this.flight = null;
      this.setWhere(false);
    }
    this.userMoving = true;
  }

  /** Stop a flight and end "where to look" (a reset or a new frame). */
  leaveTip() {
    this.flight = null;
    this.setWhere(false);
  }

  /**
   * The camera holds a tip's close-up (or no longer does). On touch screens the "Showing where to look" label
   * (is-where-label) takes the place of "Tap to rotate and zoom" for WHERE_LABEL_MS and then hands it back, so
   * the two pills never stack over the lower view; the state itself lasts until the camera moves.
   */
  setWhere(where) {
    this.where = where;
    this.element.classList.toggle("is-where", where);
    clearTimeout(this.whereTimer);
    const label = where && this.touch;
    this.element.classList.toggle("is-where-label", label);
    if (label) this.whereTimer = setTimeout(() => this.element.classList.remove("is-where-label"), WHERE_LABEL_MS);
  }

  cameraState() {
    if (!this.camera) return null;
    const round = (vector) => vector.toArray().map((value) => Math.round(value * 1e5) / 1e5);
    return { position: round(this.camera.position), target: round(this.controls.target) };
  }
}

/* ---------- Pickers ---------- */

/** Dataset tabs (plus the Ablation tab) in Bulma's toggle style, with arrow-key navigation. */
class Tabs {
  constructor(views, onSelect) {
    this.onSelect = onSelect;
    this.ids = views.map((view) => view.id);
    this.links = new Map();
    const list = el("ul", { role: "tablist", "aria-label": "Surface dataset" });
    for (const view of views) {
      // No example counts: beside the lead's 15-scan and 6-scene means, "DTU (5)" read as the scenes behind them.
      const text = view.label;
      const link = el(
        "a",
        {
          role: "tab",
          tabindex: "-1",
          "aria-selected": "false",
          onclick: () => onSelect(view.id),
          onkeydown: (event) => this.onKey(event, view.id),
        },
        text,
      );
      this.links.set(view.id, link);
      list.append(el("li", { role: "presentation" }, link));
    }
    this.element = el("div", { class: "tabs is-toggle is-toggle-rounded is-small is-centered hx-surf-tabs" }, list);
  }

  onKey(event, id) {
    const moves = { ArrowRight: 1, ArrowLeft: -1 };
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.onSelect(id);
    } else if (event.key in moves) {
      event.preventDefault();
      const index = this.ids.indexOf(id);
      const next = this.ids[(index + moves[event.key] + this.ids.length) % this.ids.length];
      this.onSelect(next);
      this.links.get(next).focus();
    }
  }

  show(id) {
    for (const [viewId, link] of this.links) {
      const active = viewId === id;
      link.parentElement.classList.toggle("is-active", active);
      link.setAttribute("aria-selected", String(active));
      link.tabIndex = active ? 0 : -1;
    }
  }
}

/** Scene buttons of the current view, each with the primary method's value. */
class ScenePicker {
  constructor(onSelect) {
    this.onSelect = onSelect;
    this.buttons = new Map();
    this.element = el("div", { class: "hx-surf-scenes", role: "group", "aria-label": "Scene" });
  }

  render(view) {
    this.buttons.clear();
    const primary = view.methods.find((method) => method.id === view.primary);
    const buttons = view.scenes.map((scene) => {
      const value = primary ? scene.metrics[primary.id] : null;
      const text = formatValue(view.metric, value);
      const button = el(
        "button",
        {
          type: "button",
          class: "hx-surf-scene",
          "aria-pressed": "false",
          "aria-label": primary && number(value) !== null ? `${scene.label}, ${primary.label}: ${view.metric.name} ${text}` : scene.label,
          onclick: () => this.onSelect(scene.id),
        },
        el("span", { class: "hx-surf-scene-name" }, scene.label),
        primary && number(value) !== null
          ? el("span", { class: "hx-surf-scene-value", "data-method": primary.tone, "aria-hidden": "true" }, dot(), text)
          : null,
      );
      this.buttons.set(scene.id, button);
      return button;
    });
    this.element.replaceChildren(...buttons);
  }

  show(sceneId) {
    for (const [id, button] of this.buttons) button.setAttribute("aria-pressed", String(id === sceneId));
  }
}

/** Two rows of method buttons, one per side; a method without a mesh for the scene is disabled. */
class MethodRows {
  constructor({ onPick, onPrefetch }) {
    this.onPick = onPick;
    this.onPrefetch = onPrefetch;
    this.rows = {};
    this.names = {};
    this.prefetchTimer = 0;
    this.element = el("div", { class: "hx-surf-methods" });
  }

  render(methods) {
    const rows = SIDES.map((side) => {
      const buttons = new Map();
      const name = el("span", { class: "hx-surf-row-label" });
      const group = el("div", { class: "hx-surf-method-buttons", role: "group" });
      for (const method of methods) {
        const button = el(
          "button",
          {
            type: "button",
            class: "hx-surf-method",
            "data-method": method.tone,
            "aria-pressed": "false",
            title: method.description || (method.short ? method.label : null),
            onclick: () => this.onPick(side, method.id),
            onpointerenter: (event) => {
              if (event.pointerType !== "mouse") return;
              clearTimeout(this.prefetchTimer);
              this.prefetchTimer = setTimeout(() => this.onPrefetch(method.id), PREFETCH_DELAY_MS);
            },
            onpointerleave: () => clearTimeout(this.prefetchTimer),
            onfocus: () => this.onPrefetch(method.id),
          },
          dot(),
          el("span", {}, method.short ?? method.label),
        );
        buttons.set(method.id, button);
        group.append(button);
      }
      this.rows[side] = buttons;
      this.names[side] = { name, group };
      return el("div", { class: "hx-surf-method-row" }, name, group);
    });
    this.element.replaceChildren(...rows);
  }

  /** Name the rows after where their meshes appear: left and right, or top and bottom when stacked. */
  setNames(stacked) {
    const names = stacked ? { left: "Top", right: "Bottom" } : { left: "Left", right: "Right" };
    for (const side of SIDES) {
      if (!this.names[side]) continue;
      this.names[side].name.textContent = names[side];
      this.names[side].group.setAttribute("aria-label", `${names[side]} method`);
    }
  }

  update(selection, available) {
    for (const side of SIDES) {
      for (const [id, button] of this.rows[side]) {
        const pressed = id === selection[side];
        button.setAttribute("aria-pressed", String(pressed));
        button.disabled = !available.has(id) && !pressed;
      }
      this.reveal(this.rows[side].get(selection[side]));
    }
  }

  /** Scroll a row that overflows (phones) so that its pressed button is visible. */
  reveal(button) {
    const group = button?.parentElement;
    if (!group || group.scrollWidth <= group.clientWidth) return;
    const start = button.offsetLeft - group.offsetLeft;
    const left = Math.min(start - 8, Math.max(group.scrollLeft, start + button.offsetWidth + 8 - group.clientWidth));
    group.scrollTo({ left, behavior: reducedMotion.matches ? "auto" : "smooth" });
  }
}

/** A segmented button group (shading, layout). */
function segmented(label, options, onPick) {
  const buttons = new Map();
  const element = el("div", { class: "hx-surf-seg", role: "group", "aria-label": label });
  for (const option of options) {
    const button = el(
      "button",
      { type: "button", "aria-pressed": "false", onclick: () => onPick(option.id) },
      el("span", { class: option.stacked ? "hx-surf-seg-wide" : null }, option.label),
      option.stacked ? el("span", { class: "hx-surf-seg-stacked" }, option.stacked) : null,
    );
    buttons.set(option.id, button);
    element.append(button);
  }
  return {
    element,
    show: (id) => {
      for (const [optionId, button] of buttons) button.setAttribute("aria-pressed", String(optionId === id));
    },
  };
}

/* ---------- The viewer ---------- */

class SurfaceViewer {
  constructor(root, manifest) {
    this.views = manifest.views;
    this.view = null;
    this.scene = null;
    this.lastScene = new Map();
    this.selection = { left: null, right: null };
    this.sides = { left: { key: null, token: 0, status: "idle" }, right: { key: null, token: 0, status: "idle" } };
    // The scene's reference scan: idle, waiting (for the two meshes), loading, ready, error or none (no reference).
    this.reference = { key: null, token: 0, status: "idle" };
    // Narrow stages: the "Ground truth" toggle, which shows the scan in place of the second method.
    this.groundTruth = false;
    this.shading = "clay";
    this.layout = "split";
    this.base = mediaBase();
    this.runtime = null;
    this.starting = false;
    this.store = new MeshStore(smallScreen.matches ? 2 : 4);
    // Phones keep no scan but the one on the stage; wider screens keep the previous scene's too.
    this.references = new MeshStore(smallScreen.matches ? 0 : 2, decodeReference);

    this.stage = new Stage({ onActivity: (kind) => this.onStageActivity(kind) });
    this.tabs = new Tabs(this.views, (id) => this.selectView(id));
    this.viewNote = el("p", { class: "hx-surf-viewnote" });
    this.scenePicker = new ScenePicker((id) => this.selectScene(id));
    this.methodRows = new MethodRows({
      onPick: (side, id) => this.pickMethod(side, id),
      onPrefetch: (id) => this.prefetch(id),
    });
    this.shadingButtons = segmented("Shading", SHADINGS, (id) => this.setShading(id));
    this.layoutButtons = segmented("Layout", LAYOUTS, (id) => this.setLayout(id));
    // Shown on narrow stages for scenes with a reference (see syncReferencePane).
    this.gtButton = el(
      "button",
      {
        type: "button",
        class: "hx-surf-gt",
        "aria-pressed": "false",
        hidden: true,
        onclick: () => this.setGroundTruth(!this.groundTruth),
      },
      el("span", { class: "hx-surf-gt-switch", "aria-hidden": "true" }),
      el("span", {}, TEXT.groundTruth),
    );
    this.help = el("p", { class: "hx-surf-help" });
    // The scene's tip, as in the novel-view player (hidden without one), and a tip waiting for the stage's frame.
    this.tip = el("p", { class: "hx-tip hx-surf-tip", hidden: true });
    this.pendingTip = null;
    this.notes = el("section", { class: "hx-surf-notes", "aria-label": "Observations" });
    this.scores = el("section", { class: "hx-surf-scores" });
    this.ablation = el("section", { class: "hx-surf-ablation", hidden: true });
    this.ablationTable = 0;
    this.aboutOpen = false;
    this.scoreScope = "scene";
    this.status = el("p", { class: "is-sr-only", role: "status" });
    // One caveat reads as a paragraph under a singular heading, several as a list.
    const single = manifest.caveats.length === 1;
    const caveats = manifest.caveats.length
      ? el(
          "aside",
          { class: "hx-surf-caveats", "aria-label": single ? "Caveat" : "Caveats" },
          el("h3", { class: "hx-surf-caveats-title" }, single ? "Caveat" : "Caveats"),
          single ? el("p", {}, manifest.caveats[0]) : el("ul", {}, ...manifest.caveats.map((text) => el("li", {}, text))),
        )
      : null;
    const toolbar = el(
      "div",
      { class: "hx-surf-toolbar" },
      this.shadingButtons.element,
      this.layoutButtons.element,
      this.gtButton,
      el(
        "div",
        { class: "hx-surf-camera", role: "group", "aria-label": "Camera" },
        el("button", { type: "button", class: "hx-surf-tool is-icon", "aria-label": "Zoom out", title: "Zoom out", onclick: () => this.stage.zoom(ZOOM_STEP) }, icon("minus")),
        el("button", { type: "button", class: "hx-surf-tool is-icon", "aria-label": "Zoom in", title: "Zoom in", onclick: () => this.stage.zoom(1 / ZOOM_STEP) }, icon("plus")),
        el("button", { type: "button", class: "hx-surf-tool", "aria-label": "Reset view", title: "Reset view (double-click)", onclick: () => this.stage.resetView() }, icon("rotate-left"), el("span", { "aria-hidden": "true" }, "Reset view")),
      ),
    );
    this.element = el(
      "div",
      { class: "hx-surf" },
      el("div", { class: "hx-surf-picker" }, this.tabs.element, this.viewNote, this.scenePicker.element, this.methodRows.element),
      this.stage.element,
      toolbar,
      this.help,
      this.tip,
      el("div", { class: "hx-surf-details" }, this.notes, this.scores),
      this.ablation,
      caveats,
      manifest.meshNote ? el("p", { class: "hx-surf-mesh-note" }, manifest.meshNote) : null,
      this.status,
    );
    root.replaceChildren(this.element);

    const width = root.clientWidth || window.innerWidth;
    this.stage.resize({ width, height: 0 });
    this.shadingButtons.show(this.shading);
    this.layoutButtons.show(this.layout);
    this.selectView(this.views[0].id);
    this.updateHelp();
    if (!this.base) this.stage.setNotice(TEXT.noMedia);
    else whenNear(this.stage.element, () => this.start());
  }

  async start() {
    if (this.starting || this.runtime) return;
    if (!webgl2Available()) {
      this.stage.setNotice(TEXT.noWebgl);
      return;
    }
    this.starting = true;
    const waiting = [...SIDES.filter((side) => this.meshOf(side)), ...(this.referenceMode() === "none" ? [] : ["reference"])];
    for (const side of waiting) this.stage.setMessage(side, TEXT.starting, null, true);
    let runtime;
    try {
      runtime = await loadRuntime();
    } catch (error) {
      console.error("The surface viewer could not load three.js", error);
      this.stage.setNotice(TEXT.noRuntime);
      return;
    } finally {
      this.starting = false;
      for (const side of waiting) this.stage.setMessage(side, null);
    }
    if (!this.stage.start(runtime)) {
      this.stage.setNotice(TEXT.noWebgl);
      return;
    }
    this.runtime = runtime;
    this.store.runtime = runtime;
    this.references.runtime = runtime;
    this.showScene();
  }

  // Selection ----------------------------------------------------------------------------------

  selectView(id) {
    const view = this.views.find((item) => item.id === id);
    if (!view) {
      console.warn(`Unknown surface view ${id}`);
      return false;
    }
    if (view === this.view) return true;
    this.view = view;
    this.tabs.show(view.id);
    this.renderViewNote();
    this.scenePicker.render(view);
    this.methodRows.render(view.methods);
    this.methodRows.setNames(this.isStacked());
    this.ablation.hidden = view.kind !== "ablation";
    this.scene = null;
    this.selectScene(this.lastScene.get(view.id) ?? view.scenes[0].id);
    return true;
  }

  selectScene(id) {
    const scene = this.view.scenes.find((item) => item.id === id);
    if (!scene) {
      console.warn(`Unknown surface scene ${this.view.id}/${id}`);
      return false;
    }
    this.scenePicker.show(scene.id);
    if (scene === this.scene) return true;
    this.scene = scene;
    this.lastScene.set(this.view.id, scene.id);
    this.selection = this.defaultPair(scene);
    this.pendingTip = null;
    this.syncReferencePane();
    this.updateSelectionViews();
    this.updateHelp();
    this.renderNotes();
    this.renderTip();
    this.showScene();
    return true;
  }

  /**
   * "Show me where": the primary method on the left and the tip's method on the right, then the shared camera
   * flies to the tip's close-up once the stage has its frame. Works on touch screens without activating the stage.
   */
  showTip() {
    const tip = this.scene?.tip;
    if (!tip?.camera) return false;
    const { primary } = this.view;
    // The tip is about two methods: on a narrow stage the ground truth gives the second pane back.
    const swapped = Boolean(tip.compare && primary) && this.stage.gt === "swap";
    if (swapped) this.groundTruth = false;
    if (tip.compare && primary && (this.selection.left !== primary || this.selection.right !== tip.compare || swapped)) {
      this.selectMethods(primary, tip.compare);
    }
    this.stage.element.scrollIntoView({ block: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" });
    this.pendingTip = tip;
    this.applyTip();
    return true;
  }

  /** Fly to the requested tip once the stage has its frame (three.js or the first mesh may still be loading). */
  applyTip() {
    const tip = this.pendingTip;
    if (!tip || tip !== this.scene.tip || !this.stage.framed) return;
    this.pendingTip = null;
    this.stage.flyTo(tip.camera, reducedMotion.matches ? 0 : FLY_MS);
    this.announce();
  }

  /** The scene's curated pair, repaired when a method has no mesh: the primary method on the left. */
  defaultPair(scene) {
    const ids = this.view.methods.map((method) => method.id);
    const available = ids.filter((id) => scene.meshes[id]);
    const usable = (id) => available.includes(id) || (!available.length && ids.includes(id));
    let [left, right] = scene.pair ?? [];
    if (!usable(left)) left = [this.view.primary, ...available, ...ids].find((id) => id && usable(id));
    if (!usable(right) || right === left) right = [...available, ...ids].find((id) => id !== left && usable(id)) ?? ids.find((id) => id !== left);
    return { left, right };
  }

  /**
   * The swap rule: picking the method shown on the other side swaps the two sides. While the ground truth has
   * the right (bottom) pane of a narrow stage, a pick in that row gives the pane back to the picked method.
   */
  pickMethod(side, id) {
    const next = { ...this.selection };
    const other = otherSide(side);
    if (id === next[other]) next[other] = next[side];
    next[side] = id;
    if (side === "right" && this.stage.gt === "swap") this.groundTruth = false;
    this.selectMethods(next.left, next.right);
  }

  selectMethods(left, right) {
    const ids = new Set(this.view.methods.map((method) => method.id));
    if (!ids.has(left) || !ids.has(right) || left === right) {
      console.warn(`Invalid surface method pair ${left} / ${right}`);
      return false;
    }
    this.selection = { left, right };
    // A pick or a tip may have turned the narrow stages' ground truth off.
    const mode = this.stage.gt;
    this.syncReferencePane();
    this.updateSelectionViews();
    if (this.stage.gt !== mode) this.updateHelp();
    for (const side of SIDES) this.loadSide(side);
    this.loadReference();
    return true;
  }

  /**
   * Where the scene's reference scan goes: beside the methods on wide stages, in place of the right (bottom)
   * method on narrow ones while the Ground truth toggle is on, and nowhere without a reference (or media).
   */
  referenceMode() {
    if (!this.scene?.reference || !this.base) return "none";
    if (this.stage.orient === "row") return "beside";
    return this.groundTruth ? "swap" : "none";
  }

  /** Put the reference pane where referenceMode says, and show the toggle where it applies (narrow stages). */
  syncReferencePane() {
    const mode = this.referenceMode();
    this.stage.setReferenceMode(mode);
    this.gtButton.hidden = !(this.scene?.reference && this.base && this.stage.orient === "column");
    this.gtButton.setAttribute("aria-pressed", String(mode === "swap"));
  }

  /**
   * The narrow stages' toggle: the ground truth in place of the second method, or the method back (wide stages
   * always show the reference and keep the setting for when they narrow). False without a reference.
   */
  setGroundTruth(on) {
    this.groundTruth = Boolean(on);
    this.updateReferenceMode();
    this.announce();
    return Boolean(this.scene?.reference && this.base);
  }

  /** After the orientation, the toggle or the scene changed where the reference goes. */
  updateReferenceMode() {
    this.syncReferencePane();
    if (!this.scene) return;
    this.updateSelectionViews();
    this.updateHelp();
    this.loadReference();
  }

  /** The sides whose methods are on the stage: not the right one while the ground truth has its place. */
  visibleSides() {
    return this.stage.gt === "swap" ? ["left"] : SIDES;
  }

  isStacked() {
    return this.layout === "split" && this.stage.orient === "column";
  }

  method(id) {
    return this.view.methods.find((method) => method.id === id);
  }

  updateSelectionViews() {
    const { metric } = this.view;
    const available = new Set(Object.keys(this.scene.meshes));
    const swapped = this.stage.gt === "swap";
    // While the ground truth has the right (bottom) pane, no button of that row is pressed.
    this.methodRows.update(swapped ? { ...this.selection, right: null } : this.selection, available);
    const values = { left: this.scene.metrics[this.selection.left], right: this.scene.metrics[this.selection.right] };
    for (const side of SIDES) {
      const value = values[side];
      this.stage.setLabel(side, {
        method: this.method(this.selection[side]),
        value: number(value) === null ? `${metric.short} n/a` : `${metric.short} ${formatValue(metric, value)}`,
        // "Better of the two" needs both methods on the stage.
        better: !swapped && isBetter(metric, value, values[otherSide(side)]),
      });
    }
    if (this.scene.reference) this.stage.setReferenceLabel(this.scene.reference.label, this.scene.reference.note);
    this.updateDescription();
    this.renderScores();
    if (this.view.kind === "ablation") this.renderAblationTable();
  }

  updateDescription() {
    const [first, second] = this.isStacked() ? ["top", "bottom"] : ["left", "right"];
    const [left, right] = SIDES.map((side) => this.method(this.selection[side]).label);
    const reference = this.scene.reference?.label;
    const panes = {
      none: `${left} on the ${first}, ${right} on the ${second}`,
      swap: `${left} on the ${first}, ${reference} on the ${second}`,
      beside:
        this.layout === "wipe"
          ? `${left} and ${right} on either side of a divider, ${reference} beside them`
          : `${left} on the left, ${right} in the middle, ${reference} on the right`,
    };
    this.stage.setDescription(
      `${this.scene.label} (${this.view.kind === "ablation" ? `ablation, ${this.view.datasetLabel}` : this.view.label}): ${panes[this.stage.gt]}. ` +
        "Arrow keys rotate, plus and minus zoom, 0 resets the view.",
    );
  }

  updateHelp() {
    const shared = {
      none: "Both meshes share one camera.",
      beside: "The meshes and the ground truth share one camera.",
      swap: "The mesh and the ground truth share one camera.",
    }[this.stage.gt];
    // Narrow stages: what the toggle does, while it is off.
    const toggle = !this.gtButton.hidden && this.stage.gt === "none" ? " Ground truth shows the scan in place of the second mesh." : "";
    const wipe = this.layout === "wipe" ? " Drag the round handle to move the divider." : "";
    // What the scan holds, while it is on the stage.
    const note = this.stage.gt !== "none" && this.scene?.reference?.note ? ` ${this.scene.reference.note}` : "";
    const text = this.stage.touch
      ? `Tap the viewer, then drag to rotate, pinch to zoom and drag two fingers to pan. ${shared}${wipe}${toggle}${note}`
      : `Drag to rotate, right-drag to pan, double-click to reset. To zoom, click the viewer and scroll, or use the buttons. ${shared}${wipe}${toggle}${note}`;
    this.help.textContent = text;
  }

  onStageActivity(kind) {
    if (kind === "framed") {
      this.applyTip();
      return;
    }
    if (kind !== "orient") return;
    this.element?.classList.toggle("is-narrow", this.stage.orient === "column");
    this.methodRows.setNames(this.isStacked());
    // The reference pane moves with the orientation (a third pane, or the toggle); this also refreshes the
    // description and the table.
    this.updateReferenceMode();
  }

  setShading(id) {
    this.shading = id;
    this.shadingButtons.show(id);
    this.stage.setShading(id);
  }

  setLayout(id) {
    this.layout = id;
    this.layoutButtons.show(id);
    this.stage.setLayout(id);
    this.methodRows.setNames(this.isStacked());
    this.updateDescription();
    this.updateHelp();
    if (this.scene) this.renderScores();
  }

  // Meshes -------------------------------------------------------------------------------------

  /** Frame the current scene and load the meshes of both sides, then its reference scan. */
  showScene() {
    for (const state of [...SIDES.map((side) => this.sides[side]), this.reference]) {
      Object.assign(state, { key: null, status: "idle" });
      state.token += 1;
    }
    for (const pane of PANES) {
      this.stage.setProgress(pane, null);
      this.stage.setStale(pane, false);
    }
    this.stage.setMessage("reference", null);
    if (this.runtime) {
      this.stage.clearScene();
      this.stage.setFrame(this.scene.camera);
    }
    for (const side of SIDES) this.loadSide(side);
    this.loadReference();
  }

  meshOf(side) {
    return this.scene.meshes[this.selection[side]] ?? null;
  }

  loadSide(side) {
    const state = this.sides[side];
    const mesh = this.meshOf(side);
    this.stage.setPoster(side, mesh?.poster && this.base ? mediaUrl(mesh.poster) : null);
    if (!this.base) return;
    if (!mesh) {
      state.token += 1;
      Object.assign(state, { key: null, status: "missing" });
      this.stage.show(side, null);
      this.stage.setProgress(side, null);
      this.stage.setStale(side, false);
      this.stage.setMessage(side, TEXT.missing);
      this.syncStore();
      return;
    }
    if (!this.runtime) {
      this.stage.setMessage(side, null);
      return;
    }
    if (state.key === mesh.key && state.status !== "error") return;
    const token = ++state.token;
    Object.assign(state, { key: mesh.key, status: "loading" });
    // The label already names the new method; until its mesh arrives the old one stays, dimmed, under a note.
    this.stage.setMessage(side, `Loading ${this.method(this.selection[side]).label}`, null, true);
    this.stage.setStale(side, this.stage.hasMesh(side));
    this.stage.setProgress(side, 0);
    this.syncStore();
    this.store
      .mesh(mesh.key, mediaUrl(mesh.key), mesh.bytes, (fraction) => {
        if (token === state.token) this.stage.setProgress(side, fraction);
      })
      .then((entry) => {
        if (token !== state.token) return;
        state.status = "ready";
        this.stage.setMessage(side, null);
        this.stage.setProgress(side, null);
        this.stage.setStale(side, false);
        this.stage.show(side, entry);
        this.frameFrom(side, entry);
        this.syncStore();
        this.announce();
        this.loadReference();
      })
      .catch((error) => {
        if (token !== state.token) return;
        console.warn(`The mesh ${mesh.key} could not be loaded`, error);
        state.status = "error";
        this.stage.setProgress(side, null);
        this.stage.setStale(side, false);
        this.stage.show(side, null);
        this.stage.setMessage(side, TEXT.failed, { label: "Try again", onclick: () => this.loadSide(side) });
        const other = this.stage.shown[otherSide(side)];
        if (!this.stage.framed && other) this.stage.setFrame(this.scene.camera, other.sphere);
        this.syncStore();
        this.loadReference();
      });
  }

  /**
   * Load the scene's reference scan once its pane is on the stage, after the two meshes (it waits, under a
   * loading note, while either is still loading), with the meshes' progress bar and failure handling. A scene
   * without a reference has no pane; the scan stays loaded while a narrow stage's toggle hides it.
   */
  loadReference() {
    const state = this.reference;
    const reference = this.scene?.reference;
    if (!reference || !this.base) {
      if (state.status !== "none") {
        state.token += 1;
        Object.assign(state, { key: null, status: "none" });
        this.stage.show("reference", null);
        this.stage.setProgress("reference", null);
        this.stage.setMessage("reference", null);
        this.syncStore();
      }
      return;
    }
    if (!this.runtime || this.referenceMode() === "none") return;
    if (state.key === reference.key && ["loading", "ready"].includes(state.status)) return;
    if (SIDES.some((side) => this.sides[side].status === "loading")) {
      state.status = "waiting";
      this.stage.setMessage("reference", TEXT.referenceLoading, null, true);
      return;
    }
    const token = ++state.token;
    Object.assign(state, { key: reference.key, status: "loading" });
    this.stage.setMessage("reference", TEXT.referenceLoading, null, true);
    this.stage.setStale("reference", this.stage.hasMesh("reference"));
    this.stage.setProgress("reference", 0);
    this.syncStore();
    this.references
      .mesh(reference.key, mediaUrl(reference.key), reference.bytes, (fraction) => {
        if (token === state.token) this.stage.setProgress("reference", fraction);
      })
      .then((entry) => {
        if (token !== state.token) return;
        state.status = "ready";
        this.stage.setMessage("reference", null);
        this.stage.setProgress("reference", null);
        this.stage.setStale("reference", false);
        this.stage.show("reference", entry);
        // Only a scene without a camera whose meshes all failed waits for the scan to frame it.
        if (!this.stage.framed) this.stage.setFrame(this.scene.camera, entry.sphere);
        this.syncStore();
        this.announce();
      })
      .catch((error) => {
        if (token !== state.token) return;
        console.warn(`The ground truth ${reference.key} could not be loaded`, error);
        state.status = "error";
        this.stage.setProgress("reference", null);
        this.stage.setStale("reference", false);
        this.stage.show("reference", null);
        this.stage.setMessage("reference", TEXT.referenceFailed, { label: "Try again", onclick: () => this.loadReference() });
        this.syncStore();
      });
  }

  /** A scene without a full camera is framed by the primary method's mesh, or the first that loads. */
  frameFrom(side, entry) {
    if (this.stage.framed) return;
    const preferred = SIDES.find((item) => this.selection[item] === this.view.primary) ?? "left";
    const fallback = ["missing", "error"].includes(this.sides[preferred].status);
    if (side === preferred || fallback) this.stage.setFrame(this.scene.camera, entry.sphere);
  }

  syncStore() {
    const keys = SIDES.flatMap((side) => [this.sides[side].key, this.stage.shown[side]?.key]);
    this.store.setInUse(keys);
    // The scene's own scan too, so one shared by two scenes (an ablation scan and its DTU scene) is kept between them.
    this.references.setInUse([this.reference.key, this.stage.shown.reference?.key, this.scene?.reference?.key]);
  }

  prefetch(methodId) {
    const mesh = this.scene?.meshes[methodId];
    if (!mesh || !this.runtime || !this.base) return;
    this.store.prefetch(mesh.key, mediaUrl(mesh.key), mesh.bytes);
  }

  announce() {
    const sides = this.visibleSides();
    if (!sides.every((side) => this.sides[side].status === "ready")) return;
    const names = sides.map((side) => this.method(this.selection[side]).label);
    if (this.stage.gt !== "none" && this.reference.status === "ready") names.push(this.scene.reference.label);
    const shown = names.length > 2 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join(" and ");
    this.status.textContent = this.stage.where
      ? `${TEXT.where} on ${this.scene.label}: ${shown}.`
      : `Showing ${shown} on ${this.scene.label}.`;
  }

  // Text and tables ----------------------------------------------------------------------------

  renderViewNote() {
    const { metric } = this.view;
    const rule = `${metric.label}, ${metric.lower ? "lower" : "higher"} is better.`;
    if (this.view.kind !== "ablation") {
      this.viewNote.replaceChildren(rule);
      return;
    }
    // The ablation's long description opens "About the variants" under the stage; the note stays one line.
    const title = this.view.title ? el("strong", {}, `${this.view.title.replace(/\.$/, "")}. `) : null;
    this.viewNote.replaceChildren(...[title, `${this.view.datasetLabel}: ${rule}`].filter(Boolean));
  }

  renderNotes() {
    const notes = this.scene.notes;
    this.notes.hidden = !notes.length;
    this.notes.replaceChildren(
      el("h3", { class: "hx-surf-subhead" }, "Observations"),
      el("ul", {}, ...notes.map((note) => el("li", {}, note))),
    );
  }

  /** The scene's tip after a "Tip:" label, as in the novel-view player; "Show me where" needs its camera and meshes. */
  renderTip() {
    const { tip } = this.scene;
    this.tip.hidden = !tip;
    if (!tip) {
      this.tip.replaceChildren();
      return;
    }
    const where =
      tip.camera && this.base
        ? el(
            "button",
            { type: "button", class: "hx-tip-action hx-tip-where", onclick: () => this.showTip() },
            icon("magnifying-glass-location"),
            ` ${TEXT.showWhere}`,
          )
        : null;
    this.tip.replaceChildren(el("strong", {}, "Tip:"), ` ${tip.text}`, ...(where ? [" ", el("span", { class: "hx-tip-actions" }, where)] : []));
  }

  /**
   * Every method's value on the current scene, with the metric's components when the manifest has them; the
   * pair on the stage is highlighted and the best value of each column is bold.
   */
  renderScores() {
    const { metric, methods, means } = this.view;
    const { scene } = this;
    const ablation = this.view.kind === "ablation";
    // The table shows this scene, or (when the manifest has them) the means over the whole dataset.
    const all = Boolean(means) && this.scoreScope === "all";
    const noun = this.view.scenes.every((item) => /^scan\d+$/i.test(item.id)) ? "scans" : "scenes";
    const keys = all
      ? []
      : [...new Set(methods.flatMap((method) => Object.keys(scene.components?.[method.id] ?? {})))].filter((key) =>
          methods.some((method) => number(scene.components[method.id]?.[key]) !== null),
        );
    const columns = [
      { name: null, value: (id) => (all ? means.values[id] : scene.metrics[id]) },
      ...keys.map((key) => ({ name: componentName(key), value: (id) => scene.components[id]?.[key] })),
    ];
    const bests = columns.map((column) => bestOf(metric, methods.map((method) => number(column.value(method.id)))));
    const names = this.isStacked() ? { left: "Top", right: "Bottom" } : { left: "Left", right: "Right" };
    const onStage = this.visibleSides();
    const rows = methods.map((method) => {
      const side = onStage.find((item) => this.selection[item] === method.id);
      return el(
        "tr",
        { class: side ? `is-picked is-${side}` : null, "data-method": method.tone },
        el(
          "th",
          { scope: "row", title: method.description || null },
          el(
            "span",
            { class: "hx-surf-row-method" },
            dot(),
            el("span", {}, method.label),
            side ? el("span", { class: "hx-surf-side-chip" }, names[side]) : null,
          ),
        ),
        ...columns.map((column, index) => {
          const value = number(column.value(method.id));
          const best = value !== null && value === bests[index] ? " is-best" : "";
          return el("td", { class: `hx-surf-num${column.name ? " is-part" : ""}${best}` }, formatNumber(metric, value));
        }),
      );
    });
    const header = el(
      "tr",
      {},
      el("th", { scope: "col" }, ablation ? "Variant" : "Method"),
      el("th", { scope: "col", class: "hx-surf-num" }, `${withUnit(metric.short, metric)} ${arrow(metric)}`),
      ...columns.slice(1).map((column) =>
        el(
          "th",
          { scope: "col", class: "hx-surf-num is-part" },
          // The components share the metric's unit and direction (mm and lower for DTU, % and higher for T&T).
          `${withUnit(column.name, metric)} ${arrow(metric)}`,
        ),
      ),
    );
    const notes = ["Bold marks the best value in each column; the highlighted rows are on the stage."];
    if (all) notes.unshift(`Means over all ${means.count} ${this.view.label} ${noun}, not only the examples above.`);
    if (keys.includes("accuracy_mm") && keys.includes("completeness_mm")) {
      notes.push("The Chamfer distance is the mean of accuracy (reconstruction to ground truth) and completeness (ground truth to reconstruction).");
    }
    if (keys.includes("precision") && keys.includes("recall")) {
      const threshold = scene.threshold === null ? "" : ` at the official distance threshold of ${Math.round(scene.threshold * 1000)} mm`;
      notes.push(`The F-score is the harmonic mean of precision and recall${threshold}.`);
    }
    const described = methods.filter((method) => method.description);
    const lead = ablation && this.view.description ? el("p", { class: "hx-surf-about-lead" }, this.view.description) : null;
    const about = described.length || lead
      ? el(
          "details",
          {
            class: "hx-surf-about",
            open: this.aboutOpen,
            ontoggle: (event) => {
              this.aboutOpen = event.target.open;
            },
          },
          el("summary", {}, `About the ${countWord(methods.length)} ${ablation ? "variants" : "methods"}`),
          lead,
          el(
            "dl",
            {},
            ...described.flatMap((method) => [
              el("dt", { "data-method": method.tone }, dot(), el("span", {}, method.label)),
              el("dd", {}, method.description),
            ]),
          ),
        )
      : null;
    const count = ablation ? `${countWord(methods.length)} variants` : `${countWord(methods.length)} methods`;
    const scope = means
      ? el(
          "div",
          { class: "hx-surf-seg hx-surf-scope", role: "group", "aria-label": "Table scope" },
          ...[
            ["scene", scene.label],
            ["all", `All ${means.count} ${noun}`],
          ].map(([id, label]) =>
            el(
              "button",
              {
                type: "button",
                "aria-pressed": String((id === "all") === all),
                onclick: () => {
                  this.scoreScope = id;
                  this.renderScores();
                },
              },
              label,
            ),
          ),
        )
      : null;
    fill(
      this.scores,
      el(
        "div",
        { class: "hx-surf-scores-head" },
        el("h3", { class: "hx-surf-subhead" }, all ? `${this.view.label}, all ${means.count} ${noun}: ${count}` : `${scene.label}: all ${count}`),
        scope,
      ),
      // Focusable, so a table that scrolls sideways on a narrow screen can be scrolled with the keyboard.
      el(
        "div",
        { class: "table-container", tabindex: "0", role: "region", "aria-label": all ? `${this.view.label} means` : `${scene.label} values` },
        el("table", { class: "table is-narrow hx-surf-table hx-surf-scores-table" }, el("thead", {}, header), el("tbody", {}, ...rows)),
      ),
      el("p", { class: "hx-surf-table-note" }, notes.join(" ")),
      about,
    );
  }

  /** One of the ablation's tables over many scans; showcase scans can be opened from their row. */
  renderAblationTable() {
    const { metric, methods, tables } = this.view;
    if (!tables.length) {
      this.ablation.replaceChildren();
      return;
    }
    this.ablationTable = clamp(this.ablationTable, 0, tables.length - 1);
    const table = tables[this.ablationTable];
    const columns = table.variants.map((id) => methods.find((method) => method.id === id)).filter(Boolean);
    const showcase = new Set(this.view.scenes.map((scene) => scene.id));
    const onStage = this.visibleSides();
    const pickedClass = (method) => {
      const side = onStage.find((item) => this.selection[item] === method.id);
      return side ? `is-picked is-${side}` : "";
    };
    const row = (sceneId, label, header) => {
      const values = columns.map((method) => number(table.values[method.id]?.[sceneId]));
      const best = bestOf(metric, values);
      return el(
        "tr",
        { class: [sceneId === this.scene.id ? "is-current" : "", sceneId === "mean" ? "hx-surf-mean" : ""].join(" ").trim() || null },
        el("th", { scope: "row" }, header ?? label),
        ...columns.map((method, index) =>
          el(
            "td",
            { class: `hx-surf-num ${pickedClass(method)}${values[index] !== null && values[index] === best ? " is-best" : ""}`, "data-method": method.tone },
            formatNumber(metric, values[index]),
          ),
        ),
      );
    };
    const sceneRows = table.scenes.map((sceneId) => {
      const label = this.view.sceneName(sceneId);
      const header = showcase.has(sceneId)
        ? el(
            "button",
            {
              type: "button",
              class: "hx-surf-row-open",
              "aria-pressed": String(sceneId === this.scene.id),
              title: `Show ${label} above`,
              onclick: () => {
                this.selectScene(sceneId);
                this.stage.element.scrollIntoView({ block: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" });
              },
            },
            label,
            " ",
            icon("cube"),
          )
        : null;
      return row(sceneId, label, header);
    });
    const hasMean = columns.some((method) => number(table.values[method.id]?.mean) !== null);
    const meanRow = hasMean ? row("mean", `Mean (${table.scenes.length} scans)`) : null;
    const toggle =
      tables.length > 1
        ? el(
            "div",
            { class: "hx-surf-seg hx-surf-table-toggle", role: "group", "aria-label": "Ablation table" },
            ...tables.map((item, index) =>
              el(
                "button",
                {
                  type: "button",
                  "aria-pressed": String(index === this.ablationTable),
                  onclick: () => {
                    this.ablationTable = index;
                    this.renderAblationTable();
                  },
                },
                `${item.scenes.length} scans, ${item.variants.length} variants`,
              ),
            ),
          )
        : null;
    const note = [
      table.note,
      `${metric.lower ? "Lower" : "Higher"} is better; bold marks the best variant on each scan, the highlighted columns are on the stage, and scans marked with a cube open in the viewer.`,
    ];
    fill(
      this.ablation,
      el("h3", { class: "hx-surf-subhead" }, `${metric.label} per ${this.view.datasetLabel} scan`),
      toggle,
      el(
        "div",
        { class: "table-container", tabindex: "0", role: "region", "aria-label": `Ablation, ${table.scenes.length} scans` },
        el(
          "table",
          { class: "table is-narrow is-hoverable hx-surf-table hx-surf-ablation-table" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", { scope: "col" }, "Scan"),
              ...columns.map((method) =>
                el(
                  "th",
                  { scope: "col", class: `hx-surf-num ${pickedClass(method)}`, "data-method": method.tone, title: method.description || null },
                  el("span", { class: "hx-surf-col-method" }, dot(), method.short ?? method.label),
                ),
              ),
            ),
          ),
          el("tbody", {}, ...sceneRows, meanRow),
        ),
      ),
      el("p", { class: "hx-surf-table-note" }, note.filter(Boolean).join(" ")),
    );
  }

  // Public state -------------------------------------------------------------------------------

  state() {
    const renderer = this.stage.renderer;
    return {
      view: this.view.id,
      scene: this.scene.id,
      selection: { ...this.selection },
      shading: this.shading,
      layout: this.layout,
      orient: this.stage.orient,
      started: Boolean(this.runtime),
      framed: this.stage.framed,
      active: this.stage.active,
      engaged: this.stage.engaged,
      sides: Object.fromEntries(SIDES.map((side) => [side, { key: this.sides[side].key, status: this.sides[side].status, shown: this.stage.shown[side]?.key ?? null }])),
      ready: SIDES.every((side) => ["ready", "missing"].includes(this.sides[side].status)),
      // Where the reference pane is (none, beside or swap), the narrow stages' toggle and the scan's state.
      groundTruth: { mode: this.stage.gt, toggle: this.groundTruth, toggleShown: !this.gtButton.hidden },
      reference: {
        key: this.reference.key,
        status: this.reference.status,
        shown: this.stage.shown.reference?.key ?? null,
        points: this.stage.shown.reference?.points ?? null,
        spacing: this.stage.shown.reference?.spacing ?? null,
      },
      decodedReferences: this.references.decodedKeys(),
      renders: this.stage.renders,
      camera: this.stage.cameraState(),
      projection: renderer ? { fov: Math.round(this.stage.baseFov * 1e4) / 1e4, aspect: Math.round(this.stage.referenceAspect * 1e4) / 1e4 } : null,
      tip: this.scene.tip ? { compare: this.scene.tip.compare, camera: Boolean(this.scene.tip.camera) } : null,
      where: this.stage.where,
      flying: Boolean(this.stage.flight),
      memory: renderer ? { ...renderer.info.memory } : null,
      decoded: this.store.decodedKeys(),
    };
  }
}

/* ---------- Mount ---------- */

function renderPlaceholder(root, text) {
  root.replaceChildren(el("div", { class: "hx-soon-card" }, el("p", {}, text)));
}

async function mountSurface(root) {
  const source = root.dataset.src;
  if (!source) throw new Error("#surface-root needs a data-src attribute naming the surface manifest");
  const raw = await loadJSON(source).catch((error) => {
    console.warn(`Surface comparisons are not available: ${error.message}`);
    return null;
  });
  if (!raw) {
    renderPlaceholder(root, "Surface reconstruction comparisons are coming soon.");
    return null;
  }
  return new SurfaceViewer(root, parseManifest(raw));
}

const surfaceRoot = document.getElementById("surface-root");
const ready = surfaceRoot
  ? mountSurface(surfaceRoot).catch((error) => {
      console.error("The surface viewer could not start", error);
      renderPlaceholder(surfaceRoot, TEXT.unavailable);
      return null;
    })
  : Promise.resolve(null);
let mounted = null;
ready.then((viewer) => {
  mounted = viewer;
});

window.HexelsSurface = {
  selectScene: (view, scene) => ready.then((viewer) => Boolean(viewer?.selectView(view) && (scene === undefined || viewer.selectScene(scene)))),
  selectMethods: (left, right) => ready.then((viewer) => viewer?.selectMethods(left, right) ?? false),
  showTip: () => ready.then((viewer) => viewer?.showTip() ?? false),
  showGroundTruth: (on) => ready.then((viewer) => viewer?.setGroundTruth(on) ?? false),
  state: () => mounted?.state() ?? null,
};
