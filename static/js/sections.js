/**
 * Honeycomb rail: a quiet section indicator at the right edge of the project page (index.html) and the animated
 * theory (theory.html), styled by static/css/sections.css.
 *
 * Every section of <main> with an h2 gets one small hexagonal cell, linked to the section. The cell of the section
 * being read fills with honey from the bottom as the reader moves through it, the sections above it keep a light
 * fill and the sections below stay outlines. Entering a section slides its short name out of its cell for a moment,
 * when only margin lies beside the cell; hovering the rail, or reaching it with the keyboard, shows every name where
 * the margin holds them all, and otherwise (.is-tight) only the name of the cell under the pointer or the focus. The
 * rail is one tab stop, on the section being read, and the arrow keys move along it. In-page links scroll smoothly
 * through index.css, which also respects prefers-reduced-motion.
 *
 * The rail appears once the title has mostly scrolled away (an IntersectionObserver on the header), and only where
 * it fits beside the content without covering it: on every resize the free margin right of the widest container in
 * <main> is measured against the rail. The wide containers leave that room from a window about 1408 px wide, so
 * laptops narrower than that, tablets and phones show no rail. One passive scroll listener updates the cells at most
 * once per animation frame, and nothing runs while the tab is hidden.
 */

// Short names by section id; any other section of <main> with an h2 is named by its heading.
const LABELS = {
  abstract: "Abstract",
  method: "Method",
  primitives: "Primitives",
  comparisons: "Novel views",
  gallery: "All scenes",
  results: "Results",
  variants: "Variants",
  surfaces: "Surfaces",
  geometry: "Depth and normals",
  images2d: "2D images",
  bibtex: "BibTeX",
  hexel: "What is a Hexel?",
  "linear-color": "Why linear color",
  hexagon: "Why a hexagon",
  pixels: "To pixels",
  summary: "In short",
};
// The reader is in the section that crosses the reading line, LINE of the way down the window. Over the last
// stretch of the page the line slides to the bottom of the window, so that the closing sections, which never
// reach LINE, are still read in turn and the last cell fills when the page ends.
const LINE = 0.3;
// A section's name glides out once the scrolling has settled in it, SETTLE_MS after the last frame that moved the
// page, so a long jump or a fling names only where it ends; it shows for ANNOUNCE_MS before it fades.
const SETTLE_MS = 200;
const ANNOUNCE_MS = 1500;
// The rail appears once less than this fraction of the header is on screen.
const REVEAL_RATIO = 0.5;
// Cell geometry in CSS px. A flat-topped hexagon, as in the logo: 12.7 px wide and 11 px tall, so its flat edges
// fall on whole pixels; the corners are rounded like the logo's. The focus ring is a larger hexagon around it,
// and the cell's SVG spans -CELL_VIEW to CELL_VIEW in both directions.
const CELL_RADIUS = 2 * 5.5 / Math.sqrt(3);
const CELL_CORNER = 1.2;
const RING_RADIUS = 8.9;
const RING_CORNER = 2;
const CELL_VIEW = 10;
// Margins, in CSS px: at least RAIL_MIN_GAP between the content and the rail and between the rail and the window
// edge, at most RAIL_MAX_RIGHT between the rail and the edge, and RAIL_MIN_EDGE above and below it.
const RAIL_MIN_GAP = 10;
const RAIL_MAX_RIGHT = 24;
const RAIL_MIN_EDGE = 24;
const SVG_NS = "http://www.w3.org/2000/svg";
const CLIP_ID = "hx-rail-clip";
const HONEY_ID = "hx-rail-honey";

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/* ---------- Markup ---------- */

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgElement(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

/** A flat-topped regular hexagon around the origin with circumradius `radius` and corners rounded to `corner`. */
function hexagonPath(radius, corner) {
  const vertices = Array.from({ length: 6 }, (_, k) => [radius * Math.cos((k * Math.PI) / 3), radius * Math.sin((k * Math.PI) / 3)]);
  // A fillet of radius `corner` in a corner of 120 degrees meets each edge corner / sqrt(3) from the vertex; the
  // edges are `radius` long.
  const cut = corner / Math.sqrt(3) / radius;
  const toward = (from, to) => from.map((value, axis) => (value + (to[axis] - value) * cut).toFixed(3)).join(" ");
  const parts = vertices.map((vertex, k) => {
    const enter = toward(vertex, vertices[(k + 5) % 6]);
    const leave = toward(vertex, vertices[(k + 1) % 6]);
    return `${k ? "L" : "M"}${enter}A${corner} ${corner} 0 0 1 ${leave}`;
  });
  return `${parts.join("")}Z`;
}

/** The honey gradient (bottom to top) and the hexagonal clip path that every cell uses. */
function sharedDefinitions(cellPath) {
  const svg = svgElement("svg", { class: "hx-rail-defs", "aria-hidden": "true", focusable: "false" });
  const defs = svgElement("defs");
  const clip = svgElement("clipPath", { id: CLIP_ID });
  clip.append(svgElement("path", { d: cellPath }));
  const honey = svgElement("linearGradient", { id: HONEY_ID, x1: 0, y1: 1, x2: 0, y2: 0 });
  for (const [offset, name] of [[0, "bottom"], [0.55, "middle"], [1, "top"]]) {
    honey.append(svgElement("stop", { offset, class: `hx-rail-honey-stop-${name}` }));
  }
  defs.append(clip, honey);
  svg.append(defs);
  return svg;
}

/** One cell: a focus ring, the hexagon's body, the honey clipped to it and its edge on top. */
function cellGraphic(cellPath, ringPath) {
  const apothem = (CELL_RADIUS * Math.sqrt(3)) / 2;
  const svg = svgElement("svg", {
    class: "hx-rail-cell",
    viewBox: `${-CELL_VIEW} ${-CELL_VIEW} ${2 * CELL_VIEW} ${2 * CELL_VIEW}`,
    "aria-hidden": "true",
    focusable: "false",
  });
  const clipped = svgElement("g", { "clip-path": `url(#${CLIP_ID})` });
  clipped.append(svgElement("rect", {
    class: "hx-rail-honey",
    x: -CELL_RADIUS,
    y: -apothem,
    width: 2 * CELL_RADIUS,
    height: 2 * apothem,
    fill: `url(#${HONEY_ID})`,
  }));
  svg.append(
    svgElement("path", { class: "hx-rail-ring", d: ringPath }),
    svgElement("path", { class: "hx-rail-body", d: cellPath }),
    clipped,
    svgElement("path", { class: "hx-rail-edge", d: cellPath }),
  );
  return svg;
}

/* ---------- Rail ---------- */

class HoneycombRail {
  /**
   * @param {HTMLElement} main the page's <main>, before which the rail is inserted
   * @param {{section: HTMLElement, label: string}[]} entries the sections, in page order
   * @param {HTMLElement | null} header the title; the rail appears once it has mostly scrolled away
   */
  constructor(main, entries, header) {
    this.main = main;
    this.sections = entries.map(({ section }) => section);
    this.current = null;
    this.fill = -1;
    this.fits = false;
    this.revealed = false;
    this.frame = 0;
    this.needsMeasure = true;
    this.pending = false;
    this.settleTimer = 0;
    this.nameTimer = 0;
    this.named = null;
    this.containers = [];
    this.build(entries);
    main.before(this.nav);
    this.size = parseFloat(getComputedStyle(this.nav).getPropertyValue("--hx-rail-size")) || 24;

    const schedule = () => this.schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", () => this.schedule(true));
    window.addEventListener("pageshow", () => this.schedule(true));
    document.addEventListener("visibilitychange", () => this.onVisibilityChange());
    // Components and math render after this module and change the sections' heights; a classic scrollbar that
    // appears with them also narrows the window.
    new ResizeObserver(() => this.schedule(true)).observe(main);
    this.nav.addEventListener("keydown", (event) => this.onKeydown(event));
    if (header) {
      new IntersectionObserver(
        (records) => {
          const record = records.at(-1);
          this.setRevealed(!(record.isIntersecting && record.intersectionRatio >= REVEAL_RATIO));
        },
        { threshold: [0, REVEAL_RATIO] },
      ).observe(header);
    } else {
      this.setRevealed(true);
    }
    this.schedule(true);
  }

  build(entries) {
    const cellPath = hexagonPath(CELL_RADIUS, CELL_CORNER);
    const ringPath = hexagonPath(RING_RADIUS, RING_CORNER);
    this.nav = element("nav", "hx-rail");
    this.nav.setAttribute("aria-label", "Sections");
    const list = element("ol", "hx-rail-list");
    this.items = entries.map(({ section, label }, index) => {
      const link = element("a", "hx-rail-link");
      link.href = `#${section.id}`;
      link.dataset.state = "ahead";
      link.tabIndex = index === 0 ? 0 : -1;
      const name = element("span", "hx-rail-label", label);
      link.append(name, cellGraphic(cellPath, ringPath));
      const item = element("li", "hx-rail-item");
      item.style.setProperty("--hx-rail-index", String(index));
      item.append(link);
      list.append(item);
      return { item, link, name };
    });
    this.nav.append(sharedDefinitions(cellPath), list);
  }

  /** Update the cells in the next animation frame; `measure` also re-checks whether and where the rail fits. */
  schedule(measure = false) {
    this.needsMeasure ||= measure;
    if (this.frame || document.hidden) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.needsMeasure) this.measure();
      if (this.fits) this.update();
    });
  }

  /**
   * Show the rail only where it fits between the widest container's content and the window edge (from a window
   * about 1408 px wide), and mark it .is-tight where the margin is too narrow for every name at once.
   */
  measure() {
    this.needsMeasure = false;
    const width = document.documentElement.clientWidth;
    this.containers = [...this.main.querySelectorAll(".hx-container")].map((container) => {
      const style = getComputedStyle(container);
      return { container, left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight) };
    });
    let contentRight = 0;
    for (const { container, right } of this.containers) {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0) contentRight = Math.max(contentRight, rect.right - right);
    }
    const room = (width - contentRight - this.size) / 2;
    const tallEnough = window.innerHeight >= this.items.length * this.size + 2 * RAIL_MIN_EDGE;
    const fits = room >= RAIL_MIN_GAP && tallEnough;
    const right = Math.min(RAIL_MAX_RIGHT, room);
    if (fits) this.nav.style.setProperty("--hx-rail-right", `${right.toFixed(1)}px`);
    if (fits !== this.fits) {
      this.fits = fits;
      this.nav.classList.toggle("is-fit", fits);
      if (!fits) this.hideName();
    }
    if (fits) {
      // Every name unrolled at once (a hover on the rail) must end left of the cells and clear of the content;
      // otherwise a hover or the keyboard focus shows only the name of the cell it is on.
      const zigzag = parseFloat(getComputedStyle(this.nav).getPropertyValue("--hx-rail-zigzag")) || 0;
      const widest = Math.max(...this.items.map(({ name }) => name.offsetWidth)) + zigzag;
      this.nav.classList.toggle("is-tight", width - right - this.size - 1 - widest < contentRight + RAIL_MIN_GAP);
    }
  }

  /** Find the section that crosses the reading line and how far through it the line is. */
  update() {
    const height = window.innerHeight;
    const scrollable = document.documentElement.scrollHeight - height;
    const stretch = height * (1 - LINE);
    const t = clamp((window.scrollY - (scrollable - stretch)) / stretch, 0, 1);
    const line = height * (LINE + (1 - LINE) * t * t * (3 - 2 * t));
    const tops = this.sections.map((section) => section.getBoundingClientRect().top);
    const end = this.sections.at(-1).getBoundingClientRect().bottom;
    let current = -1;
    tops.forEach((top, index) => {
      if (top <= line) current = index;
    });
    let fill = 0;
    if (current >= 0) {
      const start = tops[current];
      const stop = current + 1 < tops.length ? tops[current + 1] : end;
      fill = clamp((line - start) / Math.max(stop - start, 1), 0, 1);
    }
    this.render(current, Math.round(fill * 200) / 200);
    if (this.named && !this.nameIsClear(this.named)) this.hideName();
  }

  render(current, fill) {
    if (current !== this.current) {
      const first = this.current === null;
      this.items.forEach(({ link }, index) => {
        link.dataset.state = index < current ? "read" : index === current ? "current" : "ahead";
        if (index === current) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
        // One tab stop for the whole rail, on the section being read (the first before any); arrows move along it.
        link.tabIndex = index === Math.max(current, 0) ? 0 : -1;
      });
      this.current = current;
      this.fill = -1;
      this.hideName();
      // The section the page opens in goes unnamed; any other is named once the scrolling settles in it.
      this.pending = current >= 0 && !first;
    }
    // Each frame that moves the page pushes the name back.
    if (this.pending) this.nameSoon();
    if (current >= 0 && fill !== this.fill) {
      this.items[current].link.style.setProperty("--hx-rail-fill", String(fill));
      this.fill = fill;
    }
  }

  /** Name the current section SETTLE_MS from now, unless the page moves again before then. */
  nameSoon() {
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.announce(), SETTLE_MS);
  }

  /**
   * Slide out the current section's name, unless the rail is out of sight, already shows every name, or the name
   * would cover content.
   */
  announce() {
    this.pending = false;
    if (this.current < 0 || !this.revealed || !this.fits) return;
    if (this.nav.matches(":hover") || this.nav.querySelector(":focus-visible")) return;
    const entry = this.items[this.current];
    if (!this.nameIsClear(entry)) return;
    this.named = entry;
    entry.item.classList.add("is-announced");
    this.nameTimer = setTimeout(() => this.hideName(), ANNOUNCE_MS);
  }

  /**
   * True when the unrolled name of `entry` would lie in empty margin: beside it, no container of <main> has content.
   * Where the window leaves too little margin, names show only on hover and keyboard focus.
   */
  nameIsClear({ link, name }) {
    const box = link.getBoundingClientRect();
    // Layout offsets ignore the tag's slide, so this is where the name rests once out.
    const left = box.left + name.offsetLeft;
    const right = left + name.offsetWidth;
    const top = box.top + box.height / 2 - name.offsetHeight / 2;
    const bottom = top + name.offsetHeight;
    return this.containers.every(({ container, left: padLeft, right: padRight }) => {
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.bottom <= top || rect.top >= bottom) return true;
      return rect.right - padRight <= left || rect.left + padLeft >= right;
    });
  }

  hideName() {
    this.pending = false;
    clearTimeout(this.settleTimer);
    clearTimeout(this.nameTimer);
    this.named?.item.classList.remove("is-announced");
    this.named = null;
  }

  setRevealed(revealed) {
    if (revealed === this.revealed) return;
    this.revealed = revealed;
    this.nav.classList.toggle("is-revealed", revealed);
    this.hideName();
    // Appearing mid-page, for example after a reload, the rail names the section it starts in.
    if (revealed && (this.current ?? -1) >= 0) {
      this.pending = true;
      this.nameSoon();
    }
  }

  onVisibilityChange() {
    if (!document.hidden) {
      this.schedule(true);
      return;
    }
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.hideName();
  }

  /** Up and down arrows, Home and End move the focus along the rail; with a modifier they keep their usual meaning. */
  onKeydown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const links = this.items.map(({ link }) => link);
    const index = links.indexOf(event.target);
    const targets = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: links.length - 1 };
    if (index < 0 || !Object.hasOwn(targets, event.key)) return;
    event.preventDefault();
    links[clamp(targets[event.key], 0, links.length - 1)].focus();
  }
}

/* ---------- Start ---------- */

function init() {
  const main = document.querySelector("main");
  if (!main) return;
  const entries = [...main.querySelectorAll(":scope > section[id]")]
    .map((section) => ({ section, heading: section.querySelector("h2") }))
    .filter(({ heading }) => heading)
    .map(({ section, heading }) => ({ section, label: LABELS[section.id] ?? heading.textContent.trim() }));
  if (entries.length < 2) return;
  new HoneycombRail(main, entries, document.querySelector("body > header"));
}

init();
