/**
 * Interactive "Least perimeter, most area" (theory.html, the honeycomb row): one module for both of its figures.
 * honeycomb ("Equal perimeter") is this module's mount(); honeycomb_area ("Equal area") is mountEqualArea(), which
 * static/js/theory/honeycomb_area.js re-exports as its mount().
 *
 * Equal area: the triangle, square and hexagon tilings with one cell of area A outlined in each, and bars of those
 * cells' perimeters 2 (m A tan(pi / m))^(1/2), on one scale. The area slider, or a drag on a knob of an outlined cell,
 * scales every cell: the perimeters follow and their order never changes (4.559, 4.000 and 3.722 at A = 1).
 *
 * Equal perimeter: seven cells of each shape, every cell with the same perimeter P, and bars of the area each patch
 * covers, P^2 / (4 m tan(pi / m)) per cell, on one scale. The perimeter slider, or a drag on the knob at a patch's
 * corner, scales every cell; the areas keep the ratios 1 : 1.30 : 1.50.
 *
 * Both share a "Sides m" view: the regular m-gon (m from 3 to 12) at the figure's area or perimeter, beside a plot of
 * A / P^2 = 1 / (4 m tan(pi / m)) against m that climbs toward the circle's 1 / (4 pi) and marks the only regular
 * tilings, m = 3, 4 and 6. A view switch under each figure, or the m slider, opens it.
 *
 * The math, constants, colors and layout are those of tiling_cells(), honey_patch(), draw_honeycomb() and
 * draw_honeycomb_area() in tools/make_theory_animations.py. The default states are the posters (loop phases 0.75 and
 * 0.80): every tiling and patch complete, unit-area cells in the first figure and P = 4 in the second, the length unit
 * of the first figure, in which the animation's 226-pixel perimeter gives the square cell area 1.
 */
import {
  COLORS,
  FONT,
  PT,
  SIZE,
  cssVar,
  dragHandles,
  el,
  flip,
  group,
  htmlLabel,
  icon,
  mix,
  readout,
  regularPolygon,
  rgb,
  shoelace,
  slider,
  svgEl,
  svgPath,
  svgStage,
  svgText,
  textColor,
  uid,
} from "./core.js";

export const hint = "Drag a corner knob to change the perimeter, or switch to Sides m.";
export const areaHint = "Drag a knob on an outlined cell to change the area, or switch to Sides m.";

// tools/make_theory_animations.py, sections 6 (honeycomb) and 7 (honeycomb_area).
const SQRT3 = Math.sqrt(3);
const SHAPES = [3, 4, 6];
const SHAPE_NAMES = { 3: "triangle", 4: "square", 6: "hexagon" };
const FRAME = 2.4; // HONEY_FRAME: half side of each equal-area frame, in unit-area cell lengths
const AREA_BOX = 190; // HONEYCOMB_AREA_BOX
const AREA_LEFT = { 3: 30, 4: 265, 6: 500 }; // HONEYCOMB_AREA_LEFT
const AREA_BOTTOM = 160; // HONEYCOMB_AREA_BOTTOM
const AREA_BAR = { y: 142, half: 4 }; // HONEYCOMB_AREA_BAR_Y, HONEYCOMB_AREA_BAR_HALF
const HONEY_CELLS = 7;
const HONEY_PERIMETER = 226; // GIF pixels: the shared perimeter of the poster
const HONEY_NUDGE = { 3: [0, 0.1], 4: [0, -0.1], 6: [0, 0] };
const HONEY_CENTER_X = { 3: 125, 4: 360, 6: 595 };
const HONEY_CENTER_Y = 257;
const HONEY_TITLE_Y = 378;
const HONEY_BAR = { y: 140, half: 6, width: 190 };
const HONEY_VALUE_Y = 112;
const HONEY_FILL = 0.35;

// Each cell's area over its perimeter squared, 1 / (4 m tan(pi / m)), and the circle's limit 1 / (4 pi).
const areaFactor = (m) => 1 / (4 * m * Math.tan(Math.PI / m));
const CIRCLE_FACTOR = 1 / (4 * Math.PI);
// Perimeters of the unit-area cells: 4.559, 4.000 and 3.722 (HONEYCOMB_AREA_PERIMETERS).
const unitPerimeter = (m) => Math.sqrt(1 / areaFactor(m));
const AREA_BAR_UNIT = AREA_BOX / unitPerimeter(3); // GIF pixels per unit length (HONEYCOMB_AREA_BAR_UNIT)
// The equal-perimeter figure in the length unit of the equal-area one: 226 pixels are P = 4, so a square cell has area 1.
const POSTER_PERIMETER = 4;

// The widget beyond the animations: slider ranges and rest values, the m explorer's layout, knobs.
const AREA = { rest: 1, min: 0.25, max: 1, step: 0.01 };
const PERIMETER = { rest: POSTER_PERIMETER, min: 2, max: POSTER_PERIMETER, step: 0.01 };
const SIDES = { min: 3, max: 12, rest: 6, tilers: new Set(SHAPES) };
const POLYGON_NAMES = {
  3: "triangle", 4: "square", 5: "pentagon", 6: "hexagon", 7: "heptagon", 8: "octagon", 9: "nonagon", 10: "decagon",
  11: "hendecagon", 12: "dodecagon",
};
const EXPLORER = {
  shape: { x: 165, y: 200, unit: 118 }, // the m-gon: layout center and layout units per unit length
  plot: { left: 412, right: 700, top: 78, bottom: 290 }, // the A / P^2 axes in layout units
  m: [2.5, 12.5],
  q: [0.044, 0.082],
  yTicks: [0.05, 0.06, 0.07, 0.08],
  xLabels: new Set([3, 4, 6, 8, 10, 12]), // the tilers and every other m: two-digit labels would touch
};
const KNOB = { radius: 6, halo: 13 };
const TICK = { length: 3 * PT, width: 0.8 * PT, pad: 2.5 * PT };
const MAIN_VIEW = { area: "Tilings", perimeter: "Patches" }; // the switch's name for each figure's own view

/* ---------- Geometry (the script's) ---------- */

function mean(points) {
  return [0, 1].map((axis) => points.reduce((sum, point) => sum + point[axis], 0) / points.length);
}

/**
 * tiling_cells(m) over a wider index range (the equal-area frames show up to twice as many cells across): the
 * unit-area cells of the regular m-tiling, one centered at the origin, each counterclockwise.
 */
function tilingCells(m) {
  const cells = [];
  if (m === 4) {
    for (let i = -7; i <= 7; i += 1) {
      for (let j = -7; j <= 7; j += 1) cells.push([[i - 0.5, j - 0.5], [i + 0.5, j - 0.5], [i + 0.5, j + 0.5], [i - 0.5, j + 0.5]]);
    }
  } else if (m === 3) {
    const side = Math.sqrt(4 / SQRT3);
    const height = (side * SQRT3) / 2;
    for (let j = -7; j <= 7; j += 1) {
      for (let i = -11; i <= 11; i += 1) {
        const [x0, y0] = [i * side + (j * side) / 2 - side / 2, j * height - height / 3];
        cells.push([[x0, y0], [x0 + side, y0], [x0 + side / 2, y0 + height]]);
        cells.push([[x0 + side / 2, y0 + height], [x0 + side, y0], [x0 + 1.5 * side, y0 + height]]);
      }
    }
  } else {
    const side = Math.sqrt(2 / (3 * SQRT3));
    for (let i = -9; i <= 9; i += 1) {
      for (let j = -9; j <= 9; j += 1) {
        const center = [1.5 * side * i, SQRT3 * side * (j + 0.5 * (((i % 2) + 2) % 2))]; // Python's i % 2
        cells.push(regularPolygon(6).map(([x, y]) => [center[0] + side * x, center[1] + side * y]));
      }
    }
  }
  return cells.map((cell) => (shoelace(cell) > 0 ? cell : [...cell].reverse()));
}

const TILINGS = Object.fromEntries(SHAPES.map((m) => {
  const cells = tilingCells(m);
  const center = cells.find((cell) => Math.hypot(...mean(cell)) < 1e-9); // honey_center_cell()
  // Unique edges (tiling_edges() without its clip: the frame clips them).
  const edges = new Map();
  for (const cell of cells) {
    cell.forEach((a, k) => {
      const b = cell[(k + 1) % cell.length];
      const key = [a, b].map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`).sort().join(";");
      edges.set(key, [a, b]);
    });
  }
  return [m, { cells, center, edges: [...edges.values()] }];
}));

/**
 * honey_patch(m): the seven cells nearest the lattice point (the apex where six triangles meet, else the middle
 * cell's center) moved by HONEY_NUDGE, scaled to the perimeter HONEY_PERIMETER and centered on the panel by their
 * bounding box, in GIF pixels; the first is the cell nearest the panel center.
 */
function honeyPatch(m) {
  const { cells, center } = TILINGS[m];
  const side = Math.hypot(center[1][0] - center[0][0], center[1][1] - center[0][1]);
  const apex = center.reduce((top, point) => (point[1] > top[1] ? point : top));
  const point = m === 3 ? apex : [0, 0];
  const anchor = [point[0] + side * HONEY_NUDGE[m][0], point[1] + side * HONEY_NUDGE[m][1]];
  const order = cells
    .map((cell, index) => ({ index, distance: Math.hypot(mean(cell)[0] - anchor[0], mean(cell)[1] - anchor[1]) }))
    .sort((p, q) => p.distance - q.distance); // stable, as numpy's kind="stable"
  const scale = HONEY_PERIMETER / (m * side);
  let patch = order.slice(0, HONEY_CELLS).map(({ index }) => cells[index].map(([x, y]) => [scale * x, scale * y]));
  const points = patch.flat();
  const low = [0, 1].map((axis) => Math.min(...points.map((p) => p[axis])));
  const high = [0, 1].map((axis) => Math.max(...points.map((p) => p[axis])));
  const shift = [HONEY_CENTER_X[m] - 0.5 * (low[0] + high[0]), HONEY_CENTER_Y - 0.5 * (low[1] + high[1])];
  patch = patch.map((cell) => cell.map(([x, y]) => [x + shift[0], y + shift[1]]));
  const gaps = patch.map((cell) => Math.hypot(mean(cell)[0] - HONEY_CENTER_X[m], mean(cell)[1] - HONEY_CENTER_Y));
  const first = gaps.indexOf(Math.min(...gaps));
  return [patch[first], ...patch.filter((_, k) => k !== first)];
}

const PATCHES = Object.fromEntries(SHAPES.map((m) => [m, honeyPatch(m)]));
const PATCH_TOTAL_6 = PATCHES[6].reduce((sum, cell) => sum + shoelace(cell), 0); // honey_total(6) at the poster

/* ---------- Drawing helpers ---------- */

/** The vertex of a polygon (layout units) farthest up and to the right: where its knob sits. */
function knobVertex(points) {
  return points.reduce((best, point) => (point[0] - point[1] > best[0] - best[1] ? point : best));
}

function knob(parent, select, ink) {
  const node = svgEl("g", { class: "hx-hc-knob" }, parent);
  const halo = svgEl("circle", { r: KNOB.halo, fill: select, opacity: 0 }, node);
  const grip = svgEl("circle", { r: KNOB.radius, fill: "white", stroke: ink, "stroke-width": 1.4 }, node);
  return {
    node,
    place([x, y]) {
      for (const circle of [halo, grip]) {
        circle.setAttribute("cx", x);
        circle.setAttribute("cy", y);
      }
    },
    light(on, dragging) {
      halo.setAttribute("opacity", on ? (dragging ? 0.28 : 0.18) : 0);
      grip.setAttribute("stroke", on ? select : ink);
    },
  };
}

const plural = (name) => `${name}s`;
const capital = (text) => text[0].toUpperCase() + text.slice(1);
const fixed3 = (value) => value.toFixed(3);
const fixed2 = (value) => value.toFixed(2);

/* ---------- The equal-area tilings ---------- */

function equalAreaView(parent, { select, ink, guide }) {
  const layer = svgEl("g", {}, parent);
  const defs = svgEl("defs", {}, layer);
  const panels = SHAPES.map((m) => {
    const color = rgb(COLORS.shape[m]);
    const left = AREA_LEFT[m];
    const unit = AREA_BOX / (2 * FRAME); // layout units per frame unit
    const frame = { left, top: flip(AREA_BOTTOM + AREA_BOX), size: AREA_BOX, cx: left + AREA_BOX / 2, cy: flip(AREA_BOTTOM + AREA_BOX / 2), unit };
    const clipId = uid("hx-hc-clip");
    svgEl("rect", { x: frame.left, y: frame.top, width: AREA_BOX, height: AREA_BOX }, svgEl("clipPath", { id: clipId }, defs));
    const clipped = svgEl("g", { "clip-path": `url(#${clipId})` }, layer);
    const cellFill = svgEl("path", { fill: color, "fill-opacity": 0.24 }, clipped);
    const lines = svgEl("path", { fill: "none", stroke: color, "stroke-width": 1.5 * PT, "stroke-linecap": "butt" }, clipped);
    svgEl("rect", { x: frame.left, y: frame.top, width: AREA_BOX, height: AREA_BOX, fill: "none", stroke: guide, "stroke-width": 1.0 * PT }, layer);
    const outline = svgEl("path", { fill: "none", stroke: ink, "stroke-width": 3.0 * PT, "stroke-linejoin": "round", "stroke-linecap": "round" }, layer);
    svgText(layer, { size: FONT.label, anchor: "middle", align: "middle", fill: textColor(COLORS.shape[m]) })
      .set(SHAPE_NAMES[m], frame.cx, flip(AREA_BOTTOM + AREA_BOX + 20));
    svgEl("line", { x1: left, x2: left + AREA_BOX, y1: flip(AREA_BAR.y), y2: flip(AREA_BAR.y), stroke: guide, "stroke-width": 1.0 * PT }, layer);
    const bar = svgEl("rect", { x: left, y: flip(AREA_BAR.y + AREA_BAR.half), height: 2 * AREA_BAR.half, fill: color }, layer);
    const value = svgText(layer, { size: FONT.label, anchor: "middle", align: "middle" });
    return { m, frame, cellFill, lines, outline, bar, value };
  });
  svgText(layer, { size: FONT.label, anchor: "middle", align: "middle" }).set("hexagons need the least perimeter", SIZE.width / 2, flip(70));
  svgText(layer, { size: FONT.small, anchor: "middle", align: "middle", fill: COLORS.note })
    .set("among all equal-area tilings (honeycomb theorem)", SIZE.width / 2, flip(34));
  const knobs = panels.map(() => knob(layer, select, ink));

  /** A cell-coordinate point (unit-area lattice) of panel `panel` at cell area `area`, in layout units. */
  const place = (panel, area, [x, y]) => {
    const s = Math.sqrt(area) * panel.frame.unit;
    return [panel.frame.cx + s * x, panel.frame.cy - s * y];
  };

  return {
    group: layer,
    render(area) {
      panels.forEach((panel, k) => {
        const { m, frame } = panel;
        const tiling = TILINGS[m];
        const reach = FRAME / Math.sqrt(area) + 1.2; // frame half side in cell units, plus a cell
        const crosses = ([a, b], axis) => Math.min(a[axis], b[axis]) < reach && Math.max(a[axis], b[axis]) > -reach;
        const segments = tiling.edges
          .filter((edge) => crosses(edge, 0) && crosses(edge, 1))
          .map(([a, b]) => svgPath([place(panel, area, a), place(panel, area, b)], false));
        panel.lines.setAttribute("d", segments.join(""));
        const cell = tiling.center.map((point) => place(panel, area, point));
        panel.cellFill.setAttribute("d", svgPath(cell));
        panel.outline.setAttribute("d", svgPath(cell));
        const length = unitPerimeter(m) * Math.sqrt(area);
        panel.bar.setAttribute("width", AREA_BAR_UNIT * length);
        panel.value.set(`perimeter ${fixed3(length)}`, frame.cx, flip(116));
        panel.knobAt = knobVertex(cell);
        knobs[k].place(panel.knobAt);
      });
    },
    /** The knob under the point, as { panel, center }: a drag scales by the distance from that frame's center. */
    hit(point) {
      for (const [k, panel] of panels.entries()) {
        const [x, y] = panel.knobAt;
        if (Math.hypot(point.x - x, point.y - y) <= KNOB.radius + point.slop) return { panel: k, center: [panel.frame.cx, panel.frame.cy] };
      }
      return null;
    },
    light(handle, dragging) {
      knobs.forEach((item, k) => item.light(handle?.panel === k, dragging));
    },
    describe(area) {
      const lengths = SHAPES.map((m) => fixed3(unitPerimeter(m) * Math.sqrt(area)));
      return `Triangle, square and hexagon tilings with cells of area ${fixed2(area)}; one cell of each outlined, with perimeters ${lengths.join(", ")}.`;
    },
  };
}

/* ---------- The equal-perimeter patches ---------- */

function equalPerimeterView(parent, { select, ink, guide }) {
  const layer = svgEl("g", {}, parent);
  const panels = SHAPES.map((m) => {
    const color = COLORS.shape[m];
    const center = [HONEY_CENTER_X[m], flip(HONEY_CENTER_Y)];
    svgText(layer, { size: FONT.label, anchor: "middle", align: "middle", fill: textColor(color) }).set(SHAPE_NAMES[m], center[0], flip(HONEY_TITLE_Y));
    const cells = PATCHES[m].map(() => svgEl("path", {
      fill: rgb(mix("#ffffff", color, HONEY_FILL)),
      stroke: rgb(color),
      "stroke-width": 1.8 * PT,
      "stroke-linejoin": "round",
    }, layer));
    const left = center[0] - HONEY_BAR.width / 2;
    svgEl("line", { x1: left, x2: left + HONEY_BAR.width, y1: flip(HONEY_BAR.y), y2: flip(HONEY_BAR.y), stroke: guide, "stroke-width": 1.0 * PT }, layer);
    const segments = PATCHES[m].map(() => svgEl("rect", {
      y: flip(HONEY_BAR.y + HONEY_BAR.half),
      height: 2 * HONEY_BAR.half,
      fill: rgb(color),
      stroke: "white",
      "stroke-width": 1.0 * PT,
    }, layer));
    const total = PATCHES[m].reduce((sum, cell) => sum + shoelace(cell), 0);
    const ratio = total / PATCHES[3].reduce((sum, cell) => sum + shoelace(cell), 0);
    const ratioText = Math.abs(ratio - 1) < 1e-12 ? "1" : ratio.toFixed(2); // honey_ratio_text()
    svgText(layer, { size: FONT.label, anchor: "middle", align: "middle" }).set(`relative area ${ratioText}`, center[0], flip(HONEY_VALUE_Y));
    return { m, center, cells, segments, left };
  });
  svgText(layer, { size: FONT.label, anchor: "middle", align: "middle" }).set("hexagons cover the most area", SIZE.width / 2, flip(70));
  svgText(layer, { size: FONT.small, anchor: "middle", align: "middle", fill: COLORS.note })
    .set(`${HONEY_CELLS} cells each, all with the same perimeter`, SIZE.width / 2, flip(32));
  const knobs = panels.map(() => knob(layer, select, ink));

  return {
    group: layer,
    render(perimeter) {
      const scale = perimeter / POSTER_PERIMETER;
      panels.forEach((panel, k) => {
        const [cx, cy] = panel.center;
        const drawn = PATCHES[panel.m].map((cell) => cell.map(([x, y]) => [cx + scale * (x - cx), cy + scale * (flip(y) - cy)]));
        drawn.forEach((cell, i) => panel.cells[i].setAttribute("d", svgPath(cell)));
        // One bar segment per cell, on the poster's scale: the poster's seven hexagons fill the track.
        let start = panel.left;
        PATCHES[panel.m].forEach((cell, i) => {
          const width = (HONEY_BAR.width * shoelace(cell) * scale * scale) / PATCH_TOTAL_6;
          panel.segments[i].setAttribute("x", start);
          panel.segments[i].setAttribute("width", width);
          start += width;
        });
        panel.knobAt = knobVertex(drawn.flat());
        knobs[k].place(panel.knobAt);
      });
    },
    hit(point) {
      for (const [k, panel] of panels.entries()) {
        const [x, y] = panel.knobAt;
        if (Math.hypot(point.x - x, point.y - y) <= KNOB.radius + point.slop) return { panel: k, center: panel.center };
      }
      return null;
    },
    light(handle, dragging) {
      knobs.forEach((item, k) => item.light(handle?.panel === k, dragging));
    },
    describe(perimeter) {
      const totals = SHAPES.map((m) => fixed2(HONEY_CELLS * areaFactor(m) * perimeter ** 2));
      return `Seven triangles, seven squares and seven hexagons, every cell with perimeter ${fixed2(perimeter)}, covering ${totals.join(", ")}: 1 to 1.30 to 1.50.`;
    },
  };
}

/* ---------- The shared m explorer ---------- */

function sidesView(parent, quantity, { select, ink, guide }) {
  const layer = svgEl("g", { display: "none" }, parent);
  const { shape, plot } = EXPLORER;
  const mx = (m) => plot.left + ((m - EXPLORER.m[0]) / (EXPLORER.m[1] - EXPLORER.m[0])) * (plot.right - plot.left);
  const qy = (q) => plot.bottom - ((q - EXPLORER.q[0]) / (EXPLORER.q[1] - EXPLORER.q[0])) * (plot.bottom - plot.top);

  // The m-gon at the figure's area or perimeter, inside the dashed circle with the same.
  const title = svgText(layer, { size: FONT.label, anchor: "middle", align: "middle" });
  const circle = svgEl("circle", {
    cx: shape.x,
    cy: shape.y,
    fill: "none",
    stroke: guide,
    "stroke-width": 1.2 * PT,
    "stroke-dasharray": `${4 * 1.2 * PT} ${2 * 1.2 * PT}`,
  }, layer);
  const polygon = svgEl("path", { "stroke-width": 1.8 * PT, "stroke-linejoin": "round" }, layer);
  const value = svgText(layer, { size: FONT.label, anchor: "middle", align: "middle" });
  const tiles = svgText(layer, { size: FONT.small, anchor: "middle", align: "middle", fill: COLORS.note });

  // The plot of A / P^2 against m.
  svgText(layer, { size: FONT.label, anchor: "middle", align: "middle" }).set("$A/P^2$ of the regular $m$-gon", (plot.left + plot.right) / 2, 35);
  svgEl("path", { d: `M${plot.left},${plot.top}V${plot.bottom}H${plot.right}`, fill: "none", stroke: guide, "stroke-width": 0.9 * PT }, layer);
  for (let m = SIDES.min; m <= SIDES.max; m += 1) {
    svgEl("line", { x1: mx(m), x2: mx(m), y1: plot.bottom, y2: plot.bottom + TICK.length, stroke: ink, "stroke-width": TICK.width }, layer);
    if (EXPLORER.xLabels.has(m)) {
      svgText(layer, { size: FONT.small, anchor: "middle", align: "top" }).set(String(m), mx(m), plot.bottom + TICK.length + TICK.pad);
    }
  }
  for (const q of EXPLORER.yTicks) {
    svgEl("line", { x1: plot.left - TICK.length, x2: plot.left, y1: qy(q), y2: qy(q), stroke: ink, "stroke-width": TICK.width }, layer);
    svgText(layer, { size: FONT.small, anchor: "end", align: "middle" }).set(q.toFixed(2), plot.left - TICK.length - TICK.pad, qy(q));
  }
  svgText(layer, { size: FONT.label, anchor: "middle", align: "top" }).set("sides $m$", (plot.left + plot.right) / 2, plot.bottom + 36);
  svgEl("line", {
    x1: plot.left,
    x2: plot.right,
    y1: qy(CIRCLE_FACTOR),
    y2: qy(CIRCLE_FACTOR),
    stroke: ink,
    "stroke-width": 1.1 * PT,
    "stroke-dasharray": `${1 * 1.1 * PT} ${2.2 * 1.1 * PT}`,
  }, layer);
  svgText(layer, { size: FONT.small, anchor: "end", align: "bottom", fill: COLORS.note }).set("circle $1/(4\\pi)$", plot.right, qy(CIRCLE_FACTOR) - 4);
  const curve = [];
  for (let k = 0; k <= 180; k += 1) {
    const m = SIDES.min + ((SIDES.max - SIDES.min) * k) / 180;
    curve.push([mx(m), qy(areaFactor(m))]);
  }
  svgEl("path", { d: svgPath(curve, false), fill: "none", stroke: guide, "stroke-width": 1.0 * PT }, layer);
  const ring = svgEl("circle", { r: 10, fill: "none", stroke: ink, "stroke-width": 1.4 }, layer);
  const halo = svgEl("circle", { r: KNOB.halo + 2, fill: select, opacity: 0 }, layer);
  for (let m = SIDES.min; m <= SIDES.max; m += 1) {
    const tiler = SIDES.tilers.has(m);
    svgEl("circle", {
      cx: mx(m),
      cy: qy(areaFactor(m)),
      r: tiler ? 6 : 4.5,
      fill: tiler ? rgb(COLORS.shape[m]) : "white",
      stroke: tiler ? "white" : guide,
      "stroke-width": tiler ? 1.2 : 1.5 * PT,
    }, layer);
  }
  svgText(layer, { size: FONT.small, anchor: "middle", align: "middle", fill: COLORS.note }).set("only $m=3,4,6$", mx(9.1), qy(0.0575));
  svgText(layer, { size: FONT.small, anchor: "middle", align: "middle", fill: COLORS.note }).set("tile the plane", mx(9.1), qy(0.0515));
  const shapeKnob = knob(layer, select, ink);
  let knobAt = [0, 0];
  let shownSides = SIDES.rest;

  /** Circumradius (layout units) of the regular m-gon with the figure's area or perimeter `amount`. */
  const radius = (m, amount) => shape.unit * (quantity === "area"
    ? Math.sqrt((2 * amount) / (m * Math.sin((2 * Math.PI) / m)))
    : amount / (2 * m * Math.sin(Math.PI / m)));

  return {
    group: layer,
    render(amount, m) {
      const tiler = SIDES.tilers.has(m);
      const color = tiler ? COLORS.shape[m] : COLORS.guide;
      title.node.setAttribute("fill", rgb(tiler ? textColor(color) : COLORS.ink));
      title.set(`${POLYGON_NAMES[m]}, $m=${m}$`, shape.x, 35);
      const r = radius(m, amount);
      // A flat bottom edge: the triangle points up, the square sits square and the hexagon is flat-topped.
      const points = regularPolygon(m, -Math.PI / 2 + Math.PI / m).map(([x, y]) => [shape.x + r * x, shape.y - r * y]);
      polygon.setAttribute("d", svgPath(points));
      polygon.setAttribute("fill", rgb(mix("#ffffff", color, HONEY_FILL)));
      polygon.setAttribute("stroke", rgb(tiler ? color : COLORS.ink));
      const circleRadius = shape.unit * (quantity === "area" ? Math.sqrt(amount / Math.PI) : amount / (2 * Math.PI));
      circle.setAttribute("r", circleRadius);
      const other = quantity === "area" ? Math.sqrt(amount / areaFactor(m)) : areaFactor(m) * amount * amount;
      value.set(`${quantity === "area" ? "perimeter" : "area"} ${fixed3(other)}`, shape.x, flip(92));
      tiles.set(tiler ? "tiles the plane" : "does not tile the plane", shape.x, flip(58));
      ring.setAttribute("cx", mx(m));
      ring.setAttribute("cy", qy(areaFactor(m)));
      shownSides = m;
      knobAt = knobVertex(points);
      shapeKnob.place(knobAt);
    },
    /**
     * The m-gon's knob scales it; a dot of the plot (or a drag along it) picks m, sideways only (axis "x"), so on a
     * touch screen an up or down swipe that starts on the dots scrolls the page.
     */
    hit(point) {
      if (Math.hypot(point.x - knobAt[0], point.y - knobAt[1]) <= KNOB.radius + point.slop) {
        return { kind: "scale", center: [shape.x, shape.y] };
      }
      // The nearest dot within reach: a finger's reach spans neighbouring dots.
      let nearest = null;
      for (let m = SIDES.min; m <= SIDES.max; m += 1) {
        const distance = Math.hypot(point.x - mx(m), point.y - qy(areaFactor(m)));
        if (distance <= 8 + point.slop && (!nearest || distance < nearest.distance)) nearest = { distance, m };
      }
      return nearest ? { kind: "sides", axis: "x", m: nearest.m } : null;
    },
    sidesAt(x) {
      const m = EXPLORER.m[0] + ((x - plot.left) / (plot.right - plot.left)) * (EXPLORER.m[1] - EXPLORER.m[0]);
      return Math.min(Math.max(Math.round(m), SIDES.min), SIDES.max);
    },
    /** Highlights: the m-gon's knob, or the halo on the hovered dot (on the chosen m while a drag moves it). */
    light(handle, dragging) {
      shapeKnob.light(handle?.kind === "scale", dragging);
      const on = handle?.kind === "sides";
      if (on) {
        const m = dragging ? shownSides : handle.m;
        halo.setAttribute("cx", mx(m));
        halo.setAttribute("cy", qy(areaFactor(m)));
      }
      halo.setAttribute("opacity", on ? (dragging ? 0.28 : 0.18) : 0);
      ring.setAttribute("stroke", on && (dragging || handle.m === shownSides) ? select : ink);
    },
    describe(amount, m) {
      const other = quantity === "area" ? Math.sqrt(amount / areaFactor(m)) : areaFactor(m) * amount * amount;
      return `A regular ${POLYGON_NAMES[m]} of ${quantity} ${fixed2(amount)}, with ${quantity === "area" ? "perimeter" : "area"} ` +
        `${fixed3(other)}, beside a plot of area over perimeter squared against the number of sides, which rises toward the ` +
        "circle's 1 over 4 pi; only 3, 4 and 6 sides tile the plane.";
    },
  };
}

/* ---------- One figure: its view, the m explorer, the controls ---------- */

function mountFigure(container, { stage, controls, setHint }, quantity) {
  const isArea = quantity === "area";
  const range = isArea ? AREA : PERIMETER;
  const state = { amount: range.rest, m: SIDES.rest, view: "main" };
  const colors = { select: cssVar("--hx-select") || "#5d70ae", ink: rgb(COLORS.ink), guide: rgb(COLORS.guide) };
  const svg = svgStage(stage);
  const main = isArea ? equalAreaView(svg, colors) : equalPerimeterView(svg, colors);
  const sides = sidesView(svg, quantity, colors);
  const hints = {
    main: isArea ? areaHint : hint,
    sides: "Drag the ring along the plot to change m, or the knob to resize.",
  };

  /* Controls: the view, the area or perimeter, and m. */
  const viewButtons = {};
  const viewSwitch = el("div", { className: "hx-fig-switch", attrs: { role: "group", "aria-label": "View of the figure" } }, [
    ["main", MAIN_VIEW[quantity], "border-all"],
    ["sides", "Sides $m$", "draw-polygon"],
  ].map(([view, label, glyph]) => {
    const button = el("button", { attrs: { type: "button", "aria-pressed": "false" } }, [icon(glyph), htmlLabel(label)]);
    button.addEventListener("click", () => show(view));
    viewButtons[view] = button;
    return button;
  }));
  const amountSlider = slider({
    label: isArea ? "$A$" : "$P$",
    name: isArea ? "Area A of every cell" : "Perimeter P of every cell",
    value: state.amount,
    min: range.min,
    max: range.max,
    step: range.step,
    onInput: (value) => {
      state.amount = value;
      render();
    },
  });
  const sidesSlider = slider({
    label: "$m$",
    name: "Number of sides m of the regular polygon",
    value: state.m,
    min: SIDES.min,
    max: SIDES.max,
    step: 1,
    format: (value) => String(Math.round(value)),
    onInput: (value) => {
      state.m = Math.round(value);
      if (state.view !== "sides") show("sides");
      else render();
    },
  });
  // The view switch comes last, beside the m slider that also opens the Sides view; columns of 11.5rem or more keep
  // the switch whole, so mid-width layouts wrap it onto a row of its own under the sliders.
  controls.append(
    group({ legend: isArea ? "Cell area" : "Cell perimeter" }, [amountSlider.element]),
    group({ legend: "Sides of the polygon" }, [sidesSlider.element]),
    group({ legend: "View" }, [viewSwitch]),
  );
  const summary = readout();
  controls.append(summary);
  controls.style.setProperty("--hx-fig-grid", "repeat(auto-fit, minmax(11.5rem, 1fr))");

  let hovered = null;
  let dragged = null;

  function show(view) {
    state.view = view;
    for (const [name, button] of Object.entries(viewButtons)) button.setAttribute("aria-pressed", String(name === view));
    main.group.setAttribute("display", view === "main" ? "inline" : "none");
    sides.group.setAttribute("display", view === "sides" ? "inline" : "none");
    hovered = null;
    setHint(hints[view]);
    render();
  }

  function render() {
    const { amount, m } = state;
    if (state.view === "main") main.render(amount);
    else sides.render(amount, m);
    paintHighlights();
    svg.setAttribute("aria-label", state.view === "main" ? main.describe(amount) : sides.describe(amount, m));
    summary.replaceChildren(...(isArea ? areaReadout(amount, m) : perimeterReadout(amount, m)));
  }

  function areaReadout(area, m) {
    if (state.view === "main") {
      const lengths = SHAPES.map((shape) => fixed3(unitPerimeter(shape) * Math.sqrt(area)));
      return [
        el("span", { className: "hx-fig-readout-main" }, [
          icon("circle-check"),
          ` At area ${fixed2(area)} the perimeters are ${lengths[0]} (triangle), ${lengths[1]} (square) and ${lengths[2]} (hexagon): `,
          el("strong", { text: "the hexagon needs the least." }),
        ]),
        el("span", { className: "hx-fig-readout-note" }, [
          htmlLabel("A regular $m$-gon of area $A$ has perimeter $P=2(mA\\,\\tan(\\pi/m))^{1/2}$, so the order holds at every area."),
        ]),
      ];
    }
    const length = Math.sqrt(area / areaFactor(m));
    const hexagon = Math.sqrt(area / areaFactor(6));
    return sidesReadout(m, `A regular ${POLYGON_NAMES[m]} of area ${fixed2(area)} has perimeter ${fixed3(length)}` +
      (m === 6 ? "." : ` (hexagon: ${fixed3(hexagon)}).`));
  }

  function perimeterReadout(perimeter, m) {
    if (state.view === "main") {
      const totals = SHAPES.map((shape) => HONEY_CELLS * areaFactor(shape) * perimeter ** 2);
      return [
        el("span", { className: "hx-fig-readout-main" }, [
          icon("circle-check"),
          ` Seven cells of perimeter ${fixed2(perimeter)} cover ${fixed2(totals[0])} (triangles), ${fixed2(totals[1])} (squares) and ` +
            `${fixed2(totals[2])} (hexagons), `,
          el("strong", { text: `1 : ${fixed2(totals[1] / totals[0])} : ${fixed2(totals[2] / totals[0])}.` }),
        ]),
        el("span", { className: "hx-fig-readout-note" }, [
          htmlLabel("A regular $m$-gon of perimeter $P$ has area $P^2/(4m\\,\\tan(\\pi/m))$, so the ratios hold at every perimeter."),
        ]),
      ];
    }
    const area = areaFactor(m) * perimeter ** 2;
    const hexagon = areaFactor(6) * perimeter ** 2;
    return sidesReadout(m, `A regular ${POLYGON_NAMES[m]} of perimeter ${fixed2(perimeter)} has area ${fixed3(area)}` +
      (m === 6 ? "." : ` (hexagon: ${fixed3(hexagon)}).`));
  }

  function sidesReadout(m, first) {
    const tiler = SIDES.tilers.has(m);
    return [
      el("span", { className: "hx-fig-readout-main" }, [
        icon(tiler ? "circle-check" : "circle-xmark"),
        ` ${first} `,
        el("strong", { text: tiler ? `${capital(plural(POLYGON_NAMES[m]))} tile the plane.` : `${capital(plural(POLYGON_NAMES[m]))} do not tile the plane.` }),
      ]),
      el("span", { className: "hx-fig-readout-note" }, [
        htmlLabel(`$A/P^2=1/(4m\\,\\tan(\\pi/m))=${areaFactor(m).toFixed(4)}$ grows with $m$ toward the circle's ` +
          `$1/(4\\pi)=${CIRCLE_FACTOR.toFixed(4)}$, but only $m=3,4,6$ tile the plane, and of these the hexagon comes closest.`),
      ]),
    ];
  }

  function paintHighlights() {
    const active = dragged ?? hovered;
    const view = state.view === "main" ? main : sides;
    view.light(active, Boolean(dragged));
  }

  const drag = dragHandles(svg, {
    hit(point) {
      return (state.view === "main" ? main : sides).hit(point);
    },
    start(handle, point) {
      if (handle.kind === "sides") {
        setSides(handle.m);
      } else {
        handle.distance = Math.max(Math.hypot(point.x - handle.center[0], point.y - handle.center[1]), 1);
        handle.amount = state.amount;
      }
      dragged = handle;
      paintHighlights();
    },
    move(handle, point) {
      if (handle.kind === "sides") {
        setSides(sides.sidesAt(point.x));
        return;
      }
      const ratio = Math.hypot(point.x - handle.center[0], point.y - handle.center[1]) / handle.distance;
      const amount = handle.amount * (isArea ? ratio * ratio : ratio); // area grows with the square of the size
      state.amount = Math.min(Math.max(Math.round(amount / range.step) * range.step, range.min), range.max);
      amountSlider.set(state.amount);
      render();
    },
    end() {
      dragged = null;
      paintHighlights();
    },
    hover(handle) {
      hovered = handle;
      paintHighlights();
    },
    cursor: (handle) => (handle.kind === "sides" ? "ew-resize" : "grab"),
  });

  function setSides(m) {
    if (m === state.m) return;
    state.m = m;
    sidesSlider.set(m);
    render();
  }

  show("main");
  return {
    reset() {
      state.amount = range.rest;
      state.m = SIDES.rest;
      amountSlider.set(state.amount);
      sidesSlider.set(state.m);
      show("main");
    },
    destroy() {
      drag.destroy();
    },
  };
}

/** The "Equal perimeter" figure (honeycomb). */
export function mount(container, options) {
  return mountFigure(container, options, "perimeter");
}

/** The "Equal area" figure (honeycomb_area), re-exported by honeycomb_area.js. */
export function mountEqualArea(container, options) {
  return mountFigure(container, options, "area");
}
