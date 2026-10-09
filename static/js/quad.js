/**
 * Four-quadrant primitive comparison for the #quad-root mount.
 *
 * One held-out test view per scene is stacked four times and clipped into quadrants by a
 * draggable crosshair: a Gaussian method (3DGS or 2DGS, picked with a toggle) and Hexels on top,
 * and below them the same two models with every primitive drawn in a random color. The mount's
 * data-src names the manifest (static/data/primitive_vis.json); its images are media keys, fetched
 * once the figure approaches the viewport. Where the manifest's annotate_visible_counts allows it for
 * the Gaussian method, the lower corners count the primitives in this view next to the totals.
 * Without a media host or a manifest the mount shows a "coming soon" card instead.
 */

import { DATASET_LABELS, loadJSON, loadTips, mediaBase, mediaUrl, tipText, whenNear } from "./media.js";

const METHODS = {
  "3dgs": { name: "3DGS", unit: "Gaussians" },
  "2dgs": { name: "2DGS", unit: "2D Gaussians" },
  ours: { name: "Hexels", unit: "Hexels" },
};
const RIVALS = ["3dgs", "2dgs"];
const CORNERS = [
  { corner: "top-left", side: "rival", row: "render" },
  { corner: "top-right", side: "ours", row: "render" },
  { corner: "bottom-left", side: "rival", row: "vis" },
  { corner: "bottom-right", side: "ours", row: "vis" },
];
const CAPTION = "Each primitive is drawn in a random color with its learned shape and opacity.";
const ARROW_MOVES = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const KEY_STEP = 2;
const KEY_STEP_LARGE = 10;
const TAP_SLOP = 10;
const LABEL_GAP = 6;
const MOVE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path d="M12 2.5l3 3.5H9zM12 21.5l3-3.5H9zM2.5 12L6 9v6zM21.5 12L18 9v6z" fill="currentColor"/>
  <path d="M12 6v12M6 12h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;

const countFormat = new Intl.NumberFormat("en-US");
const imageRequests = new Map();

/** Create an element with a class name and, optionally, its text. */
function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Load and decode one image; calls for the same URL share the request, and a failed one can be retried. */
function loadImage(url) {
  if (!imageRequests.has(url)) {
    const image = new Image();
    image.decoding = "async";
    image.draggable = false;
    image.src = url;
    const decoded = image.decode().then(
      () => image,
      (error) => {
        imageRequests.delete(url);
        throw new Error(`Image failed to load: ${url} (${error.message})`);
      },
    );
    imageRequests.set(url, decoded);
  }
  return imageRequests.get(url);
}

/** Return the manifest after checking every field this component reads. */
function parseManifest(manifest, source) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.scenes)) {
    throw new Error(`${source}: expected {"version": 1, "scenes": [...]}`);
  }
  const annotate = manifest.annotate_visible_counts ?? {};
  manifest.scenes.forEach((scene, index) => {
    const where = `${source} scenes[${index}]`;
    if (!Object.hasOwn(DATASET_LABELS, scene.dataset)) throw new Error(`${where}: unknown dataset ${scene.dataset}`);
    for (const field of ["scene", "label", "view"]) {
      if (typeof scene[field] !== "string") throw new Error(`${where}: ${field} must be a string`);
    }
    if (!(Number.isInteger(scene.width) && scene.width > 0 && Number.isInteger(scene.height) && scene.height > 0)) {
      throw new Error(`${where}: invalid size ${scene.width}x${scene.height}`);
    }
    for (const method of Object.keys(METHODS)) {
      for (const row of ["render", "vis"]) {
        if (typeof scene.images?.[`${method}_${row}`] !== "string") throw new Error(`${where}: missing image ${method}_${row}`);
      }
      if (!Number.isInteger(scene.counts?.[method])) throw new Error(`${where}: missing count for ${method}`);
      const needsVisible = method === "ours" ? RIVALS.some((rival) => annotate[rival]) : annotate[method];
      if (needsVisible && !Number.isInteger(scene.visible_counts?.[method])) {
        throw new Error(`${where}: missing visible count for ${method}`);
      }
    }
  });
  return { scenes: manifest.scenes, annotate, inView: inViewText(manifest.visible_count_definition) };
}

/** The short definition of "in view": the opening clause of the manifest's definition. */
function inViewText(definition) {
  if (typeof definition !== "string" || !definition) return null;
  return `“In view”: ${definition.split(":")[0].trim()}.`;
}

/** Replace the mount's content with the page's "coming soon" card. */
function renderPlaceholder(root) {
  const card = element("div", "hx-soon-card");
  const text = element("p", "");
  text.append(
    element("strong", "", "Primitive visualizations coming soon."),
    " Hexels, 3DGS and 2DGS renders of the same view, next to their primitives drawn in random colors.",
  );
  card.append(text);
  root.replaceChildren(card);
}

/** Clamp a percentage to [0, 100]. */
function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

/** True when `event` releases the touch or pen press `tap` within TAP_SLOP pixels of where it started. */
function isTap(tap, event) {
  return tap?.pointerId === event.pointerId && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) <= TAP_SLOP;
}

/** Pointer offset from the centre of `node`, so a grabbed handle does not jump under the pointer. */
function offsetFromCentre(node, event) {
  const box = node.getBoundingClientRect();
  return { x: event.clientX - (box.left + box.width / 2), y: event.clientY - (box.top + box.height / 2) };
}

/** A group for toggle buttons with a small visible caption. */
function labelledGroup(label) {
  const group = element("div", "quad-scene-group");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);
  const caption = element("span", "quad-scene-dataset", label);
  caption.setAttribute("aria-hidden", "true");
  group.append(caption);
  return group;
}

/** A toggle button in the style of the scene buttons. */
function toggleButton(text, onClick) {
  const button = element("button", "quad-scene", text);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

/** The interactive figure: method and scene buttons, the clipped image stack with its crosshair, and the caption. */
class QuadComparison {
  constructor(root, manifest, tips) {
    this.scenes = manifest.scenes;
    this.annotate = manifest.annotate;
    this.tips = tips;
    this.selected = 0;
    this.rival = RIVALS[0];
    this.started = false;
    this.request = 0;
    this.position = { x: 50, y: 50 };
    this.build(root, manifest.inView);
    this.attachPointer();
    this.attachKeyboard();
    this.watchLabels();
    this.setPosition(50, 50);
    this.setAspect(this.scenes[0]);
    // The caption and tip are filled before the images load, so the section has its final height from the start.
    this.describe(this.scenes[0]);
    this.updateButtons();
    whenNear(root, () => {
      if (!this.started) this.select(this.selected);
    });
  }

  /** Create the DOM; the images are added when a scene has loaded. */
  build(root, inView) {
    this.stage = element("div", "quad-stage");
    this.layers = CORNERS.map((quadrant) => {
      const layer = element("div", `quad-layer quad-${quadrant.corner}`);
      const label = element("span", "quad-label");
      layer.append(label);
      return { quadrant, layer, label, image: null };
    });
    this.handle = element("div", "quad-handle");
    this.handle.tabIndex = 0;
    this.handle.innerHTML = MOVE_ICON;
    this.handle.setAttribute("role", "slider");
    this.handle.setAttribute("aria-label", "Crosshair dividing the four images; use the arrow keys to move it");
    this.handle.setAttribute("aria-valuemin", "0");
    this.handle.setAttribute("aria-valuemax", "100");
    this.status = element("p", "quad-status");
    this.status.setAttribute("role", "status");
    this.stage.append(
      ...this.layers.map(({ layer }) => layer),
      element("div", "quad-line quad-line-vertical"),
      element("div", "quad-line quad-line-horizontal"),
      this.handle,
      this.status,
    );
    this.meta = element("span", "quad-caption-meta");
    this.inView = element("span", "quad-caption-meta quad-in-view", inView ?? "");
    const caption = element("figcaption", "hx-caption quad-caption");
    caption.append(CAPTION, this.meta, this.inView);
    this.tip = element("p", "hx-tip quad-tip");
    this.tip.hidden = true;
    const figure = element("figure", "quad-figure");
    figure.append(this.stage, caption, this.tip);
    root.replaceChildren(this.buildControls(), figure);
  }

  /** The Gaussian method toggle, then one toggle button per scene grouped by dataset. */
  buildControls() {
    const rivals = labelledGroup("Compare with");
    rivals.classList.add("quad-rivals");
    this.rivalButtons = RIVALS.map((id) => toggleButton(METHODS[id].name, () => this.setRival(id)));
    rivals.append(...this.rivalButtons);
    const groups = new Map();
    this.sceneButtons = this.scenes.map((scene, index) => {
      if (!groups.has(scene.dataset)) groups.set(scene.dataset, labelledGroup(DATASET_LABELS[scene.dataset]));
      const button = toggleButton(scene.label, () => this.select(index));
      groups.get(scene.dataset).append(button);
      return button;
    });
    const scenes = element("div", "quad-scenes");
    scenes.setAttribute("role", "group");
    scenes.setAttribute("aria-label", "Scene");
    scenes.append(...groups.values());
    const controls = element("div", "quad-controls");
    controls.append(rivals, scenes);
    return controls;
  }

  updateButtons() {
    this.rivalButtons.forEach((button, index) => button.setAttribute("aria-pressed", String(RIVALS[index] === this.rival)));
    this.sceneButtons.forEach((button, index) => button.setAttribute("aria-pressed", String(index === this.selected)));
  }

  /** Show the Gaussian method `rival` on the left half. */
  setRival(rival) {
    if (rival === this.rival) return;
    this.rival = rival;
    this.updateButtons();
    if (this.started) this.show(this.selected);
    else this.describe(this.scenes[this.selected]);
  }

  /** Mark scene `index` as selected and show it; showing a loaded scene again is instant, a failed one retries. */
  select(index) {
    this.started = true;
    this.selected = index;
    this.updateButtons();
    this.show(index);
  }

  /** The method shown by a quadrant. */
  methodOf(quadrant) {
    return quadrant.side === "ours" ? "ours" : this.rival;
  }

  /** Swap in the four images of scene `index` together, once all of them are decoded. */
  async show(index) {
    const scene = this.scenes[index];
    const rival = this.rival;
    const request = ++this.request;
    this.stage.classList.add("is-loading");
    this.status.textContent = `Loading ${scene.label}`;
    const urls = this.layers.map(({ quadrant }) => mediaUrl(scene.images[`${this.methodOf(quadrant)}_${quadrant.row}`]));
    const images = await Promise.all(urls.map((url) => loadImage(url))).catch((error) => {
      console.warn(error);
      return null;
    });
    if (request !== this.request) return;
    this.stage.classList.remove("is-loading");
    if (images) {
      this.applyScene(scene, images);
      this.status.textContent = "";
    } else {
      this.clearImages();
      this.showTip(scene);
      this.setAspect(scene);
      this.status.textContent = `The ${METHODS[rival].name} images for ${scene.label} could not be loaded.`;
    }
  }

  /**
   * The scene's tip for the Gaussian method on the left. A quad tip is a string, shown with either method, or an
   * object keyed by the method it describes ("3dgs", "2dgs"), so a tip about 3DGS never shows next to 2DGS.
   */
  showTip(scene) {
    const entry = this.tips?.quad?.[`${scene.dataset}/${scene.scene}`];
    const text = tipText(entry !== null && typeof entry === "object" ? entry[this.rival] : entry);
    this.tip.hidden = !text;
    this.tip.replaceChildren(...(text ? [element("strong", "", "Tip:"), ` ${text}`] : []));
  }

  /** The caption line that names the scene and the two methods, and the scene's tip. */
  describe(scene) {
    const dataset = DATASET_LABELS[scene.dataset];
    this.meta.textContent =
      `Hexels V3 (densified) and ${METHODS[this.rival].name}, held-out test view ${scene.view} of ${scene.label} (${dataset}).`;
    this.inView.hidden = !this.annotate[this.rival] || !this.inView.textContent;
    this.showTip(scene);
  }

  /** Put decoded images, labels and the caption of `scene` in place. */
  applyScene(scene, images) {
    this.setAspect(scene);
    this.layers.forEach((entry, index) => {
      const image = images[index];
      image.className = "quad-image";
      Object.assign(image, { width: scene.width, height: scene.height });
      image.alt = this.altText(entry.quadrant, scene);
      if (entry.image !== image) {
        entry.image?.remove();
        entry.layer.prepend(image);
        entry.image = image;
      }
      entry.label.replaceChildren(...this.labelNodes(entry.quadrant, scene));
    });
    this.describe(scene);
    this.stage.classList.add("is-ready");
  }

  /**
   * Corner label of a quadrant: the method name on top; below, the primitives in this view with the
   * total in smaller text where the manifest allows it, else the total alone.
   */
  labelNodes(quadrant, scene) {
    const id = this.methodOf(quadrant);
    const method = METHODS[id];
    const nodes = [element("span", `quad-dot quad-dot-${id}`)];
    if (quadrant.row === "render") return [...nodes, element("span", "quad-label-text", method.name)];
    const total = countFormat.format(scene.counts[id]);
    if (!this.annotate[this.rival]) return [...nodes, element("span", "quad-label-text", `${total} ${method.unit}`)];
    const text = element("span", "quad-label-text", `${countFormat.format(scene.visible_counts[id])} ${method.unit} in view`);
    text.append(element("small", "quad-label-total", `of ${total} in total`));
    return [...nodes, text];
  }

  /** Alternative text of a quadrant's image. */
  altText(quadrant, scene) {
    const method = METHODS[this.methodOf(quadrant)];
    if (quadrant.row === "render") return `${method.name} render of ${scene.label}`;
    const count = countFormat.format(scene.counts[this.methodOf(quadrant)]);
    return `${scene.label} with each of the ${count} ${method.unit} drawn in a random color`;
  }

  /** Remove the images, leaving the empty stage. */
  clearImages() {
    for (const entry of this.layers) {
      entry.image?.remove();
      entry.image = null;
    }
    this.meta.textContent = "";
    this.inView.hidden = true;
    this.stage.classList.remove("is-ready");
  }

  /** Size the stage to the aspect ratio of `scene`. */
  setAspect(scene) {
    this.stage.style.setProperty("--quad-aspect", `${scene.width} / ${scene.height}`);
  }

  /** Move the crosshair to (x, y), in percent of the stage, and describe it for assistive technology. */
  setPosition(x, y) {
    this.position = { x: clampPercent(x), y: clampPercent(y) };
    const across = Math.round(this.position.x);
    const down = Math.round(this.position.y);
    this.stage.style.setProperty("--quad-x", `${this.position.x.toFixed(2)}%`);
    this.stage.style.setProperty("--quad-y", `${this.position.y.toFixed(2)}%`);
    this.handle.setAttribute("aria-valuenow", String(across));
    this.handle.setAttribute("aria-valuetext", `${across}% across, ${down}% down`);
    this.updateLabels();
  }

  /** Measure the stage and its corner labels again whenever one of them changes size. */
  watchLabels() {
    const observer = new ResizeObserver(() => {
      this.stageSize = { width: this.stage.clientWidth, height: this.stage.clientHeight };
      this.labelBoxes = this.layers.map(({ label }) => ({
        left: label.offsetLeft,
        top: label.offsetTop,
        right: label.offsetLeft + label.offsetWidth,
        bottom: label.offsetTop + label.offsetHeight,
      }));
      this.updateLabels();
    });
    observer.observe(this.stage);
    for (const { label } of this.layers) observer.observe(label);
  }

  /** Fade out each corner label that its quadrant is too small to show whole. */
  updateLabels() {
    if (!this.labelBoxes) return;
    const x = (this.position.x / 100) * this.stageSize.width;
    const y = (this.position.y / 100) * this.stageSize.height;
    this.layers.forEach(({ quadrant, label }, index) => {
      const box = this.labelBoxes[index];
      const [vertical, horizontal] = quadrant.corner.split("-");
      const fitsAcross = horizontal === "left" ? box.right + LABEL_GAP <= x : box.left - LABEL_GAP >= x;
      const fitsDown = vertical === "top" ? box.bottom + LABEL_GAP <= y : box.top - LABEL_GAP >= y;
      label.classList.toggle("is-covered", !(fitsAcross && fitsDown));
    });
  }

  /**
   * Mouse: press anywhere on the stage and drag. Touch and pen: drag the handle, or tap the stage
   * to move the crosshair there; a swipe elsewhere on the images still scrolls the page, which
   * cancels the tap. Taps are read from pointer events because browsers may drop the click.
   */
  attachPointer() {
    let activePointer = null;
    let grabOffset = { x: 0, y: 0 };
    let tap = null;
    const moveTo = (clientX, clientY) => {
      const box = this.stage.getBoundingClientRect();
      this.setPosition(((clientX - box.left) / box.width) * 100, ((clientY - box.top) / box.height) * 100);
    };
    const finishDrag = (event) => {
      if (event.pointerId !== activePointer) return;
      activePointer = null;
      this.stage.classList.remove("is-dragging");
    };
    this.stage.addEventListener("pointerdown", (event) => {
      if (activePointer !== null || event.button !== 0) return;
      const onHandle = this.handle.contains(event.target);
      if (!onHandle && event.pointerType !== "mouse") {
        tap = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        return;
      }
      event.preventDefault();
      activePointer = event.pointerId;
      grabOffset = onHandle ? offsetFromCentre(this.handle, event) : { x: 0, y: 0 };
      this.stage.setPointerCapture(event.pointerId);
      this.stage.classList.add("is-dragging");
      moveTo(event.clientX - grabOffset.x, event.clientY - grabOffset.y);
    });
    this.stage.addEventListener("pointermove", (event) => {
      if (event.pointerId === activePointer) moveTo(event.clientX - grabOffset.x, event.clientY - grabOffset.y);
    });
    this.stage.addEventListener("pointerup", (event) => {
      if (isTap(tap, event)) moveTo(event.clientX, event.clientY);
      tap = null;
      finishDrag(event);
    });
    this.stage.addEventListener("pointercancel", (event) => {
      tap = null;
      finishDrag(event);
    });
    this.stage.addEventListener("lostpointercapture", finishDrag);
  }

  /** Arrow keys move the crosshair by KEY_STEP percent, or KEY_STEP_LARGE with Shift. */
  attachKeyboard() {
    this.handle.addEventListener("keydown", (event) => {
      const move = ARROW_MOVES[event.key];
      if (!move) return;
      event.preventDefault();
      const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
      this.setPosition(this.position.x + move[0] * step, this.position.y + move[1] * step);
    });
  }
}

/** Fill the mount with the comparison, or with the placeholder when there is nothing to show yet. */
async function mountQuad(root) {
  root.classList.add("quad");
  if (!mediaBase()) {
    renderPlaceholder(root);
    return;
  }
  const source = root.dataset.src;
  if (!source) throw new Error("#quad-root needs a data-src attribute naming the primitive visualization manifest");
  const [raw, tips] = await Promise.all([
    loadJSON(source).catch((error) => {
      console.warn(`Primitive visualizations are not available: ${error.message}`);
      return null;
    }),
    loadTips(),
  ]);
  const manifest = raw ? parseManifest(raw, source) : null;
  if (!manifest?.scenes.length) {
    renderPlaceholder(root);
    return;
  }
  new QuadComparison(root, manifest, tips);
}

const quadRoot = document.getElementById("quad-root");
if (quadRoot) mountQuad(quadRoot);
