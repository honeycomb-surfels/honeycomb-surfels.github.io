/**
 * Page shell behaviour for the two Honeycomb-Surfels pages, the project page (index.html) and the
 * animated theory (theory.html): the author line and link buttons from window.HEXELS_CONFIG, the demo
 * window, the theory animations, math typesetting, the depth and normal views and the BibTeX copy
 * button. Each part runs only on the page that has its elements. Every video plays through the playback
 * manager in playback.js. In-page anchors scroll smoothly through CSS (scroll-behavior in index.css),
 * which also respects prefers-reduced-motion.
 */
import { DATASET_LABELS, loadJSON, mediaBase, mediaUrl } from "./media.js";
import { LoopingVideo, playback } from "./playback.js";
import { setupCompanionBee } from "./companion-bee.js";

const MEDIA_NOTICE = "Videos will appear here once the media is hosted.";
const FAILED_NOTICE = "This video could not be loaded.";
const COPY_FEEDBACK_MS = 2000;
const BUTTON_CLASS = "button is-normal is-rounded is-dark";
const LINK_BUTTONS = [
  { key: "paper", label: "Paper", icon: "fas fa-file-pdf" },
  { key: "arxiv", label: "arXiv", icon: "ai ai-arxiv" },
  { key: "code", label: "Code", icon: "fab fa-github" },
  { key: "video", label: "Video", icon: "fas fa-film" },
];
// The site's own pages and the BibTeX section, after the paper resources.
const SITE_BUTTONS = [
  { label: "Theory", icon: "fas fa-shapes", href: "theory.html" },
  { label: "Viewer", icon: "fas fa-cube", href: "viewer.html" },
  { label: "BibTeX", icon: "fas fa-quote-right", href: "#bibtex" },
];
// The co-first authors trade places every AUTHOR_SWAP_EVERY_MS, in a crossfade of AUTHOR_SWAP_MS.
const AUTHOR_SWAP_EVERY_MS = 5000;
const AUTHOR_SWAP_MS = 1500;
const AUTHOR_SWAP_EASING = "cubic-bezier(0.45, 0, 0.55, 1)";
// With every BEE_LAP_EVERY-th author swap, starting with the first, the bee of the title logo takes off as the names
// trade places and flies one lap around the honeycomb, along the lap path drawn into logo.svg, landing where it took
// off. It flies head first with its back to the outside, grows by BEE_LIFT at mid-lap as if nearer, and each cell bobs
// and lights up in CELL_GLINT, a pale honey, as the bee passes it.
const BEE_LAP_EVERY = 1;
const BEE_LAP_MS = 2600;
const BEE_LAP_STEPS = 120;
const BEE_LIFT = 0.08;
const BEE_FLAP_MS = 45;
// An even number of wing strokes, so the wings come to rest as drawn.
const BEE_FLAPS = 2 * Math.ceil(BEE_LAP_MS / (2 * BEE_FLAP_MS));
const CELL_BOB_MS = 600;
const CELL_BOB = [
  { scale: 1, glint: 0 },
  { scale: 1.09, glint: 0.55, offset: 0.25 },
  { scale: 0.97, glint: 0.15, offset: 0.55 },
  { scale: 1.01, glint: 0, offset: 0.8 },
  { scale: 1, glint: 0 },
];
const CELL_GLINT = "#fff4cc";
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
// The animations are H.264 High profile, level 4.0.
const ANIM_TYPE = 'video/mp4; codecs="avc1.640028"';
const MATH_DELIMITERS = [
  { left: "\\[", right: "\\]", display: true },
  { left: "\\(", right: "\\)", display: false },
];
// A deep link such as theory.html's ./#results is held in place this long while the page above it renders.
const HASH_HOLD_MS = 10000;
const HASH_RELEASE_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"];
const GEOMETRY_PANELS = [
  { key: "rgb", label: "Rendered image", alt: "Hexels render" },
  { key: "depth", label: "Depth", alt: "Expected depth, from red (near) to blue (far)" },
  { key: "normal", label: "Normals", alt: "Rendered normals in camera space" },
];

/* ---------- DOM helpers ---------- */

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

function icon(classes) {
  return element("span", { className: "icon" }, [
    element("i", { className: classes, attrs: { "aria-hidden": "true" } }),
  ]);
}

function nameOrLink(name, url) {
  return url ? element("a", { text: name, attrs: { href: url } }) : document.createTextNode(name);
}

/* ---------- Hero: authors and link buttons ---------- */

/** Nodes separated by spaces, so the line can wrap between them. */
function spaced(nodes) {
  return nodes.flatMap((node, index) => (index ? [" ", node] : [node]));
}

/**
 * The author line. When exactly two authors lead it with equal contribution, they share an unbreakable
 * span, so trading places never rewraps the line, and they trade places on screen every few seconds.
 */
function renderAuthors(authors, affiliation) {
  const line = document.getElementById("authors");
  const blocks = authors.map((author, index) => {
    const block = element("span", { className: "author-block", attrs: { "data-author": author.id } }, [nameOrLink(author.name, author.url)]);
    if (author.equal) block.append(element("sup", { text: "*" }));
    if (index < authors.length - 1) block.append(",");
    return block;
  });
  const leading = authors.findIndex((author) => !author.equal);
  if (leading === 2) {
    const pair = element("span", { className: "hx-author-pair" }, spaced(blocks.slice(0, 2)));
    line.replaceChildren(...spaced([pair, ...blocks.slice(2)]));
    rotateCoFirstAuthors(line, pair);
  } else {
    line.replaceChildren(...spaced(blocks));
  }
  const parts = affiliation.flatMap((part, index) => [...(index ? [", "] : []), nameOrLink(part.name, part.url)]);
  document.getElementById("affiliation").replaceChildren(element("span", { className: "author-block" }, parts));
  if (authors.some((author) => author.equal)) {
    document.getElementById("author-note").replaceChildren(element("sup", { text: "*" }), "Equal contribution");
  }
}

/**
 * Swap the two authors of `pair` on screen only (the is-swapped class of index.css reverses the row), so the
 * reading and Tab order keep the order of the BibTeX entry. Each name fades out where it was and fades in at its
 * new place (FLIP), so the two never overlap.
 */
function swapAuthors(pair) {
  const blocks = [...pair.children];
  const before = blocks.map((block) => block.getBoundingClientRect().left);
  pair.classList.toggle("is-swapped");
  blocks.forEach((block, index) => {
    const shift = before[index] - block.getBoundingClientRect().left;
    block.animate(
      [
        { transform: `translateX(${shift}px)`, opacity: 1 },
        { transform: `translateX(${shift}px)`, opacity: 0, offset: 0.4 },
        { transform: "translateX(0)", opacity: 0, offset: 0.6 },
        { transform: "translateX(0)", opacity: 1 },
      ],
      { duration: AUTHOR_SWAP_MS, easing: AUTHOR_SWAP_EASING },
    );
  });
}

/* ---------- Title logo ---------- */

/**
 * Put the title logo inline, so that its bee and cells can move: the image is replaced by the same SVG. Resolves to
 * the SVG, or to null when the file cannot be read, in which case the image stays.
 */
async function inlineLogo(img) {
  try {
    const response = await fetch(img.currentSrc || img.src);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const parsed = new DOMParser().parseFromString(await response.text(), "image/svg+xml").documentElement;
    if (!parsed.querySelector(".hxl-bee") || !parsed.querySelector(".hxl-lap")) throw new Error("no bee or lap path");
    const svg = document.importNode(parsed, true);
    svg.querySelector("title")?.remove();
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    img.replaceWith(svg);
    return svg;
  } catch (error) {
    console.info(`The title logo stays still: ${error.message}`);
    return null;
  }
}

/**
 * The bee's lap as BEE_LAP_STEPS + 1 steps { t, x, y, turn }. The distance flown follows t - sin(2 pi t) / (2 pi),
 * so the bee leaves and lands gently; the drawn bee faces -x, so its turn is the flight direction less 180 degrees,
 * unwrapped, and blends into the perched tilt over the first and last tenth of the lap.
 */
function lapSteps(lap, tilt) {
  const length = lap.getTotalLength();
  const point = (s) => lap.getPointAtLength(Math.min(length, Math.max(0, s)));
  const steps = [];
  let previous = tilt;
  for (let i = 0; i <= BEE_LAP_STEPS; i += 1) {
    const t = i / BEE_LAP_STEPS;
    const s = (t - Math.sin(2 * Math.PI * t) / (2 * Math.PI)) * length;
    const { x, y } = point(s);
    const [a, b] = [point(s - 0.5), point(s + 0.5)];
    let turn = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI - 180;
    turn += 360 * Math.round((previous - turn) / 360);
    previous = turn;
    steps.push({ t, x, y, turn });
  }
  const landing = tilt + 360 * Math.round((previous - tilt) / 360);
  for (const step of steps) {
    const w = Math.min(1, step.t / 0.1, (1 - step.t) / 0.1);
    const rest = step.t < 0.5 ? tilt : landing;
    step.turn = rest + (step.turn - rest) * w * w * (3 - 2 * w);
  }
  return steps;
}

/** A transform that scales by (sx, sy) about the point (x, y) of the element's own coordinates. */
function scaleAbout(x, y, sx, sy = sx) {
  return `translate(${x}px, ${y}px) scale(${sx}, ${sy}) translate(${-x}px, ${-y}px)`;
}

/**
 * The lap of the inline title logo, as a function that starts it unless the bee is already flying. Each cell gets a
 * pale copy on top of it, its glint, and bobs when the bee passes the cell's direction from the middle of the comb.
 */
function beeLap(svg) {
  const bee = svg.querySelector(".hxl-bee");
  const wings = bee.querySelector(".hxl-wings");
  const [hingeX, hingeY] = wings.dataset.hinge.split(" ").map(Number);
  const tilt = Number(bee.getAttribute("transform").match(/rotate\((-?[\d.]+)/)[1]);
  const steps = lapSteps(svg.querySelector(".hxl-lap"), tilt);
  const beeFrames = steps.map(({ t, x, y, turn }) => ({
    offset: t,
    transform: `translate(${x}px, ${y}px) rotate(${turn}deg) scale(${1 + BEE_LIFT * Math.sin(Math.PI * t)})`,
  }));
  const cells = [...svg.querySelectorAll(".hxl-cell")].map((cell) => {
    const box = cell.getBBox();
    const glint = cell.cloneNode(false);
    glint.removeAttribute("class");
    glint.removeAttribute("data-cell");
    glint.setAttribute("fill", CELL_GLINT);
    glint.setAttribute("opacity", "0");
    cell.after(glint);
    return { cell, glint, x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  const middleX = cells.reduce((sum, c) => sum + c.x, 0) / cells.length;
  const middleY = cells.reduce((sum, c) => sum + c.y, 0) / cells.length;
  const bearing = (x, y) => Math.atan2(y - middleY, x - middleX);
  const flight = steps.filter(({ t }) => t > 0.08 && t < 0.92);
  for (const c of cells) {
    const target = bearing(c.x, c.y);
    const offBearing = ({ x, y }) => Math.abs(Math.atan2(Math.sin(bearing(x, y) - target), Math.cos(bearing(x, y) - target)));
    c.passAt = flight.reduce((best, step) => (offBearing(step) < offBearing(best) ? step : best)).t * BEE_LAP_MS;
  }
  let flying = false;
  return () => {
    if (flying || reducedMotion.matches) return;
    flying = true;
    const animations = [
      bee.animate(beeFrames, { duration: BEE_LAP_MS }),
      wings.animate([{ transform: "none" }, { transform: scaleAbout(hingeX, hingeY, 1, 0.3) }],
        { duration: BEE_FLAP_MS, iterations: BEE_FLAPS, direction: "alternate", easing: "ease-in-out" }),
    ];
    for (const c of cells) {
      const timing = { duration: CELL_BOB_MS, delay: Math.max(0, c.passAt - 0.25 * CELL_BOB_MS), easing: "ease-in-out" };
      const frames = CELL_BOB.map(({ scale, offset }) => ({ offset, transform: scaleAbout(c.x, c.y, scale) }));
      animations.push(c.cell.animate(frames, timing));
      animations.push(c.glint.animate(CELL_BOB.map(({ glint }, i) => ({ ...frames[i], opacity: glint })), timing));
    }
    Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      flying = false;
    });
  };
}

/**
 * Let the co-first authors trade places every AUTHOR_SWAP_EVERY_MS, and the title logo's bee fly its lap with the first
 * swap and every BEE_LAP_EVERY-th one after it, while the author line is on screen, the pointer is off it, nothing in
 * it has keyboard focus, the tab is visible and motion is not reduced. Pointing at the logo also sends the bee off.
 * The wander bee (companion-bee.js) waits behind its switch in the page header.
 */
function rotateCoFirstAuthors(line, pair) {
  const logo = document.querySelector(".hx-lockup img");
  let lap = null;
  if (logo) {
    inlineLogo(logo).then((svg) => {
      if (!svg) return;
      lap = beeLap(svg);
      svg.addEventListener("pointerenter", lap);
      setupCompanionBee(svg, [...pair.querySelectorAll("[data-author]")], reducedMotion);
    });
  }
  let swaps = 0;
  let timer = 0;
  let onScreen = false;
  let pointerOn = false;
  let focusIn = false;
  const schedule = () => {
    clearTimeout(timer);
    if (!onScreen || pointerOn || focusIn || document.hidden || reducedMotion.matches) return;
    timer = setTimeout(() => {
      swapAuthors(pair);
      if (swaps % BEE_LAP_EVERY === 0) lap?.();
      swaps += 1;
      schedule();
    }, AUTHOR_SWAP_EVERY_MS);
  };
  line.addEventListener("pointerenter", () => {
    pointerOn = true;
    schedule();
  });
  line.addEventListener("pointerleave", () => {
    pointerOn = false;
    schedule();
  });
  line.addEventListener("focusin", () => {
    focusIn = true;
    schedule();
  });
  line.addEventListener("focusout", (event) => {
    focusIn = line.contains(event.relatedTarget);
    schedule();
  });
  document.addEventListener("visibilitychange", schedule);
  reducedMotion.addEventListener("change", schedule);
  new IntersectionObserver((entries) => {
    onScreen = entries.at(-1).isIntersecting;
    schedule();
  }).observe(line);
}

function linkButton(label, iconClass, href) {
  const content = [icon(iconClass), element("span", { text: label })];
  if (href) return element("a", { className: BUTTON_CLASS, attrs: { href } }, content);
  return element(
    "button",
    { className: BUTTON_CLASS, attrs: { type: "button", disabled: "", title: `${label}: coming soon` } },
    [...content, element("span", { className: "hx-soon", text: "soon" })],
  );
}

/** "Paper, arXiv, code and video": button labels as one phrase, the later ones lower-cased unless written like arXiv. */
function labelPhrase(labels) {
  const words = labels.map((label, index) => (index && /^[A-Z][a-z]/.test(label) ? label.toLowerCase() : label));
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function renderLinks(links) {
  const buttons = [
    ...LINK_BUTTONS.map(({ key, label, icon: iconClass }) => linkButton(label, iconClass, links[key] ?? null)),
    ...SITE_BUTTONS.map(({ label, icon: iconClass, href }) => linkButton(label, iconClass, href)),
  ];
  const nav = document.getElementById("paper-links");
  nav.replaceChildren(...buttons.map((button) => element("span", { className: "link-block" }, [button])));
  // Phones hide the "soon" tags (index.css) and touch screens cannot show the buttons' titles, so one line under the
  // buttons names what is still to come; screen readers already hear each button's tag.
  const missing = LINK_BUTTONS.filter(({ key }) => !links[key]).map(({ label }) => label);
  if (missing.length) {
    nav.after(element("p", { className: "hx-soon-note", text: `${labelPhrase(missing)} coming soon.`, attrs: { "aria-hidden": "true" } }));
  }
}

/* ---------- Demo window ---------- */

function showMediaNotice(frame, text) {
  frame.classList.add("has-notice");
  frame.replaceChildren(element("p", { className: "hx-notice" }, [icon("fas fa-film"), element("span", { text })]));
}

function selectTab(tabs, selected, groups) {
  for (const tab of tabs) {
    const active = tab === selected;
    const panel = document.getElementById(tab.getAttribute("aria-controls"));
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    tab.parentElement.classList.toggle("is-active", active);
    panel.hidden = !active;
    if (!active) playback.stop(groups.get(panel));
  }
}

function moveTabFocus(event, tabs, groups) {
  const index = tabs.indexOf(event.currentTarget);
  const targets = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: tabs.length - 1 };
  if (!Object.hasOwn(targets, event.key)) return;
  event.preventDefault();
  const next = tabs[(targets[event.key] + tabs.length) % tabs.length];
  selectTab(tabs, next, groups);
  next.focus();
}

async function loadDemos(root) {
  if (!mediaBase()) return null;
  try {
    return (await loadJSON(root.dataset.media)).demos ?? null;
  } catch (error) {
    console.warn(`Demo videos unavailable: ${error.message}`);
    return null;
  }
}

/**
 * Fill a demo frame; the selected demo autoplays while visible, unless motion is reduced. The video plays at `rate`
 * (the panel's data-rate), which a new source keeps as its default.
 */
function mountDemo(frame, demo, label, rate) {
  const size = { width: demo.width, height: demo.height };
  const still = element("img", {
    className: "hx-still",
    attrs: { loading: "lazy", decoding: "async", ...size, alt: label, src: mediaUrl(demo.poster) },
  });
  const video = element("video", { attrs: { loop: "", playsinline: "", preload: "none", "aria-hidden": "true", ...size } });
  video.defaultPlaybackRate = rate;
  video.playbackRate = rate;
  frame.style.aspectRatio = `${demo.width} / ${demo.height}`;
  frame.replaceChildren(still, video);
  still.addEventListener("error", () => group.fail(), { once: true });
  const group = new LoopingVideo({
    zone: frame,
    media: frame,
    video,
    still,
    src: mediaUrl(demo.key),
    label: "demo video",
    autoplay: true,
    hint: null,
    onFail: () => showMediaNotice(frame, FAILED_NOTICE),
  });
  frame.addEventListener("click", () => playback.toggle(group));
  return group;
}

async function setupDemoWindow(root) {
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const groups = new Map();
  for (const tab of tabs) {
    tab.addEventListener("click", (event) => {
      event.preventDefault();
      selectTab(tabs, tab, groups);
    });
    tab.addEventListener("keydown", (event) => moveTabFocus(event, tabs, groups));
  }
  const demos = await loadDemos(root);
  for (const panel of root.querySelectorAll("[data-demo]")) {
    const frame = panel.querySelector(".hx-frame");
    const demo = demos?.[panel.dataset.demo];
    if (demo) groups.set(panel, mountDemo(frame, demo, panel.dataset.label, Number(panel.dataset.rate) || 1));
    else showMediaNotice(frame, MEDIA_NOTICE);
  }
}

/* ---------- Theory animations ---------- */

/**
 * The theory animations (theory.html). Each animation panel can also show an interactive figure: the switch of
 * static/js/theory/core.js, loaded only on this page, picks "Interactive" or "Animation" per panel and reports it
 * through onMode. A panel's playback group is built the first time the panel shows its animation and is switched off
 * while it shows the interactive figure, so that figure never plays or loads the video. Without core.js every panel
 * shows its animation.
 *
 * As an animation, hovering anywhere on its row plays it and tapping the animation toggles it; a row with several
 * animations plays each one while the pointer rests on that animation. A stopped animation returns to its first
 * frame, the complete drawing its still shows.
 */
function setupAnimations() {
  const panels = [...document.querySelectorAll(".hx-anim[data-anim]")].flatMap(animationPanels);
  if (!panels.length) return;
  import("./theory/core.js").then(
    ({ attachFigure }) => {
      for (const panel of panels) attachFigure(panel.media, { onMode: panel.show });
    },
    (error) => {
      console.info(`Interactive figures unavailable, the animations show instead: ${error.message}`);
      for (const panel of panels) panel.show("animation");
    },
  );
}

/** The animation panels of one row; show(mode) builds or enables a panel's video for "animation", else disables it. */
function animationPanels(row) {
  const items = [...row.querySelectorAll(".hx-anim-media")];
  const heading = row.querySelector("h3")?.textContent.trim();
  return items.map((media) => {
    let group = null;
    media.addEventListener("click", () => {
      if (group?.enabled) playback.toggle(group);
    });
    const show = (mode) => {
      if (mode === "animation") group ??= animationVideo(row, media, items.length > 1, heading);
      group?.setEnabled(mode === "animation");
    };
    return { media, show };
  });
}

/** One panel's hover-to-play group: hovering its row plays it, or hovering the panel itself in a row of several. */
function animationVideo(row, media, shared, heading) {
  const video = media.querySelector("video");
  const name = media.closest(".hx-anim-item")?.querySelector(".hx-anim-label")?.textContent.trim();
  const title = [heading, name].filter(Boolean).join(", ");
  return new LoopingVideo({
    zone: shared ? media : row,
    media,
    video,
    still: media.querySelector("img"),
    src: video.dataset.src,
    type: ANIM_TYPE,
    fallback: video.dataset.fallback,
    rewind: true,
    label: title ? `animation: ${title}` : "animation",
    hint: "below",
  });
}

/* ---------- Math ---------- */

/** Typeset \( \) and \[ \] math with KaTeX's auto-render, which loads after this module. */
function renderMath() {
  if (typeof window.renderMathInElement !== "function") {
    console.warn("KaTeX is not available; formulas are shown as TeX.");
    return;
  }
  for (const node of document.querySelectorAll("[data-math]")) {
    window.renderMathInElement(node, { delimiters: MATH_DELIMITERS, throwOnError: false });
  }
}

/* ---------- Depth and normals ---------- */

function geometryPanel(view, panel) {
  const where = `${view.label} (${DATASET_LABELS[view.dataset] ?? view.dataset})`;
  const image = element("img", {
    attrs: {
      src: view.images[panel.key],
      width: view.width,
      height: view.height,
      loading: "lazy",
      decoding: "async",
      alt: `${panel.alt}: ${where}, held-out view ${view.view}`,
    },
  });
  return element("figure", { className: "hx-geo-panel" }, [
    image,
    element("figcaption", { text: panel.label }),
  ]);
}

function geometryRow(view) {
  const dataset = DATASET_LABELS[view.dataset] ?? view.dataset;
  const title = element("p", { className: "hx-geo-title" }, [
    element("strong", { text: view.label }),
    ` ${dataset}, held-out view ${view.view}`,
  ]);
  const strip = element("div", { className: "hx-geo-strip", attrs: { role: "group", "aria-label": `${view.label}, ${dataset}` } });
  strip.style.setProperty("--hx-geo-aspect", `${view.width} / ${view.height}`);
  strip.append(...GEOMETRY_PANELS.map((panel) => geometryPanel(view, panel)));
  return element("div", { className: "hx-geo-row" }, [title, strip]);
}

async function setupGeometry(root) {
  try {
    const data = await loadJSON(root.dataset.src);
    if (data?.version !== 1 || !Array.isArray(data.views)) throw new Error(`${root.dataset.src}: expected version 1 views`);
    root.replaceChildren(...data.views.map(geometryRow));
  } catch (error) {
    console.error("The depth and normal views could not be loaded", error);
    root.replaceChildren(element("p", { className: "hx-notice", text: "The depth and normal views could not be loaded." }));
  }
}

/* ---------- BibTeX ---------- */

function copyBySelection(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const copied = document.execCommand("copy");
  if (copied) selection.removeAllRanges();
  return copied;
}

async function copyText(node) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(node.textContent);
      return true;
    } catch (error) {
      // Permission denied or no focus: fall back to selecting the text.
      console.warn(`Clipboard API failed, using the selection instead: ${error.message}`);
    }
  }
  return copyBySelection(node);
}

function setupBibtexCopy(button) {
  const code = document.getElementById(button.dataset.copyTarget);
  const label = button.querySelector("[data-copy-label]");
  const status = document.getElementById("bibtex-status");
  let resetTimer;
  button.addEventListener("click", async () => {
    const copied = await copyText(code);
    label.textContent = copied ? "Copied" : "Selected";
    status.textContent = copied ? "BibTeX copied to the clipboard." : "BibTeX selected; copy it with the keyboard.";
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      label.textContent = "Copy";
    }, COPY_FEEDBACK_MS);
  });
}

/* ---------- Deep links ---------- */

/**
 * Keep the section named by the URL hash at the top while the components above it render and grow,
 * until the visitor scrolls, clicks or types, or HASH_HOLD_MS passes. The browser's own jump to the
 * hash runs once, often before the comparison player, gallery and slider have their final height.
 * A reload or a step through the history keeps the scroll position the browser restores.
 */
function holdHashTarget() {
  const target = window.location.hash ? document.getElementById(window.location.hash.slice(1)) : null;
  const navigation = performance.getEntriesByType("navigation")[0];
  if (!target || navigation?.type !== "navigate") return;
  const observer = new ResizeObserver(() => target.scrollIntoView({ block: "start", behavior: "instant" }));
  const release = () => {
    observer.disconnect();
    for (const type of HASH_RELEASE_EVENTS) window.removeEventListener(type, release);
  };
  observer.observe(document.body);
  for (const type of HASH_RELEASE_EVENTS) window.addEventListener(type, release, { passive: true });
  setTimeout(release, HASH_HOLD_MS);
}

/* ---------- Start ---------- */

function init() {
  const config = window.HEXELS_CONFIG;
  if (!config) throw new Error("window.HEXELS_CONFIG is missing: load static/js/config.js before site.js");
  if (document.getElementById("authors")) renderAuthors(config.AUTHORS ?? [], config.AFFILIATION ?? []);
  if (document.getElementById("paper-links")) renderLinks(config.LINKS ?? {});
  const demo = document.getElementById("demo-root");
  if (demo) setupDemoWindow(demo);
  setupAnimations();
  const geometry = document.getElementById("geometry-root");
  if (geometry) setupGeometry(geometry);
  const copyButton = document.querySelector("[data-copy-target]");
  if (copyButton) setupBibtexCopy(copyButton);
  // KaTeX's deferred scripts come after the page modules and run before DOMContentLoaded.
  document.addEventListener("DOMContentLoaded", renderMath, { once: true });
  holdHashTarget();
}

init();
