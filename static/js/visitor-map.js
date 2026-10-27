/** Keep the footer and expanded visitor map on the same complete, unlabeled cartographic artwork. */
const mapUrl = new URL("../images/visitor-world-map.svg", import.meta.url).href;
const root = document.querySelector(".hx-visitor-map");

if (root) {
  const dialog = document.createElement("dialog");
  dialog.className = "hx-map-dialog";
  dialog.setAttribute("aria-label", "World visitor map");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "hx-map-close";
  close.textContent = "Close map";
  close.autofocus = true;
  close.addEventListener("click", () => dialog.close());
  const content = document.createElement("div");
  dialog.append(close, content);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.append(dialog);

  /** Put the complete map into the marker canvas's transformed coordinate system, never a CSS overlay. */
  function installMap() {
    const link = root.querySelector("#mapmyvisitors-widget");
    if (link && link.href !== mapUrl) {
      link.href = mapUrl;
      link.removeAttribute("target");
      link.setAttribute("aria-label", "Open world visitor map");
    }
    const svg = root.querySelector(".mapmyvisitors-map svg");
    const coordinates = svg?.querySelector(":scope > g[transform]");
    if (!coordinates || coordinates.querySelector(".hx-world-map-art")) return;
    const artwork = document.createElementNS("http://www.w3.org/2000/svg", "image");
    artwork.setAttribute("class", "hx-world-map-art");
    artwork.setAttribute("href", mapUrl);
    artwork.setAttribute("width", "900");
    artwork.setAttribute("height", "440.70631074413296");
    artwork.setAttribute("pointer-events", "none");
    coordinates.prepend(artwork);
  }

  /** Scale one snapshot of the actual map canvas, including its live visitor markers, into the dialog. */
  function showMap() {
    const source = root.querySelector(".mapmyvisitors-map svg");
    if (source) {
      const snapshot = source.cloneNode(true);
      snapshot.setAttribute("viewBox", `0 0 ${source.getAttribute("width")} ${source.getAttribute("height")}`);
      snapshot.removeAttribute("width");
      snapshot.removeAttribute("height");
      snapshot.setAttribute("role", "img");
      snapshot.setAttribute("aria-label", "World visitor map");
      content.replaceChildren(snapshot);
    } else {
      const image = document.createElement("img");
      image.src = mapUrl;
      image.alt = "World visitor map";
      content.replaceChildren(image);
    }
    dialog.showModal();
  }

  // The provider creates its canvas asynchronously and may update the link as visitor data arrives.
  new MutationObserver(installMap).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
  installMap();
  root.addEventListener("click", (event) => {
    if (!event.target.closest("#mapmyvisitors-widget") || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    showMap();
  }, { capture: true });
}
