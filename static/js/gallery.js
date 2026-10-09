/**
 * Scene gallery: every scene of the manifest as a tile, grouped by dataset. A tile shows its
 * thumbnail; its looping preview of our method plays through the playback manager (playback.js),
 * one tile at a time: with a mouse while the pointer rests on the tile or the tile has keyboard
 * focus, otherwise (touch screens, reduced motion) by its play button, and it is released again
 * when it stops. Selecting a tile opens that scene in the comparison player.
 *
 * Mount: <div id="gallery-root" data-media="static/data/nvs_media.json">
 */
import { loadJSON, mediaBase, mediaUrl } from "./media.js";
import { LoopingVideo, hoverPlays, playback } from "./playback.js";

const NO_MEDIA_TEXT = "Previews will appear here once the media is hosted.";

/** Create an element with a class name and, optionally, its text. */
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Ask the comparison player to show a scene. */
function openScene(dataset, scene) {
  document.dispatchEvent(new CustomEvent("hexels:select-scene", { detail: { dataset: dataset.id, scene: scene.id } }));
}

/** One tile: thumbnail and preview, and a button that opens the scene in the comparison player. */
function buildTile(dataset, scene) {
  const thumb = element("img");
  Object.assign(thumb, { loading: "lazy", decoding: "async", width: scene.width, height: scene.height, alt: "", src: scene.thumb });
  const media = element("div", "hx-gal-media");
  media.append(thumb);
  media.addEventListener("click", () => openScene(dataset, scene));
  const cue = element("span", "hx-gal-cue");
  const glyph = element("i", "fa-solid fa-arrows-left-right");
  glyph.setAttribute("aria-hidden", "true");
  cue.append(glyph, element("span", "hx-gal-cue-text", "Compare"));
  const name = element("span", "hx-gal-name", scene.label);
  const open = element("button", "hx-gal-open");
  open.type = "button";
  open.setAttribute("aria-label", `Compare methods on ${scene.label} (${dataset.label})`);
  open.append(name, cue);
  open.addEventListener("click", () => openScene(dataset, scene));
  const tile = element("div", "hx-gal-tile");
  tile.append(media, open);
  const url = mediaUrl(scene.preview);
  if (url) mountPreview(tile, media, thumb, url, scene.label);
  return tile;
}

/** Add the preview video and its playback group to a tile. */
function mountPreview(tile, media, thumb, url, label) {
  const video = element("video");
  Object.assign(video, { muted: true, loop: true, playsInline: true, preload: "none" });
  video.setAttribute("aria-hidden", "true");
  media.append(video);
  const group = new LoopingVideo({
    zone: tile,
    media,
    video,
    still: thumb,
    src: url,
    label: `preview of ${label}`,
    release: true,
    hint: null,
    onFail: () => tile.classList.add("has-no-preview"),
  });
  if (hoverPlays()) {
    // With a mouse the preview follows hover; keyboard focus on the tile plays it the same way.
    group.button.tabIndex = -1;
    tile.addEventListener("focusin", () => playback.play(group));
    tile.addEventListener("focusout", () => playback.stop(group));
  }
}

function buildGroup(dataset) {
  const heading = element("h3", "hx-gal-heading", dataset.label);
  heading.append(" ", element("span", "hx-gal-count", `${dataset.scenes.length} scenes`));
  const grid = element("div", "hx-gal-grid");
  grid.append(...dataset.scenes.map((scene) => buildTile(dataset, scene)));
  const section = element("section", "hx-gal-group");
  section.setAttribute("aria-label", `${dataset.label} scenes`);
  section.append(heading, grid);
  return section;
}

function buildGallery(root, manifest) {
  const container = element("div", "hx-gallery");
  if (!mediaBase()) container.append(element("p", "hx-gal-note", NO_MEDIA_TEXT));
  container.append(...manifest.datasets.map(buildGroup));
  root.replaceChildren(container);
}

const root = document.getElementById("gallery-root");
if (root) {
  loadJSON(root.dataset.media)
    .then((manifest) => buildGallery(root, manifest))
    .catch((error) => {
      console.error("The scene gallery could not be loaded", error);
      root.replaceChildren(element("p", "hx-gal-note", "The scene gallery could not be loaded."));
    });
}
