/**
 * Interactive "The largest patch in one error ellipse" (theory.html, why_hexagon): the error ellipse
 * E = {p + h : h^T Q h <= 2 epsilon} with the largest triangle, square and hexagon inside it, which are the affine
 * images sqrt(2 epsilon) Q^(-1/2) R H_m of the regular polygons H_m inscribed in the unit circle, beside the
 * un-stretched unit disk and bars of their areas relative to the triangle. The visitor stretches and tilts E by the
 * knobs at the ends of its axes (or the sliders for lambda_1, lambda_2 and the tilt), and turns the polygons, all by
 * the same rotation R, by dragging a corner of the hexagon (or the turn slider). The bars stay at 1 : 1.54 : 2
 * (hexagon over square 1.30) for every ellipse and every turn. Whenever the hexagon's turn is a multiple of 60
 * degrees (R = U), the hexagon is the Hexel: the triangle and square step back and its axes s_u t_u and s_v t_v
 * appear along those of E, with s_u = sqrt(3 epsilon / (2 lambda_1)) and s_v = sqrt(3 epsilon / (2 lambda_2)).
 *
 * The math, constants, colors, line styles and layout are those of ellipse_frame(), draw_polygon_set(),
 * draw_area_bars() and draw_why_hexagon() in tools/make_theory_animations.py, with epsilon = 0.5 (HEX_EPS). The
 * default state is the poster frame (loop phase 0.30): semi-axes 1.55 and 0.95 (lambda_1 = 0.416, lambda_2 = 1.108),
 * tilt 20 degrees, the hexagon turned 43.6 degrees (0.727 of its 60-degree period) and the triangle and square at
 * R = U. All three polygons turn together from there.
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
  shoelace,
  signed,
  slider,
  svgEl,
  svgPath,
  svgStage,
  svgText,
} from "./core.js";

export const hint = "Drag the knobs at the ends of E's axes, or a corner of the hexagon.";

// tools/make_theory_animations.py, section 4 (why_hexagon).
const EPS = 0.5; // HEX_EPS: 2 eps = 1, so the semi-axes of E are 1 / sqrt(lambda_k)
const REST_AXES = { a: 1.55, b: 0.95, tilt: 20 }; // HEX_REST: semi-axes along t_u and t_v, angle of t_u in degrees
const SPIN = [0.04, 0.44]; // HEX_SPIN
const POSTER_PHASE = 0.3;
const SHAPES = [3, 4, 6];
const SHAPE_STYLES = { 3: [4, 2], 4: [1, 1.6], 6: null }; // SHAPE_STYLES: dashed, dotted, solid
const ICON_ANGLES = { 3: Math.PI / 2, 4: Math.PI / 4, 6: 0 }; // HEX_ICON_ANGLES
const PANEL = { x: 180, y: 186, scale: 84 }; // HEX_PANEL: center of E and pixels per unit
const PANEL_BOX = { left: 18, bottom: 50, right: 342, top: 322 }; // HEX_PANEL_BOX: E stays inside it
const DISK = { x: 458, y: 190, radius: 74 }; // HEX_DISK
const BAR_X = { 3: 590, 4: 636, 6: 682 }; // HEX_BAR_X
const BAR = { base: 134, unit: 66, width: 30 }; // HEX_BAR_BASE, HEX_BAR_UNIT, HEX_BAR_WIDTH
const TITLE_Y = 330; // HEX_TITLE_Y
const HEADLINE_X = 192; // HEX_HEADLINE_X

// The hexagon's turn at the poster: R H_6 at window(0.30, *HEX_SPIN) % 1 of its 60-degree period (43.62 degrees).
const POSTER_TURN = 60 * (ease((POSTER_PHASE - SPIN[0]) / (SPIN[1] - SPIN[0])) % 1);

// The widget beyond the animation: control ranges, the rest state, the knobs, the snap to the Hexel's turn.
const LAMBDA_RANGE = [0.28, 3]; // semi-axes from 1.89 down to 0.58
const REST = { lambda1: 1 / REST_AXES.a ** 2, lambda2: 1 / REST_AXES.b ** 2, tilt: REST_AXES.tilt, turn: POSTER_TURN };
const KNOB = { radius: 6, halo: 13 };
const VERTEX_HALO = 11;
// On a touch screen only the corners in E turn the polygons, with this share of a finger's grab radius, so that most
// swipes over the ellipse and the disk scroll the page; the knobs keep the full radius and the turn slider does the rest.
const CORNER_TOUCH_SLOP = 0.6;
const P_OFFSET = 21; // layout units from the center to the label p beside the Hexel's arrows
const HEXEL_SNAP = 2.5; // degrees: a dragged corner snaps to the Hexel's turn this close to it

/** One rotation of the polygons and one shape of E: every quantity the figure shows, as ellipse_frame() has them. */
function frame({ lambda1, lambda2, tilt, turn }) {
  const a = 1 / Math.sqrt(lambda1); // sqrt(2 eps / lambda_1) with 2 eps = 1
  const b = 1 / Math.sqrt(lambda2);
  const psi = (tilt * Math.PI) / 180;
  const [c, s] = [Math.cos(psi), Math.sin(psi)];
  const tu = [c, s];
  const tv = [-s, c];
  const turns = { 3: turn - POSTER_TURN, 4: turn - POSTER_TURN, 6: turn };
  const unit = {};
  const world = {};
  const areas = {};
  for (const m of SHAPES) {
    const t = (turns[m] * Math.PI) / 180;
    // R H_m in the unit disk, and its image sqrt(2 eps) Q^(-1/2) R H_m = U diag(a, b) U^T R H_m in E.
    unit[m] = [];
    world[m] = [];
    for (let k = 0; k < m; k += 1) {
      const beta = t + (2 * Math.PI * k) / m; // angle relative to t_u
      unit[m].push([Math.cos(psi + beta), Math.sin(psi + beta)]);
      const [x, y] = [a * Math.cos(beta), b * Math.sin(beta)];
      world[m].push([c * x - s * y, s * x + c * y]);
    }
    areas[m] = shoelace(world[m]);
  }
  const lambdas = [lambda1, lambda2];
  // Eq. eq:theory-optimal-scales: at R = U the hexagon is the Hexel with these scales, its corners on E.
  const scales = lambdas.map((lambda) => Math.sqrt((3 * EPS) / (2 * lambda)));
  const offset = ((turn % 60) + 60) % 60;
  const isHexel = Math.min(offset, 60 - offset) < 1e-9; // R = U up to the hexagon's symmetry
  return { a, b, psi, tu, tv, unit, world, areas, scales, isHexel };
}

const toE = ([u, v]) => [PANEL.x + PANEL.scale * u, flip(PANEL.y + PANEL.scale * v)];
const toDisk = ([u, v]) => [DISK.x + DISK.radius * u, flip(DISK.y + DISK.radius * v)];
const fromE = ([x, y]) => [(x - PANEL.x) / PANEL.scale, (flip(y) - PANEL.y) / PANEL.scale];

/** The ratio printed over a bar: two decimals without trailing zeros ("1", "1.54", "2"). */
function ratioText(ratio) {
  return ratio.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

// The room E has around its center in data units (HEX_PANEL_BOX).
const ROOM = {
  x: Math.min(PANEL.x - PANEL_BOX.left, PANEL_BOX.right - PANEL.x) / PANEL.scale,
  y: Math.min(PANEL.y - PANEL_BOX.bottom, PANEL_BOX.top - PANEL.y) / PANEL.scale,
};

/** The largest semi-axis (the first of its pair, with the other one fixed) that keeps E inside its box. */
function largestFitting(other, psi, along) {
  const [c, s] = [Math.cos(psi), Math.sin(psi)];
  // Semi-axis q along the angle psi (along = "u") or psi + 90 degrees ("v"), the other semi-axis fixed.
  const [cx, cy] = along === "u" ? [c, s] : [s, c];
  const [ox, oy] = along === "u" ? [s, c] : [c, s];
  const limit = (room, k, o) => (Math.abs(k) < 1e-9 ? Infinity : Math.sqrt(Math.max(room ** 2 - (other * o) ** 2, 0)) / Math.abs(k));
  return Math.min(limit(ROOM.x, cx, ox), limit(ROOM.y, cy, oy));
}

const wrapDegrees = (angle) => ((((angle + 180) % 360) + 360) % 360) - 180;
const wrapTurn = (angle) => ((angle % 360) + 360) % 360;
const formatDegrees = (angle) => `${signed(Math.round(angle), 0)}°`;

export function mount(container, { stage, controls }) {
  const state = { ...REST };
  const select = cssVar("--hx-select") || "#5d70ae";
  const ink = rgb(COLORS.ink);
  const guide = rgb(COLORS.guide);
  const svg = svgStage(stage);
  const center = toE([0, 0]);

  /* E, its axes (shown with the Hexel and while a knob is in use) and the polygons inside it. */
  const ellipse = svgEl("path", { fill: rgb(COLORS.tint), stroke: ink, "stroke-width": 1.8 * PT, "stroke-linejoin": "round" }, svg);
  const axisLines = [0, 1].map(() => svgEl("line", {
    stroke: guide,
    "stroke-width": 1.0 * PT,
    "stroke-dasharray": `${1 * PT} ${2.2 * PT}`,
    opacity: 0,
  }, svg));
  const ePolygons = polygonSet(svg, 28);
  svgEl("circle", { cx: center[0], cy: center[1], r: (Math.sqrt(36) / 2) * PT, fill: ink, stroke: "white", "stroke-width": 1.0 * PT }, svg);
  const arrows = ["u", "v"].map((key) => arrow(svg, COLORS.tangent[key]));
  // p sits below left of the center as in the script; with the Hexel's arrows it moves into the free quadrant.
  const pLabel = svgText(svg, { size: FONT.formula, anchor: "end", align: "top", halo: true });
  const pLabelHexel = svgText(svg, { size: FONT.formula, anchor: "middle", align: "middle", halo: true });
  pLabel.set("$\\mathbf{p}$", center[0] - 8, center[1] + 6);
  const eLabel = svgText(svg, { size: FONT.formula, anchor: "middle", align: "middle" });
  const arrowLabels = ["u", "v"].map((key) => svgText(svg, { size: FONT.label, anchor: "middle", align: "middle", fill: COLORS.tangent[key], halo: true }));
  const headline = svgText(svg, { size: FONT.label, anchor: "middle", align: "middle" });
  const headNote = svgText(svg, { size: FONT.small, anchor: "middle", align: "middle", fill: COLORS.note });
  svgText(svg, { size: FONT.label, anchor: "middle", align: "middle" }).set("color error $\\leq\\varepsilon$ inside $E$", PANEL.x, flip(28));

  /* The un-stretched unit disk with R H_m. */
  svgEl("circle", { cx: DISK.x, cy: flip(DISK.y), r: DISK.radius, fill: rgb(COLORS.tint), stroke: ink, "stroke-width": 1.5 * PT }, svg);
  const diskPolygons = polygonSet(svg, 20);
  svgEl("circle", { cx: DISK.x, cy: flip(DISK.y), r: (Math.sqrt(20) / 2) * PT, fill: ink, stroke: ink, "stroke-width": 1.5 * PT }, svg);
  svgText(svg, { size: FONT.label, anchor: "middle", align: "middle" }).set("un-stretched", DISK.x, flip(TITLE_Y));
  svgText(svg, { size: FONT.small, anchor: "middle", align: "middle", fill: COLORS.note }).set("unit disk", DISK.x, flip(88));

  /* draw_area_bars(): A_m / A_3 from the drawn polygons, their values and shape icons. */
  svgEl("line", { x1: BAR_X[3] - 24, x2: BAR_X[6] + 24, y1: flip(BAR.base), y2: flip(BAR.base), stroke: guide, "stroke-width": 1.0 * PT }, svg);
  const bars = Object.fromEntries(SHAPES.map((m) => {
    const color = COLORS.shape[m];
    const rect = svgEl("rect", { x: BAR_X[m] - BAR.width / 2, width: BAR.width, fill: rgb(mix("#ffffff", color, 0.5)), stroke: rgb(color), "stroke-width": 1.3 * PT }, svg);
    const value = svgText(svg, { size: FONT.label, anchor: "middle", align: "bottom" });
    const iconPoints = regularPolygon(m, ICON_ANGLES[m]).map(([u, v]) => [BAR_X[m] + 10.5 * u, flip(BAR.base - 22 + 10.5 * v)]);
    svgEl("path", { d: svgPath(iconPoints), fill: "white", stroke: rgb(color), "stroke-width": 1.6 * PT, "stroke-linejoin": "miter" }, svg);
    return [m, { rect, value }];
  }));
  svgText(svg, { size: FONT.label, anchor: "middle", align: "middle" }).set("relative area", BAR_X[4], flip(TITLE_Y));

  /* Knobs at the ends of E's axes, and the halo of a hovered or dragged hexagon corner, above everything. */
  const vertexHalo = svgEl("circle", { r: VERTEX_HALO, fill: select, opacity: 0 }, svg);
  const knobs = ["u", "v"].map(() => {
    const node = svgEl("g", { class: "hx-wh-knob" }, svg);
    return {
      node,
      halo: svgEl("circle", { r: KNOB.halo, fill: select, opacity: 0 }, node),
      grip: svgEl("circle", { r: KNOB.radius, fill: "white", stroke: ink, "stroke-width": 1.4 }, node),
    };
  });

  /* Controls: lambda_1, lambda_2 and the tilt shape E; the turn rotates the polygons. */
  const update = (key) => (value) => {
    state[key] = value;
    fit(key);
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
  const turnSlider = slider({
    label: "$R$",
    name: "Turn of the polygons in degrees",
    value: state.turn,
    min: 0,
    max: 360,
    step: 1,
    format: formatDegrees,
    accent: COLORS.shape[6],
    onInput: update("turn"),
  });
  const scaleValues = ["u", "v"].map(() => el("span", { className: "hx-fig-legend-value" }));
  controls.append(
    group({ legend: "Along $\\mathbf{t}_u$", swatch: COLORS.tangent.u, aside: scaleValues[0] }, [lambdaSliders[0].element]),
    group({ legend: "Along $\\mathbf{t}_v$", swatch: COLORS.tangent.v, aside: scaleValues[1] }, [lambdaSliders[1].element]),
    group({ legend: "Tilt of $E$" }, [tiltSlider.element]),
    group({ legend: "Turn of the polygons" }, [turnSlider.element]),
  );
  const summary = readout();
  controls.append(summary);
  controls.style.setProperty("--hx-fig-grid", "repeat(2, minmax(0, 1fr))");

  let current = frame(state);
  let hovered = null; // "u", "v" or a hexagon corner { where, k }
  let dragged = null;

  /** Keep E inside its box: shrink the semi-axis that just changed (or, for the tilt, whichever is too long). */
  function fit(changed) {
    const psi = (state.tilt * Math.PI) / 180;
    const along = { lambda1: ["u"], lambda2: ["v"], tilt: ["u", "v"] }[changed] ?? [];
    for (const axis of along) {
      const [key, otherKey] = axis === "u" ? ["lambda1", "lambda2"] : ["lambda2", "lambda1"];
      const largest = largestFitting(1 / Math.sqrt(state[otherKey]), psi, axis);
      if (1 / Math.sqrt(state[key]) > largest) state[key] = 1 / largest ** 2;
    }
    lambdaSliders[0].set(state.lambda1);
    lambdaSliders[1].set(state.lambda2);
  }

  function paintHighlights() {
    const active = dragged ?? hovered;
    knobs.forEach(({ halo, grip }, k) => {
      const on = active === ["u", "v"][k];
      halo.setAttribute("opacity", on ? (dragged ? 0.28 : 0.18) : 0);
      grip.setAttribute("stroke", on ? select : ink);
    });
    const corner = active && typeof active === "object" ? active : null;
    if (corner) {
      const [x, y] = cornerPoint(corner);
      vertexHalo.setAttribute("cx", x);
      vertexHalo.setAttribute("cy", y);
    }
    vertexHalo.setAttribute("opacity", corner ? (dragged ? 0.28 : 0.18) : 0);
    // E's axes show with the Hexel, and while its knobs are in use.
    const axesShown = current.isHexel || active === "u" || active === "v";
    axisLines.forEach((line) => line.setAttribute("opacity", axesShown ? 1 : 0));
  }

  function cornerPoint({ where, k }) {
    return where === "disk" ? toDisk(current.unit[6][k]) : toE(current.world[6][k]);
  }

  function render() {
    current = frame(state);
    const { a, b, tu, tv, world, unit, areas, scales, isHexel } = current;
    const focus = isHexel ? 1 : 0;

    // E and its axes.
    const boundary = Array.from({ length: 241 }, (_, k) => {
      const angle = (2 * Math.PI * k) / 240;
      const [x, y] = [a * Math.cos(angle), b * Math.sin(angle)];
      return toE([x * tu[0] + y * tv[0], x * tu[1] + y * tv[1]]);
    });
    ellipse.setAttribute("d", svgPath(boundary.slice(0, -1)));
    [[a, tu], [b, tv]].forEach(([length, direction], k) => {
      const [x1, y1] = toE([-length * direction[0], -length * direction[1]]);
      const [x2, y2] = toE([length * direction[0], length * direction[1]]);
      Object.entries({ x1, y1, x2, y2 }).forEach(([name, value]) => axisLines[k].setAttribute(name, value));
    });

    // The polygons; with the Hexel the triangle and square step back.
    ePolygons.update(Object.fromEntries(SHAPES.map((m) => [m, world[m].map(toE)])), focus);
    diskPolygons.update(Object.fromEntries(SHAPES.map((m) => [m, unit[m].map(toDisk)])), focus);

    // The Hexel's axes s_u t_u and s_v t_v, and the labels.
    const [su, sv] = scales;
    [[su, tu, [0.6 * su * tu[0] - 0.3 * tv[0], 0.6 * su * tu[1] - 0.3 * tv[1]]],
      [sv, tv, [0.55 * sv * tv[0] - 0.42 * tu[0], 0.55 * sv * tv[1] - 0.42 * tu[1]]]].forEach(([scale, direction, spot], k) => {
      arrows[k].set(center, toE([scale * direction[0], scale * direction[1]]), focus);
      const key = ["u", "v"][k];
      arrowLabels[k].set(`$s_${key}\\mathbf{t}_${key}$`, ...toE(spot));
      arrowLabels[k].node.setAttribute("opacity", focus);
    });
    const away = [-(tu[0] + tv[0]) / Math.SQRT2, -(tu[1] + tv[1]) / Math.SQRT2]; // between -t_u and -t_v
    pLabelHexel.set("$\\mathbf{p}$", center[0] + P_OFFSET * away[0], center[1] - P_OFFSET * away[1]);
    pLabel.node.setAttribute("display", isHexel ? "none" : "inline");
    pLabelHexel.node.setAttribute("display", isHexel ? "inline" : "none");
    placeELabel();
    const [title, note] = isHexel
      ? ["a Hexel reaches the largest area", "with its axes along the axes of $E$"]
      : ["largest polygons inside $E$", "any rotation gives the same area"];
    headline.set(title, HEADLINE_X, flip(377));
    headNote.set(note, HEADLINE_X, flip(342));

    // Area bars from the drawn polygons.
    for (const m of SHAPES) {
      const ratio = areas[m] / areas[3];
      const height = BAR.unit * ratio;
      bars[m].rect.setAttribute("y", flip(BAR.base + height));
      bars[m].rect.setAttribute("height", height);
      bars[m].value.set(ratioText(ratio), BAR_X[m], flip(BAR.base + height + 5));
    }

    // Knobs at +a t_u and +b t_v.
    [[a, tu], [b, tv]].forEach(([length, direction], k) => {
      const [x, y] = toE([length * direction[0], length * direction[1]]);
      for (const circle of [knobs[k].halo, knobs[k].grip]) {
        circle.setAttribute("cx", x);
        circle.setAttribute("cy", y);
      }
    });

    // Readouts.
    scaleValues[0].replaceChildren(htmlLabel(`$s_u=${su.toFixed(3)}$`));
    scaleValues[1].replaceChildren(htmlLabel(`$s_v=${sv.toFixed(3)}$`));
    const fixed = (value) => value.toFixed(3);
    summary.replaceChildren(
      el("span", { className: "hx-fig-readout-main" }, [
        icon("circle-check"),
        " ",
        htmlLabel(
          `Largest areas inside $E$: triangle ${fixed(areas[3])}, square ${fixed(areas[4])}, hexagon ${fixed(areas[6])}. ` +
            `Hexagon over square ${(areas[6] / areas[4]).toFixed(2)}, over triangle ${(areas[6] / areas[3]).toFixed(2)}, ` +
            "for every ellipse and every turn.",
        ),
      ]),
      el("span", { className: "hx-fig-readout-note" }, [
        htmlLabel(
          (isHexel ? "The hexagon is the Hexel: " : "Turned to 0 degrees, or any multiple of 60, the hexagon is the Hexel, and ") +
            `its scales $s_u=(3\\varepsilon/2\\lambda_1)^{1/2}=${su.toFixed(3)}$ and $s_v=(3\\varepsilon/2\\lambda_2)^{1/2}=${sv.toFixed(3)}$ ` +
            `put its six corners on $E$ ($\\varepsilon=${EPS}$).`,
        ),
      ]),
    );
    svg.setAttribute(
      "aria-label",
      `An error ellipse E with semi-axes ${a.toFixed(2)} and ${b.toFixed(2)}, tilted ${signed(Math.round(state.tilt), 0)} degrees, ` +
        `holds the largest triangle, square and hexagon, turned ${Math.round(state.turn)} degrees, with areas ` +
        `${fixed(areas[3])}, ${fixed(areas[4])} and ${fixed(areas[6])}: 1 to 1.54 to 2. ` +
        (isHexel ? `The hexagon is the Hexel with scales ${su.toFixed(3)} and ${sv.toFixed(3)}.` : ""),
    );
    paintHighlights();
  }

  /** The label E beyond the end of E's minor axis (-t_v, as the script places it), or beyond -t_u if that is crowded. */
  function placeELabel() {
    const { a, b, tu, tv } = current;
    const reach = 22 / PANEL.scale;
    const candidates = [[b, tv], [a, tu]].map(([length, direction]) => toE([-(length + reach) * direction[0], -(length + reach) * direction[1]]));
    // Clear of the headline above, the line "color error ..." below and the canvas edges.
    const clear = ([x, y]) => x > 16 && x < 344 && y > flip(320) && y < flip(52);
    const [x, y] = candidates.find(clear) ?? candidates[0];
    eLabel.set("$E$", x, y);
  }

  /** Triangle, square and hexagon with vertex markers, as draw_polygon_set(); focus fades all but the hexagon. */
  function polygonSet(parent, markerSize) {
    const fill = svgEl("path", { fill: rgb(COLORS.shape[6]), "fill-opacity": 0.13 }, parent);
    const outlines = {};
    const markers = {};
    for (const m of SHAPES) {
      const dash = SHAPE_STYLES[m];
      outlines[m] = svgEl("path", {
        fill: "none",
        stroke: rgb(COLORS.shape[m]),
        "stroke-width": 2.1 * PT,
        "stroke-linejoin": "round",
        "stroke-dasharray": dash ? dash.map((d) => d * 2.1 * PT).join(" ") : null,
      }, parent);
    }
    for (const m of SHAPES) {
      markers[m] = Array.from({ length: m }, () => svgEl("circle", {
        r: (Math.sqrt(markerSize) / 2) * PT,
        fill: "white",
        stroke: rgb(COLORS.shape[m]),
        "stroke-width": 1.2 * PT,
      }, parent));
    }
    return {
      update(points, focus) {
        fill.setAttribute("d", svgPath(points[6]));
        for (const m of SHAPES) {
          const weight = m === 6 ? 1 : 1 - 0.75 * focus;
          outlines[m].setAttribute("d", svgPath(points[m]));
          outlines[m].setAttribute("opacity", weight);
          markers[m].forEach((marker, k) => {
            marker.setAttribute("cx", points[m][k][0]);
            marker.setAttribute("cy", points[m][k][1]);
            marker.setAttribute("opacity", weight);
          });
        }
      },
    };
  }

  /** The script's arrow(): a line with a filled head (FancyArrowPatch "-|>", mutation 15) and a white halo. */
  function arrow(parent, color) {
    const node = svgEl("g", {}, parent);
    const halo = svgEl("path", { fill: "none", stroke: "white", "stroke-opacity": 0.9, "stroke-width": (2.0 + 3.2) * PT, "stroke-linecap": "round", "stroke-linejoin": "round" }, node);
    const line = svgEl("path", { fill: "none", stroke: rgb(color), "stroke-width": 2.0 * PT, "stroke-linecap": "round" }, node);
    const head = svgEl("path", { fill: rgb(color), stroke: rgb(color), "stroke-width": 2.0 * PT, "stroke-linejoin": "round" }, node);
    const length = 0.4 * 15 * PT;
    const width = 0.2 * 15 * PT;
    const pad = (0.5 * 2.0 * PT) / (width / Math.hypot(length, width)); // the head stops short by the stroke's overshoot
    return {
      set([x0, y0], [x1, y1], opacity) {
        node.setAttribute("opacity", opacity);
        const distance = Math.hypot(x1 - x0, y1 - y0) || 1;
        const [ux, uy] = [(x0 - x1) / distance, (y0 - y1) / distance]; // from the tip back to the start
        const tip = [x1 + pad * ux, y1 + pad * uy];
        const base = [tip[0] + length * ux, tip[1] + length * uy];
        const side = [-uy * width, ux * width];
        const wedge = [[base[0] + side[0], base[1] + side[1]], tip, [base[0] - side[0], base[1] - side[1]]];
        line.setAttribute("d", svgPath([[x0, y0], tip], false));
        head.setAttribute("d", svgPath(wedge));
        halo.setAttribute("d", `${svgPath([[x0, y0], tip], false)}${svgPath(wedge)}`);
      },
    };
  }

  /* Dragging: the knobs stretch and tilt E, a hexagon corner turns the polygons. */
  const drag = dragHandles(svg, {
    hit(point) {
      const near = ([x, y], radius, slop = point.slop) => Math.hypot(point.x - x, point.y - y) <= radius + slop;
      const { a, b, tu, tv } = current;
      const ends = [toE([a * tu[0], a * tu[1]]), toE([b * tv[0], b * tv[1]])];
      const knob = ["u", "v"].find((key, k) => near(ends[k], KNOB.radius));
      if (knob) {
        const [x, y] = ends[knob === "u" ? 0 : 1];
        return { kind: "axis", key: knob, offset: [x - point.x, y - point.y] };
      }
      const markerRadius = (Math.sqrt(28) / 2) * PT;
      const touch = point.pointerType === "touch";
      const slop = touch ? CORNER_TOUCH_SLOP * point.slop : point.slop;
      for (const where of touch ? ["e"] : ["e", "disk"]) {
        for (let k = 0; k < 6; k += 1) {
          if (near(cornerPoint({ where, k }), markerRadius, slop)) return { kind: "corner", where, k };
        }
      }
      return null;
    },
    start(handle, point) {
      if (handle.kind === "corner") {
        handle.angle = angleOf(handle.where, point);
        handle.turn = state.turn;
        dragged = { where: handle.where, k: handle.k };
      } else {
        dragged = handle.key;
      }
      paintHighlights();
    },
    move(handle, point) {
      if (handle.kind === "axis") {
        const [u, v] = fromE([point.x + handle.offset[0], point.y + handle.offset[1]]);
        const length = Math.hypot(u, v);
        if (length < 1e-6) return;
        const angle = (Math.atan2(v, u) * 180) / Math.PI - (handle.key === "v" ? 90 : 0);
        state.tilt = Math.round(wrapDegrees(angle));
        const [key, otherKey] = handle.key === "u" ? ["lambda1", "lambda2"] : ["lambda2", "lambda1"];
        const largest = largestFitting(1 / Math.sqrt(state[otherKey]), (state.tilt * Math.PI) / 180, handle.key);
        const semiAxis = clamp(length, 1 / Math.sqrt(LAMBDA_RANGE[1]), Math.min(1 / Math.sqrt(LAMBDA_RANGE[0]), largest));
        state[key] = clamp(Math.round(100 / semiAxis ** 2) / 100, ...LAMBDA_RANGE);
        if (1 / Math.sqrt(state[key]) > largest) state[key] = Math.ceil(100 / largest ** 2) / 100;
        fit("tilt");
        tiltSlider.set(state.tilt);
      } else {
        // Turn by the angle the pointer swept around the center of the un-stretched polygons.
        const angle = angleOf(handle.where, point);
        let swept = angle - handle.angle;
        swept -= 360 * Math.round(swept / 360);
        handle.angle = angle;
        handle.turn += swept;
        let turn = Math.round(wrapTurn(handle.turn));
        const offset = wrapDegrees(turn - 60 * Math.round(turn / 60));
        if (Math.abs(offset) <= HEXEL_SNAP) turn = wrapTurn(turn - offset);
        state.turn = turn % 360;
        turnSlider.set(state.turn);
      }
      render();
    },
    end() {
      dragged = null;
      paintHighlights();
    },
    hover(handle) {
      hovered = handle ? (handle.kind === "axis" ? handle.key : { where: handle.where, k: handle.k }) : null;
      paintHighlights();
    },
  });

  /** The angle in degrees of a pointer around the center, in the un-stretched frame (E is mapped back to the disk). */
  function angleOf(where, point) {
    if (where === "disk") return (Math.atan2(flip(point.y) - DISK.y, point.x - DISK.x) * 180) / Math.PI;
    const { a, b, tu, tv } = current;
    const [u, v] = fromE([point.x, point.y]);
    const along = [(u * tu[0] + v * tu[1]) / a, (u * tv[0] + v * tv[1]) / b];
    return (Math.atan2(along[1], along[0]) * 180) / Math.PI;
  }

  render();
  return {
    reset() {
      Object.assign(state, REST);
      lambdaSliders[0].set(state.lambda1);
      lambdaSliders[1].set(state.lambda2);
      tiltSlider.set(state.tilt);
      turnSlider.set(state.turn);
      render();
    },
    destroy() {
      drag.destroy();
    },
  };
}
