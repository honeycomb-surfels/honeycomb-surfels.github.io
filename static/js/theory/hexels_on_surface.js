/**
 * Interactive "Flat Hexels on a curved surface" (theory.html, hexels_on_surface): a gently curved sheet with a smooth
 * texture f, and 23 flat Hexels on its tangent planes, each colored by the first-order Taylor field of f at its
 * center p: c_0 = f(p), g_u = s_u d_1 f(p) and g_v = s_v d_2 f(p). A small software renderer projects the scene
 * orthographically onto a canvas: the sheet as an image (each pixel mapped back onto the sheet) under its dashed grid,
 * then the Hexels far to near. Dragging the figure turns the view (a sideways swipe on touch screens, so that an up or
 * down swipe still scrolls the page); the sliders set the Hexel size and the view, and a check box hides the sheet. The
 * readout gives the largest gap between a Hexel's corner color and the texture there, per channel, over all corners,
 * which grows about with the square of the size.
 *
 * The math, constants, colors and layout are those of surface_height(), surface_slopes(), surface_shade(), texture(),
 * texture_jacobian(), surface_hexels(), surface_camera(), surface_view_limits(), sheet_image() and
 * draw_hexels_on_surface() in tools/make_theory_animations.py. The default state is the poster frame (loop phase
 * 0.60): azimuth -62 degrees, elevation 38 degrees, every Hexel at its full size, and a largest corner error of 0.023.
 * A Hexel k times its default size keeps the Taylor field of that size (its scales and color slopes times k). Views
 * that need more room than the animation's fixed window zoom out just enough to keep the whole sheet in the frame.
 */
import {
  COLORS,
  FONT,
  HEX_VERTICES,
  PT,
  arrow,
  canvasStage,
  canvasText,
  clamp,
  dragHandles,
  ease,
  el,
  group,
  icon,
  polygonPath,
  readout,
  rgb,
  signed,
  slider,
  snap,
} from "./core.js";

export const hint = "Drag the figure to turn the view, or use the sliders.";
const TOUCH_HINT = "Swipe sideways on the figure to turn the view, or use the sliders.";

const SQRT3 = Math.sqrt(3);

// tools/make_theory_animations.py, section 3 (hexels_on_surface).
const SURF_X = [-3, 3];
const SURF_Y = [-2, 2];
const SURF_SCALE = 0.44; // lattice inradius in parameter units
const SURF_PATCH = [2.75, 1.78]; // semi-axes of the elliptical region that receives Hexels
const SURF_OPACITY = 0.9;
const SURF_ELEVATION = 38;
const SURF_AZIMUTH = [-62, 16]; // resting azimuth and the extra turn of the camera peek, degrees
const SURF_PEEK = [0.61, 0.83];
const SURF_TEX_BASE = [0.6, 0.7, 0.76];
const SURF_TEX_MIX = [[0.22, 0.06, 0.1], [-0.04, 0.14, 0.02], [-0.18, 0.02, 0.06]];
const SURF_SHEET_TINT = 0.75;
const SURF_LIGHT = normalize([-0.6, -0.65, 0.47]);
const SURF_AMBIENT = 0.74;
const SURF_DIFFUSE = 0.4;
const GRID = { lines: [7, 5], samples: 80, width: 1.05, dash: [4.0, 2.6] };
const OUTLINE_WIDTH = 1.25;
const HERO = { length: 1.55 * SURF_SCALE, lw: 1.9, head: 14, dot: Math.sqrt(40) / 2, label: 0.2, p: [-0.13, 0.1] };
const ARROW_HALO = 3.2;
// The label p keeps the animation's place unless an arrow comes within P_CLEARANCE of its direction; it then sits
// P_DISTANCE (screen units) from p, away from both arrows.
const P_CLEARANCE = Math.PI / 3;
const P_DISTANCE = 0.3;
const WIDTH = 720;
const HEIGHT = 405;

// The widget: the poster's view and size, the ranges of the controls, the renderer's resolution.
const REST = { size: 1, azimuth: SURF_AZIMUTH[0], elevation: SURF_ELEVATION, sheet: true };
const SIZE_RANGE = [0.5, 2];
const ELEVATION_RANGE = [30, 90]; // the sheet never folds on screen above 24.8 degrees (its slopes stay below 0.463)
const ORBIT = { azimuth: 180 / WIDTH, elevation: 90 / HEIGHT }; // degrees per layout unit of drag
// Samples of a screen column when the sheet image is mapped back onto the sheet: one every SAMPLE_STEP parameter units.
const SAMPLE_STEP = 0.05;
const MAX_SAMPLES = 200;
const FIELD = 32; // samples across each Hexel's color field
const TABLE = { step: 0.02, margin: 0.05 }; // the sheet's colors, tabulated on the parameter plane

function normalize(vector) {
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
}

const radians = (degrees) => (degrees * Math.PI) / 180;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** surface_height(): the gently curved height field z = h(x, y). */
function height(x, y) {
  return 0.5 * Math.sin(0.6 * x + 0.25) - 0.25 * Math.cos(0.8 * y) + 0.06 * x * y;
}

/** surface_slopes(): (h_x, h_y). */
function slopes(x, y) {
  return [0.3 * Math.cos(0.6 * x + 0.25) + 0.06 * y, 0.2 * Math.sin(0.8 * y) + 0.06 * x];
}

/** surface_shade(): Lambert display shading of a unit normal under the fixed world light. */
function shade(normal) {
  return Math.min(1, SURF_AMBIENT + SURF_DIFFUSE * clamp(dot(normal, SURF_LIGHT), 0, 1));
}

/** texture(): the smooth target color painted on the sheet, a function of x and y. */
function texture(x, y) {
  const basis = [Math.sin(0.8 * x + 0.3), Math.cos(1.0 * y - 0.4), Math.sin(0.6 * x - 0.7 * y + 1.1)];
  return SURF_TEX_BASE.map((base, i) => base + dot(SURF_TEX_MIX[i], basis));
}

/** texture_jacobian(): d texture / d(x, y), rows per channel. */
function textureJacobian(x, y) {
  const c = Math.cos(0.6 * x - 0.7 * y + 1.1);
  const basis = [[0.8 * Math.cos(0.8 * x + 0.3), 0], [0, -Math.sin(1.0 * y - 0.4)], [0.6 * c, -0.7 * c]];
  return SURF_TEX_MIX.map((row) => [0, 1].map((j) => row[0] * basis[0][j] + row[1] * basis[1][j] + row[2] * basis[2][j]));
}

/** surface_hexels(): Hexels on a flat-top hexagonal lattice in (x, y), in the script's spiral order from the middle. */
function buildHexels() {
  const s = SURF_SCALE;
  const centers = [];
  for (let i = -8; i <= 8; i += 1) {
    for (let j = -8; j <= 8; j += 1) {
      const x = i * SQRT3 * s;
      const y = 2 * s * j + (((i % 2) + 2) % 2) * s;
      if ((x / SURF_PATCH[0]) ** 2 + (y / SURF_PATCH[1]) ** 2 <= 1) centers.push([x, y]);
    }
  }
  const key = ([x, y]) => [Math.round(Math.hypot(x, y) * 1e6) / 1e6, (Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI)];
  centers.sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1]);
  return centers.map(([x, y]) => {
    const [hx, hy] = slopes(x, y);
    const dx = [1, 0, hx];
    const dy = [0, 1, hy];
    const normal = normalize(cross(dx, dy));
    const tu = normalize(dx);
    const tv = cross(normal, tu);
    const su = s * Math.hypot(...dx); // u projects onto x with step s
    const sv = s / tv[1]; // v projects onto y with step s
    const jac = textureJacobian(x, y);
    const gu = jac.map(([a, b]) => su * (a * tu[0] + b * tu[1]));
    const gv = jac.map(([a, b]) => sv * (a * tv[0] + b * tv[1]));
    return { center: [x, y, height(x, y)], tu, tv, su, sv, c0: texture(x, y), gu, gv, shade: shade(cross(tu, tv)) };
  });
}

const HEXELS = buildHexels();

/** Largest per-channel gap between the Hexels' corner colors and the texture, at k times the default size. */
function cornerError(k) {
  let worst = 0;
  for (const hexel of HEXELS) {
    for (const [u, v] of HEX_VERTICES) {
      const x = hexel.center[0] + k * (u * hexel.su * hexel.tu[0] + v * hexel.sv * hexel.tv[0]);
      const y = hexel.center[1] + k * (u * hexel.su * hexel.tu[1] + v * hexel.sv * hexel.tv[1]);
      const target = texture(x, y);
      for (let i = 0; i < 3; i += 1) {
        worst = Math.max(worst, Math.abs(hexel.c0[i] + k * (u * hexel.gu[i] + v * hexel.gv[i]) - target[i]));
      }
    }
  }
  return worst;
}

/** surface_camera() at an azimuth and elevation in degrees: screen right, screen up and the direction to the viewer. */
function camera(azimuth, elevation) {
  const a = radians(azimuth);
  const e = radians(elevation);
  const toward = [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)];
  const right = [-Math.sin(a), Math.cos(a), 0];
  return { right, up: cross(toward, right), toward, sa: Math.sin(a), ca: Math.cos(a), se: Math.sin(e), ce: Math.cos(e) };
}

/** surface_boundary(): the closed boundary of the rectangular sheet, lifted onto the surface. */
function boundary(samples = 60) {
  const points = [];
  const xs = Array.from({ length: samples }, (_, i) => SURF_X[0] + ((SURF_X[1] - SURF_X[0]) * i) / (samples - 1));
  const ys = Array.from({ length: samples }, (_, i) => SURF_Y[0] + ((SURF_Y[1] - SURF_Y[0]) * i) / (samples - 1));
  xs.forEach((x) => points.push([x, SURF_Y[0]]));
  ys.forEach((y) => points.push([SURF_X[1], y]));
  [...xs].reverse().forEach((x) => points.push([x, SURF_Y[1]]));
  [...ys].reverse().forEach((y) => points.push([SURF_X[0], y]));
  return points.map(([x, y]) => [x, y, height(x, y)]);
}

const BOUNDARY = boundary();

/** surface_view_limits(): the animation's fixed screen window, which covers the sheet for every camera of its loop. */
const VIEW = (() => {
  let low = [Infinity, Infinity];
  let high = [-Infinity, -Infinity];
  for (let k = 0; k <= 96; k += 1) {
    const t = k / 96;
    const peek = ease((t - SURF_PEEK[0]) / (SURF_PEEK[1] - SURF_PEEK[0]));
    const view = camera(SURF_AZIMUTH[0] + SURF_AZIMUTH[1] * Math.sin(Math.PI * peek), SURF_ELEVATION);
    for (const point of BOUNDARY) {
      const s = [dot(point, view.right), dot(point, view.up)];
      low = low.map((value, i) => Math.min(value, s[i]));
      high = high.map((value, i) => Math.max(value, s[i]));
    }
  }
  const center = [(low[0] + high[0]) / 2, (low[1] + high[1]) / 2];
  let half = [((high[0] - low[0]) / 2) * 1.04, ((high[1] - low[1]) / 2) * 1.04];
  const aspect = WIDTH / HEIGHT;
  half = [Math.max(half[0], half[1] * aspect), Math.max(half[1], half[0] / aspect)];
  return { center, half };
})();

/** The screen window for a camera: the animation's, zoomed out around its center when the sheet needs more room. */
function windowFor(view) {
  let zoom = 1;
  for (const point of BOUNDARY) {
    const s = [dot(point, view.right) - VIEW.center[0], dot(point, view.up) - VIEW.center[1]];
    zoom = Math.max(zoom, (1.04 * Math.abs(s[0])) / VIEW.half[0], (1.04 * Math.abs(s[1])) / VIEW.half[1]);
  }
  const half = VIEW.half.map((value) => value * zoom);
  return {
    zoom,
    x0: VIEW.center[0] - half[0],
    y1: VIEW.center[1] + half[1],
    scale: WIDTH / (2 * half[0]), // layout units per screen unit
  };
}

/**
 * The sheet's display colors on a grid over the parameter plane, from sheet_image(): the texture mixed into white,
 * times the shading of the surface normal. They do not depend on the camera, so they are computed once.
 */
const COLOR_TABLE = (() => {
  const x0 = SURF_X[0] - TABLE.margin;
  const y0 = SURF_Y[0] - TABLE.margin;
  const nx = Math.round((SURF_X[1] - SURF_X[0] + 2 * TABLE.margin) / TABLE.step) + 1;
  const ny = Math.round((SURF_Y[1] - SURF_Y[0] + 2 * TABLE.margin) / TABLE.step) + 1;
  const values = new Float32Array(3 * nx * ny);
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const x = x0 + i * TABLE.step;
      const y = y0 + j * TABLE.step;
      const [hx, hy] = slopes(x, y);
      const light = shade(normalize([-hx, -hy, 1]));
      const color = texture(x, y);
      for (let c = 0; c < 3; c += 1) values[3 * (j * nx + i) + c] = (1 - SURF_SHEET_TINT * (1 - clamp(color[c], 0, 1))) * light;
    }
  }
  return { x0, y0, nx, ny, values };
})();

export function mount(container, { stage, controls, setHint }) {
  const state = { ...REST };
  const ink = rgb(COLORS.ink);
  const sheet = document.createElement("canvas");
  const sheetContext = sheet.getContext("2d");
  let sheetImage = null;
  let sheetKey = "";
  let moving = false; // a drag on the figure is turning the view: the sheet is sampled at half resolution meanwhile
  const patch = document.createElement("canvas");
  patch.width = FIELD;
  patch.height = FIELD;
  const patchContext = patch.getContext("2d");
  const patchImage = patchContext.createImageData(FIELD, FIELD);
  const columns = { q: new Float64Array(MAX_SAMPLES + 1), g: new Float64Array(MAX_SAMPLES + 1) };

  const view = canvasStage(stage, draw);

  /**
   * sheet_image(): every layout pixel mapped back onto the sheet. A screen column is one line of the parameter plane
   * (screen x does not depend on the height), along which screen y falls monotonically because the sheet never folds,
   * so it is sampled once and inverted by interpolation. The alpha ramps over about one sample at the sheet's border.
   * One sample per layout unit, as the animation's SURF_IMAGE; every second one while a drag turns the view.
   */
  function paintSheet(cam, frame, detail) {
    const key = `${state.azimuth}:${state.elevation}:${detail}`;
    if (key === sheetKey) return;
    const [columnsCount, rowsCount] = [Math.ceil(WIDTH / detail), Math.ceil(HEIGHT / detail)];
    if (sheet.width !== columnsCount || sheet.height !== rowsCount || !sheetImage) {
      sheet.width = columnsCount;
      sheet.height = rowsCount;
      sheetImage = sheetContext.createImageData(columnsCount, rowsCount);
    }
    const data = sheetImage.data;
    data.fill(0);
    const { sa, ca, se, ce } = cam;
    const { x0, y1 } = frame;
    const scale = frame.scale / detail; // samples per screen unit
    const lines = [[ca, SURF_X[0] - TABLE.margin, SURF_X[1] + TABLE.margin], [sa, SURF_Y[0] - TABLE.margin, SURF_Y[1] + TABLE.margin]];
    const { values, nx, ny } = COLOR_TABLE;
    const [tableX, tableY, inverse, row] = [COLOR_TABLE.x0, COLOR_TABLE.y0, 1 / TABLE.step, 3 * nx];
    const { q, g } = columns;
    for (let i = 0; i < columnsCount; i += 1) {
      const sx = x0 + (i + 0.5) / scale;
      // The parameter line of this column: (x, y) = sx (-sin a, cos a) + q (cos a, sin a), inside the (widened) sheet.
      const offsets = [-sx * sa, sx * ca];
      let low = -Infinity;
      let high = Infinity;
      for (let axis = 0; axis < 2; axis += 1) {
        const [slope, a, b] = lines[axis];
        if (Math.abs(slope) < 1e-12) {
          if (offsets[axis] < a || offsets[axis] > b) low = Infinity;
          continue;
        }
        const qa = (a - offsets[axis]) / slope;
        const qb = (b - offsets[axis]) / slope;
        low = Math.max(low, Math.min(qa, qb));
        high = Math.min(high, Math.max(qa, qb));
      }
      if (!(low < high)) continue;
      const count = Math.min(MAX_SAMPLES, Math.ceil((high - low) / SAMPLE_STEP) + 1);
      for (let k = 0; k <= count; k += 1) {
        q[k] = low + ((high - low) * k) / count;
        g[k] = -se * q[k] + ce * height(offsets[0] + q[k] * ca, offsets[1] + q[k] * sa);
      }
      const top = Math.max(0, Math.ceil((y1 - g[0]) * scale - 0.5));
      const bottom = Math.min(rowsCount - 1, Math.floor((y1 - g[count]) * scale - 0.5));
      let k = 0;
      for (let j = top; j <= bottom; j += 1) {
        const sy = y1 - (j + 0.5) / scale;
        while (k < count - 1 && g[k + 1] > sy) k += 1;
        const at = q[k] + ((g[k] - sy) / (g[k] - g[k + 1])) * (q[k + 1] - q[k]);
        const x = offsets[0] + at * ca;
        const y = offsets[1] + at * sa;
        const margin = Math.min(x - SURF_X[0], SURF_X[1] - x, y - SURF_Y[0], SURF_Y[1] - y);
        const alpha = 0.5 + margin * scale;
        if (alpha <= 0) continue;
        // Bilinear lookup in the color table.
        const fx = Math.min(Math.max((x - tableX) * inverse, 0), nx - 1.001);
        const fy = Math.min(Math.max((y - tableY) * inverse, 0), ny - 1.001);
        const ix = fx | 0;
        const iy = fy | 0;
        const wx = fx - ix;
        const wy = fy - iy;
        const b00 = 3 * (iy * nx + ix);
        const b10 = b00 + row;
        const w00 = (1 - wx) * (1 - wy);
        const w01 = wx * (1 - wy);
        const w10 = (1 - wx) * wy;
        const w11 = wx * wy;
        const index = 4 * (j * columnsCount + i);
        data[index] = 255 * (w00 * values[b00] + w01 * values[b00 + 3] + w10 * values[b10] + w11 * values[b10 + 3]);
        data[index + 1] = 255 * (w00 * values[b00 + 1] + w01 * values[b00 + 4] + w10 * values[b10 + 1] + w11 * values[b10 + 4]);
        data[index + 2] = 255 * (w00 * values[b00 + 2] + w01 * values[b00 + 5] + w10 * values[b10 + 2] + w11 * values[b10 + 5]);
        data[index + 3] = 255 * Math.min(alpha, 1);
      }
    }
    sheetContext.putImageData(sheetImage, 0, 0);
    sheetKey = key;
  }

  function draw(ctx) {
    const cam = camera(state.azimuth, state.elevation);
    const frame = windowFor(cam);
    const project = (point) => [(dot(point, cam.right) - frame.x0) * frame.scale, (frame.y1 - dot(point, cam.up)) * frame.scale];

    /* The sheet and its dashed grid. */
    if (state.sheet) {
      const detail = moving ? 2 : 1;
      paintSheet(cam, frame, detail);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(sheet, 0, 0, sheet.width * detail, sheet.height * detail);
      ctx.save();
      ctx.strokeStyle = rgb(COLORS.surfaceGrid);
      ctx.lineWidth = GRID.width * PT;
      ctx.lineJoin = "round";
      ctx.setLineDash(GRID.dash.map((dash) => dash * GRID.width * PT));
      const lines = [];
      for (let i = 0; i < GRID.lines[0]; i += 1) {
        const x = SURF_X[0] + ((SURF_X[1] - SURF_X[0]) * i) / (GRID.lines[0] - 1);
        lines.push((t) => [x, SURF_Y[0] + t * (SURF_Y[1] - SURF_Y[0])]);
      }
      for (let i = 0; i < GRID.lines[1]; i += 1) {
        const y = SURF_Y[0] + ((SURF_Y[1] - SURF_Y[0]) * i) / (GRID.lines[1] - 1);
        lines.push((t) => [SURF_X[0] + t * (SURF_X[1] - SURF_X[0]), y]);
      }
      for (const along of lines) {
        ctx.beginPath();
        for (let k = 0; k < GRID.samples; k += 1) {
          const [x, y] = along(k / (GRID.samples - 1));
          const [px, py] = project([x, y, height(x, y)]);
          if (k) ctx.lineTo(px, py);
          else ctx.moveTo(px, py);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    /* The Hexels, far to near: each one's color field (clipped to its outline, at opacity 0.9), then its outline. */
    const k = state.size;
    const order = HEXELS.map((hexel, index) => [dot(hexel.center, cam.toward), index]).sort((a, b) => a[0] - b[0]);
    const data = patchImage.data;
    for (const [, index] of order) {
      const hexel = HEXELS[index];
      const axisU = hexel.tu.map((value) => k * hexel.su * value);
      const axisV = hexel.tv.map((value) => k * hexel.sv * value);
      const corners = HEX_VERTICES.map(([u, v]) => project(hexel.center.map((value, i) => value + u * axisU[i] + v * axisV[i])));
      const [cx, cy] = project(hexel.center);
      // Layout point = center + M (u, v), so (u, v) = M^-1 (point - center).
      const m = [dot(axisU, cam.right) * frame.scale, dot(axisV, cam.right) * frame.scale, -dot(axisU, cam.up) * frame.scale, -dot(axisV, cam.up) * frame.scale];
      const det = m[0] * m[3] - m[1] * m[2];
      if (Math.abs(det) < 1e-9) continue; // seen edge-on
      const xs = corners.map(([x]) => x);
      const ys = corners.map(([, y]) => y);
      const [left, top] = [Math.min(...xs), Math.min(...ys)];
      const [width, height_] = [Math.max(...xs) - left, Math.max(...ys) - top];
      let n = 0;
      for (let j = 0; j < FIELD; j += 1) {
        const dy = top + ((j + 0.5) * height_) / FIELD - cy;
        for (let i = 0; i < FIELD; i += 1) {
          const dx = left + ((i + 0.5) * width) / FIELD - cx;
          const u = (m[3] * dx - m[1] * dy) / det;
          const v = (-m[2] * dx + m[0] * dy) / det;
          for (let c = 0; c < 3; c += 1) data[n + c] = 255 * clamp(hexel.c0[c] + k * (u * hexel.gu[c] + v * hexel.gv[c]), 0, 1) * hexel.shade;
          data[n + 3] = 255;
          n += 4;
        }
      }
      patchContext.putImageData(patchImage, 0, 0);
      ctx.save();
      polygonPath(ctx, corners);
      ctx.clip();
      ctx.globalAlpha = SURF_OPACITY;
      ctx.drawImage(patch, left, top, width, height_);
      ctx.restore();
      polygonPath(ctx, corners);
      ctx.strokeStyle = ink;
      ctx.lineWidth = OUTLINE_WIDTH * PT;
      ctx.lineJoin = "round";
      ctx.stroke();
    }

    /* The first Hexel's tangents t_u and t_v and its center p. */
    const hero = HEXELS[0];
    const center = project(hero.center);
    const tips = [hero.tu, hero.tv].map((direction) => project(hero.center.map((value, i) => value + HERO.length * direction[i])));
    for (const key of ["u", "v"]) {
      const tip = tips[key === "u" ? 0 : 1];
      arrow(ctx, center, tip, rgb(COLORS.tangent[key]), { lw: HERO.lw, head: HERO.head, halo: ARROW_HALO });
      const offset = [tip[0] - center[0], tip[1] - center[1]];
      const length = Math.hypot(...offset) || 1;
      const reach = HERO.label * frame.scale;
      canvasText(ctx, `$\\mathbf{t}_${key}$`, tip[0] + (reach * offset[0]) / length, tip[1] + (reach * offset[1]) / length, {
        size: FONT.formula,
        anchor: "middle",
        align: "middle",
        color: COLORS.tangent[key],
        halo: true,
      });
    }
    ctx.beginPath();
    ctx.arc(center[0], center[1], HERO.dot * PT, 0, 2 * Math.PI);
    ctx.fillStyle = ink;
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.0 * PT;
    ctx.stroke();
    // p sits where the animation puts it (up and to the left) while both arrows keep clear of that side; in views
    // where an arrow points there, it moves to the direction farthest from both arrows.
    const arrows = tips.map(([x, y]) => Math.atan2(center[1] - y, x - center[0]));
    const clearance = (angle) => Math.min(...arrows.map((arrow) => Math.abs(((angle - arrow + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)));
    if (clearance(Math.atan2(HERO.p[1], HERO.p[0])) >= P_CLEARANCE) {
      canvasText(ctx, "$\\mathbf{p}$", center[0] + HERO.p[0] * frame.scale, center[1] - HERO.p[1] * frame.scale, { size: FONT.formula, anchor: "end", align: "bottom", halo: true });
    } else {
      const angles = Array.from({ length: 72 }, (_, step) => (step * Math.PI) / 36);
      const best = angles.reduce((a, b) => (clearance(b) > clearance(a) ? b : a));
      const reach = P_DISTANCE * frame.scale;
      canvasText(ctx, "$\\mathbf{p}$", center[0] + reach * Math.cos(best), center[1] - reach * Math.sin(best), { size: FONT.formula, anchor: "middle", align: "middle", halo: true });
    }
  }

  /* Controls: the Hexel size with the sheet's check box, and the view. */
  const sizeSlider = slider({
    label: "",
    name: "Hexel size, times the default size",
    value: state.size,
    min: SIZE_RANGE[0],
    max: SIZE_RANGE[1],
    format: (value) => `${value.toFixed(2)}×`,
    onInput: (value) => change({ size: value }),
  });
  const azimuthSlider = slider({
    label: "",
    name: "Turn of the view around the vertical axis, in degrees",
    value: state.azimuth,
    min: -180,
    max: 180,
    step: 1,
    format: (value) => `${signed(value, 0)}°`,
    accent: COLORS.ink,
    onInput: (value) => change({ azimuth: value }),
  });
  const elevationSlider = slider({
    label: "",
    name: "Elevation of the view above the sheet, in degrees",
    value: state.elevation,
    min: ELEVATION_RANGE[0],
    max: ELEVATION_RANGE[1],
    step: 1,
    format: (value) => `${signed(value, 0)}°`,
    accent: COLORS.ink,
    onInput: (value) => change({ elevation: value }),
  });
  // Glyphs instead of letters: the size, a turn around the vertical axis and a tilt.
  [[sizeSlider, "up-right-and-down-left-from-center"], [azimuthSlider, "arrows-left-right"], [elevationSlider, "arrows-up-down"]].forEach(([control, glyph]) => {
    control.element.querySelector("label").replaceChildren(icon(glyph));
  });
  const sheetBox = el("input", { attrs: { type: "checkbox", id: `${sizeSlider.input.id}-sheet` } });
  sheetBox.checked = state.sheet;
  sheetBox.style.accentColor = "var(--hx-select)";
  sheetBox.style.margin = "0";
  sheetBox.addEventListener("change", () => change({ sheet: sheetBox.checked }));
  const sheetLabel = el("label", { attrs: { for: sheetBox.id } }, [sheetBox, el("span", { text: "Show the curved sheet" })]);
  Object.assign(sheetLabel.style, { display: "flex", alignItems: "center", gap: "0.5rem", minHeight: "2rem", fontSize: "0.85rem", cursor: "pointer" });
  if (window.matchMedia("(pointer: coarse)").matches) sheetLabel.style.minHeight = "40px";
  const summary = readout();
  controls.append(
    group({ legend: "Hexel size" }, [sizeSlider.element, sheetLabel]),
    group({ legend: "View: turn and tilt" }, [azimuthSlider.element, elevationSlider.element]),
    summary,
  );
  controls.style.setProperty("--hx-fig-grid", "repeat(2, minmax(0, 1fr))");
  if (window.matchMedia("(hover: none)").matches) setHint(TOUCH_HINT);

  function change(values) {
    Object.assign(state, values);
    update();
  }

  function update() {
    const error = cornerError(state.size);
    summary.replaceChildren(
      el("span", { className: "hx-fig-readout-main" }, [
        icon("circle-check"),
        ` Every corner color is within ${error.toFixed(3)} of the texture (largest gap per channel, on a 0 to 1 scale).`,
      ]),
      el("span", { className: "hx-fig-readout-note" }, [
        `${HEXELS.length} Hexels at ${state.size.toFixed(2)}× their default size; the gap grows about with the square of the size.`,
      ]),
    );
    view.canvas.setAttribute(
      "aria-label",
      `A curved sheet${state.sheet ? "" : " (hidden)"} with ${HEXELS.length} flat Hexels on its tangent planes at ` +
        `${state.size.toFixed(2)} times their default size, seen from azimuth ${signed(state.azimuth, 0)} and elevation ` +
        `${signed(state.elevation, 0)} degrees; every corner color is within ${error.toFixed(3)} of the texture.`,
    );
    view.redraw();
  }

  /** Turn the view by a drag of (dx, dy) layout units from a starting view, snapped to whole degrees. */
  function orbit(from, dx, dy) {
    const azimuth = snap(from.azimuth - dx * ORBIT.azimuth, 1);
    state.azimuth = ((((azimuth + 180) % 360) + 360) % 360) - 180; // in [-180, 180)
    if (state.azimuth === -180) state.azimuth = 180;
    state.elevation = snap(clamp(from.elevation + dy * ORBIT.elevation, ...ELEVATION_RANGE), 1);
    azimuthSlider.set(state.azimuth);
    elevationSlider.set(state.elevation);
    update();
  }

  // A mouse or pen drags the view from anywhere on the figure.
  const drag = dragHandles(view.canvas, {
    hit: (point) => (point.pointerType === "touch" ? null : { from: null }),
    start(handle, point) {
      handle.from = { x: point.x, y: point.y, azimuth: state.azimuth, elevation: state.elevation };
      moving = true;
    },
    move(handle, point) {
      orbit(handle.from, point.x - handle.from.x, point.y - handle.from.y);
    },
    end: settle,
    cursor: () => "grab",
  });

  /** A drag has ended: draw the sheet at full resolution again if it was drawn coarser meanwhile. */
  function settle() {
    moving = false;
    if (sheetKey.endsWith(":2")) view.redraw();
  }

  // A finger turns the view with a sideways swipe; the browser keeps up and down swipes for scrolling the page
  // (touch-action: pan-y), and a swipe it takes over (pointercancel) leaves the view as it was.
  view.canvas.style.touchAction = "pan-y pinch-zoom";
  let touch = null;
  const toLayout = (dx, dy) => {
    const rect = view.canvas.getBoundingClientRect();
    return [(dx * WIDTH) / rect.width, (dy * HEIGHT) / rect.height];
  };
  const onTouchDown = (event) => {
    if (event.pointerType !== "touch" || !event.isPrimary || touch) return;
    touch = { id: event.pointerId, x: event.clientX, y: event.clientY, azimuth: state.azimuth, elevation: state.elevation };
    moving = true;
  };
  const onTouchMove = (event) => {
    if (!touch || event.pointerId !== touch.id) return;
    orbit(touch, ...toLayout(event.clientX - touch.x, event.clientY - touch.y));
  };
  const onTouchUp = (event) => {
    if (!touch || event.pointerId !== touch.id) return;
    if (event.type === "pointercancel" && (state.azimuth !== touch.azimuth || state.elevation !== touch.elevation)) {
      azimuthSlider.set(touch.azimuth);
      elevationSlider.set(touch.elevation);
      change({ azimuth: touch.azimuth, elevation: touch.elevation });
    }
    touch = null;
    settle();
  };
  const touchListeners = [["pointerdown", onTouchDown], ["pointermove", onTouchMove], ["pointerup", onTouchUp], ["pointercancel", onTouchUp]];
  for (const [type, listener] of touchListeners) view.canvas.addEventListener(type, listener);

  update();
  return {
    reset() {
      Object.assign(state, REST);
      sizeSlider.set(state.size);
      azimuthSlider.set(state.azimuth);
      elevationSlider.set(state.elevation);
      sheetBox.checked = state.sheet;
      update();
    },
    destroy() {
      drag.destroy();
      for (const [type, listener] of touchListeners) view.canvas.removeEventListener(type, listener);
      view.destroy();
    },
  };
}
