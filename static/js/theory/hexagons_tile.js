/**
 * Interactive "Hexagons tile, ellipses overlap" (theory.html, hexagons_tile): with one error matrix Q everywhere, the
 * largest hexagons H of the error ellipses E = {h : h^T Q h <= 2 epsilon} tile the plane from a lattice of centers,
 * while the ellipses at the same centers overlap and cover each point |E| / |H| = 2 pi / (3 sqrt(3)) = 1.209 times
 * on average (Propositions prop:ellipse-domain and prop:planar-covering). The visitor stretches and tilts E by the
 * knobs at the ends of its axes in the middle cell (or the sliders for lambda_1, lambda_2 and the tilt), shrinks the
 * ellipses to a size rho times E (rho from sqrt(3) / 2, where neighbors only touch, to 1, E itself), and shows the
 * hexagons, the ellipses or both. The bars give the mean coverage: 1 for the hexagons, rho^2 2 pi / (3 sqrt(3)) for
 * the ellipses; the readout adds the share of the plane the ellipses leave uncovered and cover twice, from the exact
 * areas of a disk of radius rho in the un-stretched hexagon (a disk minus six circular segments). Every number is
 * the same for every Q, because the whole picture is one linear map of the round case.
 *
 * The math, constants, colors and layout are those of tile_frame() and draw_hexagons_tile() in
 * tools/make_theory_animations.py, with epsilon = 0.5. The default state is the poster frame (loop phase 0.58): semi-
 * axes 1 and 0.62 (lambda_1 = 1, lambda_2 = 2.601), tilt 20 degrees, the ellipses at size 1 and both layers shown.
 */
import {
  COLORS,
  FONT,
  PT,
  clamp,
  cssVar,
  dragHandles,
  ease,
  el,
  flip,
  group,
  htmlLabel,
  icon,
  mix,
  readout,
  regularPolygon,
  rgb,
  signed,
  slider,
  svgEl,
  svgPath,
  svgStage,
  svgText,
  uid,
} from "./core.js";

export const hint = "Drag the knobs at the ends of the middle ellipse's axes, or shrink the ellipses.";

// tools/make_theory_animations.py, section 9 (hexagons_tile).
const EPS = 0.5; // HEX_EPS: 2 eps = 1, so the semi-axes of E are 1 / sqrt(lambda_k)
const REST_AXES = { a: 1.0, b: 0.62, tilt: 20 }; // TILE_REST
const BASIS = [[1.5, Math.sqrt(3) / 2], [0, Math.sqrt(3)]]; // TILE_BASIS columns b_1, b_2 (unit circumradius)
const HEX = regularPolygon(6); // TILE_HEX: H in the un-stretched frame, inscribed in the unit circle
const COVER = "#5d70ae"; // COVER_COLOR
const COVER_ALPHA = 0.28;
const BOX = { left: 18, bottom: 52, right: 420, top: 322 }; // TILE_BOX
const CENTER = [219, 187]; // TILE_CENTER
const ZOOM = 34; // TILE_ZOOM[1]: pixels per unit in the lattice view
const FADE = { x: 196, y: 132, full: 0.55 }; // TILE_FADE
const BAR_X = { hex: 548, ellipse: 628 }; // TILE_BAR_X
const BAR = { base: 134, unit: 66, width: 34 }; // TILE_BAR_BASE, TILE_BAR_UNIT, TILE_BAR_WIDTH
const TITLE_Y = 330; // TILE_TITLE_Y

// The widget beyond the animation: control ranges, the rest state and the knobs.
const LAMBDA_RANGE = [0.45, 3]; // semi-axes from 1.49 down to 0.58
const RHO_RANGE = [Math.sqrt(3) / 2, 1]; // neighbors touch at sqrt(3) / 2; at 1 the ellipses are E and cover the plane
const REST = { lambda1: 1 / REST_AXES.a ** 2, lambda2: 1 / REST_AXES.b ** 2, tilt: REST_AXES.tilt, rho: 1, show: "both" };
const KNOB = { radius: 6, halo: 13 };
const SHOW = [
  ["hexagons", "Hexagons", "border-all"],
  ["ellipses", "Ellipses", "circle"],
  ["both", "Both", "layer-group"],
];
const CIRCLE = Array.from({ length: 120 }, (_, k) => [Math.cos((2 * Math.PI * k) / 120), Math.sin((2 * Math.PI * k) / 120)]);
const HEX_AREA = (3 * Math.sqrt(3)) / 2; // |H| in the un-stretched frame: the area of a lattice cell
const INRADIUS = Math.sqrt(3) / 2;
const SHARE_TOLERANCE = 1e-6; // shares below this count as none (the readout shows tenths of a percent)

/**
 * Shares of the plane for ellipses of size rho at the lattice centers, from the round case: a disk of radius rho
 * about the center of its hexagon (circumradius 1) loses a circular segment beyond each of the six edges once
 * rho > sqrt(3) / 2; a point of the cell outside the disk is outside every disk, and for rho <= 1 no point lies in
 * three disks, so the share covered twice is the mean coverage minus the covered share.
 */
function shares(rho) {
  // Half the chord beyond an edge, and the segment from atan2, stable as rho approaches the inradius (where acos is not).
  const half = rho > INRADIUS ? Math.sqrt((rho - INRADIUS) * (rho + INRADIUS)) : 0;
  const segment = half > 0 ? rho * rho * Math.atan2(half, INRADIUS) - INRADIUS * half : 0;
  const inside = Math.PI * rho * rho - 6 * segment;
  const mean = (Math.PI * rho * rho) / HEX_AREA;
  const covered = Math.min(inside / HEX_AREA, 1);
  return { mean, uncovered: 1 - covered, twice: Math.max(mean - covered, 0) };
}

/** One shape of E: A = U diag(a, b) maps the un-stretched (round) frame to the plane, as tile_frame() has it. */
function frame({ lambda1, lambda2, tilt }) {
  const a = 1 / Math.sqrt(lambda1); // sqrt(2 eps / lambda_1) with 2 eps = 1
  const b = 1 / Math.sqrt(lambda2);
  const psi = (tilt * Math.PI) / 180;
  const [c, s] = [Math.cos(psi), Math.sin(psi)];
  const map = ([u, v]) => [c * a * u - s * b * v, s * a * u + c * b * v];
  const areaE = Math.PI * a * b;
  const areaH = HEX_AREA * a * b;
  return { a, b, psi, tu: [c, s], tv: [-s, c], map, areaE, areaH, ratio: areaH / areaE, coverage: areaE / areaH };
}

const toPanel = ([x, y]) => [CENTER[0] + ZOOM * x, flip(CENTER[1] + ZOOM * y)];
const fromPanel = ([x, y]) => [(x - CENTER[0]) / ZOOM, (flip(y) - CENTER[1]) / ZOOM];
const wrapDegrees = (angle) => ((((angle + 180) % 360) + 360) % 360) - 180;
const formatDegrees = (angle) => `${signed(Math.round(angle), 0)}°`;
const percent = (share) => `${(100 * share).toFixed(1)}%`;

/** The lattice cells near the panel: centers in the plane and the spotlight weight of each, as draw_hexagons_tile(). */
function cells(current) {
  // Lattice coordinates of the panel's corners bound the cells to visit.
  const [[m00, m01], [m10, m11]] = [0, 1].map((row) => [0, 1].map((col) => {
    const column = BASIS[col];
    return current.map(column)[row];
  }));
  const det = m00 * m11 - m01 * m10;
  const halfX = (BOX.right - BOX.left) / 2 / ZOOM + 2 * Math.max(current.a, current.b);
  const halfY = (BOX.top - BOX.bottom) / 2 / ZOOM + 2 * Math.max(current.a, current.b);
  const corners = [[-halfX, -halfY], [halfX, -halfY], [halfX, halfY], [-halfX, halfY]].map(([x, y]) => [
    (m11 * x - m01 * y) / det,
    (-m10 * x + m00 * y) / det,
  ]);
  const range = (k) => [Math.floor(Math.min(...corners.map((p) => p[k]))), Math.ceil(Math.max(...corners.map((p) => p[k])))];
  const [[i0, i1], [j0, j1]] = [range(0), range(1)];
  const out = [];
  for (let i = i0; i <= i1; i += 1) {
    for (let j = j0; j <= j1; j += 1) {
      const local = [i * BASIS[0][0] + j * BASIS[1][0], i * BASIS[0][1] + j * BASIS[1][1]];
      const [x, y] = current.map(local);
      const reach = Math.hypot((ZOOM * x) / FADE.x, (ZOOM * y) / FADE.y);
      const weight = ease((1 - reach) / (1 - FADE.full));
      if (weight >= 0.01) out.push({ local, weight, middle: i === 0 && j === 0 });
    }
  }
  return out;
}

export function mount(container, { stage, controls }) {
  const state = { ...REST };
  const select = cssVar("--hx-select") || "#5d70ae";
  const ink = rgb(COLORS.ink);
  const guide = rgb(COLORS.guide);
  const orange = rgb(COLORS.shape[6]);
  const svg = svgStage(stage);

  /* The lattice panel, clipped like the animation's axes. */
  const clipId = uid("hx-ht-clip");
  const defs = svgEl("defs", {}, svg);
  const clip = svgEl("clipPath", { id: clipId }, defs);
  svgEl("rect", { x: BOX.left, y: flip(BOX.top), width: BOX.right - BOX.left, height: BOX.top - BOX.bottom }, clip);
  const panel = svgEl("g", { "clip-path": `url(#${clipId})` }, svg);
  const layers = {
    hexFill: svgEl("g", { fill: orange }, panel),
    ellipseFill: svgEl("g", { fill: rgb(COVER) }, panel),
    hexEdge: svgEl("g", { fill: "none", stroke: orange, "stroke-width": 1.4 * PT, "stroke-linejoin": "round" }, panel),
    ellipseEdge: svgEl("g", { fill: "none", stroke: ink, "stroke-width": 0.8 * PT }, panel),
  };
  // E itself in the middle cell (size 1), the shape the knobs and sliders change.
  const errorEllipse = svgEl("path", { fill: "none", stroke: ink, "stroke-width": 1.6 * PT, "stroke-dasharray": `${3 * PT} ${2 * PT}` }, panel);
  const eLabel = svgText(svg, { size: FONT.formula, anchor: "middle", align: "middle", halo: true });

  const headline = svgText(svg, { size: FONT.label, anchor: "middle", align: "middle" });
  const headNote = svgText(svg, { size: FONT.small, anchor: "middle", align: "middle", fill: COLORS.note });
  svgText(svg, { size: FONT.label, anchor: "middle", align: "middle" }).set("color error $\\leq\\varepsilon$ in each ellipse", CENTER[0], flip(28));

  /* Bars of the mean coverage, as the animation's second set, with the line at 1 and the shape icons. */
  svgText(svg, { size: FONT.label, anchor: "middle", align: "middle" }).set("mean coverage", 0.5 * (BAR_X.hex + BAR_X.ellipse), flip(TITLE_Y));
  svgEl("line", { x1: BAR_X.hex - 30, x2: BAR_X.ellipse + 30, y1: flip(BAR.base), y2: flip(BAR.base), stroke: guide, "stroke-width": 1.0 * PT }, svg);
  const bars = Object.fromEntries([["hex", COLORS.shape[6]], ["ellipse", COVER]].map(([key, color]) => [key, {
    lower: svgEl("rect", { x: BAR_X[key] - BAR.width / 2, width: BAR.width, fill: rgb(mix("#ffffff", color, 0.5)), stroke: rgb(color), "stroke-width": 1.3 * PT }, svg),
    upper: svgEl("rect", { x: BAR_X[key] - BAR.width / 2, width: BAR.width, fill: rgb(mix("#ffffff", color, 0.85)), stroke: rgb(color), "stroke-width": 1.3 * PT }, svg),
    value: svgText(svg, { size: FONT.label, anchor: "middle", align: "bottom" }),
  }]));
  svgEl("line", {
    x1: BAR_X.hex - 26,
    x2: BAR_X.ellipse + 26,
    y1: flip(BAR.base + BAR.unit),
    y2: flip(BAR.base + BAR.unit),
    stroke: guide,
    "stroke-width": 1.0 * PT,
    "stroke-dasharray": `${1 * PT} ${2.2 * PT}`,
  }, svg);
  const hexIcon = HEX.map(([u, v]) => [BAR_X.hex + 11 * u, flip(BAR.base - 22 + 11 * v)]);
  svgEl("path", { d: svgPath(hexIcon), fill: "white", stroke: orange, "stroke-width": 1.6 * PT, "stroke-linejoin": "miter" }, svg);
  svgEl("ellipse", { cx: BAR_X.ellipse, cy: flip(BAR.base - 22), rx: 15, ry: 9.5, fill: rgb(mix("#ffffff", COVER, COVER_ALPHA)), stroke: ink, "stroke-width": 1.3 * PT }, svg);

  /* Knobs at the ends of E's axes in the middle cell, above everything. */
  const knobs = ["u", "v"].map(() => {
    const node = svgEl("g", {}, svg);
    return {
      node,
      halo: svgEl("circle", { r: KNOB.halo, fill: select, opacity: 0 }, node),
      grip: svgEl("circle", { r: KNOB.radius, fill: "white", stroke: ink, "stroke-width": 1.4 }, node),
    };
  });

  /* Controls: the shape of E, the size of the ellipses and what to show. */
  const update = (key) => (value) => {
    state[key] = value;
    render();
  };
  const lambdaSliders = ["u", "v"].map((key, k) => slider({
    label: `$\\lambda_${k + 1}$`,
    name: `Bound lambda ${k + 1} on the slope's change along t_${key}`,
    value: state[`lambda${k + 1}`],
    min: LAMBDA_RANGE[0],
    max: LAMBDA_RANGE[1],
    step: 0.01,
    accent: COLORS.tangent[key],
    onInput: update(`lambda${k + 1}`),
  }));
  const tiltSlider = slider({
    label: "$\\psi$",
    name: "Tilt of E in degrees",
    value: state.tilt,
    min: -180,
    max: 180,
    step: 1,
    format: formatDegrees,
    onInput: update("tilt"),
  });
  const rhoSlider = slider({
    label: "$\\rho$",
    name: "Size of the ellipses as a share of E, from touching (0.866) to E itself (1)",
    value: state.rho,
    min: RHO_RANGE[0],
    max: RHO_RANGE[1],
    step: 0.001,
    format: (value) => value.toFixed(3),
    accent: COVER,
    onInput: update("rho"),
  });
  const showButtons = {};
  const showSwitch = el("div", { className: "hx-fig-switch", attrs: { role: "group", "aria-label": "Shapes shown" } }, SHOW.map(([key, label, glyph]) => {
    const button = el("button", { attrs: { type: "button", "aria-pressed": "false" } }, [icon(glyph), htmlLabel(label)]);
    button.addEventListener("click", () => {
      state.show = key;
      render();
    });
    showButtons[key] = button;
    return button;
  }));
  controls.append(
    group({ legend: "Error ellipse $E$" }, [lambdaSliders[0].element, lambdaSliders[1].element, tiltSlider.element]),
    group({ legend: "Size of the ellipses", swatch: COVER }, [rhoSlider.element]),
    group({ legend: "Show" }, [showSwitch]),
  );
  const summary = readout();
  controls.append(summary);
  controls.style.setProperty("--hx-fig-grid", "repeat(auto-fit, minmax(11.5rem, 1fr))");

  let current = frame(state);
  let hovered = null; // "u" or "v"
  let dragged = null;

  function paintHighlights() {
    const active = dragged ?? hovered;
    knobs.forEach(({ halo, grip }, k) => {
      const on = active === ["u", "v"][k];
      halo.setAttribute("opacity", on ? (dragged ? 0.28 : 0.18) : 0);
      grip.setAttribute("stroke", on ? select : ink);
    });
  }

  function render() {
    current = frame(state);
    const { a, b, tu, tv, map, ratio, coverage } = current;
    const { rho, show } = state;
    const showHex = show !== "ellipses";
    const showEllipses = show !== "hexagons";
    const both = show === "both";

    // The cells: hexagon fills only without the ellipses, hexagon edges lighter with them, ellipses rho times E.
    const hexFill = [];
    const hexEdge = [];
    const ellipseFill = [];
    const ellipseEdge = [];
    for (const { local, weight } of cells(current)) {
      const hexagon = svgPath(HEX.map(([u, v]) => toPanel(map([local[0] + u, local[1] + v]))));
      const ellipse = svgPath(CIRCLE.map(([u, v]) => toPanel(map([local[0] + rho * u, local[1] + rho * v]))));
      if (showHex && !both) hexFill.push(`<path d="${hexagon}" fill-opacity="${(0.13 * weight).toFixed(3)}"/>`);
      if (showHex) hexEdge.push(`<path d="${hexagon}" stroke-opacity="${(weight * (both ? 0.55 : 1)).toFixed(3)}"/>`);
      if (showEllipses) {
        ellipseFill.push(`<path d="${ellipse}" fill-opacity="${(COVER_ALPHA * weight).toFixed(3)}"/>`);
        ellipseEdge.push(`<path d="${ellipse}" stroke-opacity="${(0.3 * weight).toFixed(3)}"/>`);
      }
    }
    layers.hexFill.innerHTML = hexFill.join("");
    layers.hexEdge.innerHTML = hexEdge.join("");
    layers.ellipseFill.innerHTML = ellipseFill.join("");
    layers.ellipseEdge.innerHTML = ellipseEdge.join("");
    errorEllipse.setAttribute("d", svgPath(CIRCLE.map((point) => toPanel(map(point)))));
    errorEllipse.setAttribute("opacity", rho < 1 - 1e-9 ? 1 : 0);
    const reach = 22 / ZOOM;
    const [ex, ey] = toPanel([-(b + reach) * tv[0], -(b + reach) * tv[1]]); // beyond the end of E's minor axis
    eLabel.set("$E$", ex, ey);
    eLabel.node.setAttribute("opacity", rho < 1 - 1e-9 && ey > flip(BOX.top) + 12 && ey < flip(BOX.bottom) - 12 ? 1 : 0);

    // Headline: what the shown shapes do.
    const { mean, uncovered, twice } = shares(rho);
    let lines;
    if (!showEllipses) lines = ["hexagons tile the plane", "each point is covered once"];
    else if (uncovered < SHARE_TOLERANCE) lines = ["the ellipses overlap", "at the same centers"];
    else if (twice < SHARE_TOLERANCE) lines = ["the ellipses only touch", "and leave gaps"];
    else lines = ["smaller ellipses still overlap", "and leave gaps"];
    headline.set(lines[0], CENTER[0], flip(377));
    headNote.set(lines[1], CENTER[0], flip(342));

    // Bars: 1 for the hexagons, the ellipses' mean coverage, the part above 1 in the overlap color.
    for (const [key, value] of [["hex", 1], ["ellipse", mean]]) {
      const height = BAR.unit * value;
      const low = Math.min(height, BAR.unit);
      bars[key].lower.setAttribute("y", flip(BAR.base + low));
      bars[key].lower.setAttribute("height", low);
      bars[key].upper.setAttribute("y", flip(BAR.base + height));
      bars[key].upper.setAttribute("height", Math.max(height - BAR.unit, 0));
      bars[key].upper.setAttribute("display", height > BAR.unit + 1e-9 ? "inline" : "none");
      bars[key].value.set(key === "hex" ? "1" : value.toFixed(3), BAR_X[key], flip(BAR.base + height + 5));
    }

    // Knobs at +a t_u and +b t_v of E in the middle cell.
    [[a, tu], [b, tv]].forEach(([length, direction], k) => {
      const [x, y] = toPanel([length * direction[0], length * direction[1]]);
      for (const circle of [knobs[k].halo, knobs[k].grip]) {
        circle.setAttribute("cx", x);
        circle.setAttribute("cy", y);
      }
    });
    for (const [key, button] of Object.entries(showButtons)) button.setAttribute("aria-pressed", String(key === show));

    summary.replaceChildren(
      el("span", { className: "hx-fig-readout-main" }, [
        icon("circle-check"),
        " ",
        htmlLabel(
          `Hexagons: every point covered once. Ellipses of size $\\rho=${rho.toFixed(3)}$ at the same centers: ` +
            `${percent(uncovered)} of the plane uncovered, ${percent(twice)} covered twice, mean coverage ${mean.toFixed(3)}.`,
        ),
      ]),
      el("span", { className: "hx-fig-readout-note" }, [
        htmlLabel(
          `One ellipse $E$ holds ${coverage.toFixed(3)} times the area of its largest hexagon ($|H|/|E|=${ratio.toFixed(3)}$) ` +
            "for every shape of $E$. At size 1 the ellipses are $E$ and cover the plane, as in the paper. Smaller ones leave gaps at the hexagons' corners.",
        ),
      ]),
    );
    svg.setAttribute(
      "aria-label",
      `Hexagons with the shape of an error ellipse E of semi-axes ${a.toFixed(2)} and ${b.toFixed(2)}, tilted ${signed(Math.round(state.tilt), 0)} degrees, ` +
        `tile the plane. Ellipses of size ${rho.toFixed(3)} times E at the same centers leave ${percent(uncovered)} of the plane uncovered and ` +
        `cover ${percent(twice)} twice, a mean coverage of ${mean.toFixed(3)}.`,
    );
    paintHighlights();
  }

  /* Dragging a knob stretches E along that axis and turns it, as in the "largest patch" figure. */
  const drag = dragHandles(svg, {
    hit(point) {
      const { a, b, tu, tv } = current;
      const ends = [toPanel([a * tu[0], a * tu[1]]), toPanel([b * tv[0], b * tv[1]])];
      const k = ends.findIndex(([x, y]) => Math.hypot(point.x - x, point.y - y) <= KNOB.radius + point.slop);
      if (k < 0) return null;
      return { key: ["u", "v"][k], offset: [ends[k][0] - point.x, ends[k][1] - point.y] };
    },
    start(handle) {
      dragged = handle.key;
      paintHighlights();
    },
    move(handle, point) {
      const [u, v] = fromPanel([point.x + handle.offset[0], point.y + handle.offset[1]]);
      const length = Math.hypot(u, v);
      if (length < 1e-6) return;
      state.tilt = Math.round(wrapDegrees((Math.atan2(v, u) * 180) / Math.PI - (handle.key === "v" ? 90 : 0)));
      const key = handle.key === "u" ? "lambda1" : "lambda2";
      state[key] = clamp(Math.round(100 / length ** 2) / 100, ...LAMBDA_RANGE);
      lambdaSliders[0].set(state.lambda1);
      lambdaSliders[1].set(state.lambda2);
      tiltSlider.set(state.tilt);
      render();
    },
    end() {
      dragged = null;
      paintHighlights();
    },
    hover(handle) {
      hovered = handle ? handle.key : null;
      paintHighlights();
    },
  });

  render();
  return {
    reset() {
      Object.assign(state, REST);
      lambdaSliders[0].set(state.lambda1);
      lambdaSliders[1].set(state.lambda2);
      tiltSlider.set(state.tilt);
      rhoSlider.set(state.rho);
      render();
    },
    destroy() {
      drag.destroy();
    },
  };
}
