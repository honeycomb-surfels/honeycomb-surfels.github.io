/**
 * Browser decoder for Hexels deployment archives (.hexcodec).
 *
 * A .hexcodec file is the ZIP archive written by the Hexels codec scripts:
 * scripts/hexels_sh_codec.py ("hexels.sh_codebook_pilot": every array stored losslessly, or V3 SH coefficients
 * product-quantized into sh/codebooks.bin and sh/indices.bin) or scripts/hexels_linear_codec.py
 * ("hexels.linear_appearance_codebook": V1/V2 gradients product-quantized into <field>/books and <field>/codes).
 * Every member is DEFLATE-compressed. manifest.json describes each array (member, shape, numpy dtype), config.json
 * is the training config, and metadata.pt (a PyTorch pickle with no rendering data) is never read. Arrays are
 * stored byte-plane shuffled (write_array in hexels_sh_codec.py): the first byte of every element, then every
 * second byte, and so on.
 *
 * decodeHexcodec(buffer) returns {rows, meta}: exactly what core.js parseBundle returns for the HEXVIEW1 bundle
 * that hexels3dgs/viewer_model.py exports from the same model, with the same texel layout per primitive
 * (6 + basis_count float32 RGBA texels: center and opacity, two scaled tangent axes and the color, each with the
 * softness in w, two spatial color gradients, then 3 linear-view (V2) or 15 SH (V3) RGB coefficients) and the
 * same meta fields (format, version, count, iteration, center, radius, background, near, far, prefilter,
 * conservative_bounds, texels, view_model, basis_count, name). meta has no cameras; a hosted scene supplies them
 * separately. meta.codec adds {format, quantized: {field: clusters}, archive_bytes} about the archive itself.
 *
 * Numerics follow the reference exporter (PyTorch 2.5 CPU on x86 with AVX2, one thread, NumPy with MKL), so rows
 * are bit-identical to its output except where it calls a library exp:
 * - centers, colors, gradients and SH coefficients (lossless or from codebooks) are copied bit for bit;
 * - opacity is sigmoid as PyTorch's CPU kernel evaluates it: 1 / (1 + exp(-x)) in float32, with SLEEF's
 *   expf_u10 (FMA) on whole 16-value vector blocks and libm expf on the last count % 16 values;
 * - quaternions are normalized as torch.nn.functional.normalize does on the CPU (float32 sum of squares with
 *   fused multiply-adds, square root, clamp at 1e-12, division), then turned into rotation columns in float64
 *   with the expressions of hexels3dgs/contact_mesh.py rotation_matrices, scaled and rounded to float32 once;
 * - scales and softness use the correctly rounded float32 exp. PyTorch takes these from MKL (vmsExp, high
 *   accuracy), which is within one ulp but not correctly rounded, so about 1% of these values (texels 1 and 2
 *   xyz, texels 1 to 3 w) can differ from the exporter's in the last bit;
 * - center and radius repeat numpy.quantile (method "linear") and MKL's three-term dot product order.
 *
 * Integrity: each DEFLATE member is handed to the browser's DecompressionStream("gzip") as a one-member gzip
 * stream (a fixed header, the raw DEFLATE data, then the ZIP entry's CRC-32 and size as the trailer), so the
 * browser inflates it natively and also verifies its CRC-32 and length; a damaged or truncated download fails
 * with a clear error instead of drawing garbage. "gzip" also works in more browsers than "deflate-raw" (Chrome
 * and Edge 80+, Safari 16.4+, Firefox 113+; the module workers this decoder and the viewer run in need Firefox
 * 114+, so the visitor-facing hints say 114). No third-party code is needed.
 *
 * Memory: the archive is read in place, members are inflated one at a time into buffers of their exact size, the
 * decoder stops referencing the archive once every member is inflated (so an engine short of memory can reclaim
 * it before the rows are allocated, if the caller let go of it too), and each member buffer is dropped as soon as
 * it is written into the rows. Rows take count * texels * 16 bytes. For garden's 1.81M-primitive V3 archive
 * (157 MB, about 200 MB of members, 608 MB of rows) Node measured a 1.07 GB peak resident size, and nothing but
 * the rows stays allocated afterwards.
 *
 * Progress: onProgress({stage, fraction}) reports three stages in order, each from 0 to 1: "unzip" (inflating
 * and checking members), "decode" (unshuffling arrays and expanding codebooks into the rows) and "pack"
 * (activations, rotations, framing).
 */

const SH_FORMAT = "hexels.sh_codebook_pilot";
const LINEAR_FORMAT = "hexels.linear_appearance_codebook";
const VIEWER_FORMAT = "hexels.viewer";
const BASIS_COUNT = {none: 0, linear: 3, sh3: 15};
// Render settings hexels3dgs/viewer_model.py takes from RenderOptions when config.json does not set them.
const RENDER_DEFAULTS = {
    softness_mode: "iso", scale_modifier: 1, color_model: "linear", view_model: "linear", use_view_grads: true,
    prefilter_edge_on: false, white_background: false,
};
const NEAR = 0.2;
const FAR = 100;
const QUANTILES = [0.05, 0.95];
const SOFTNESS_FLOOR = Math.fround(1e-4);
const NORM_FLOOR = Math.fround(1e-12);
// PyTorch's CPU elementwise loops run two 8-float AVX2 vectors per step and finish the remainder with scalar code.
const VECTOR_BLOCK = 16;
const WRITE_CHUNK = 1 << 20;
const REPORT_ROWS = 1 << 16;

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;

/** A decoding failure with a visitor-facing message and a kind: format, unsupported, memory or aborted. */
export class HexcodecError extends Error {
    constructor(message, kind = "format") {
        super(message);
        this.name = "HexcodecError";
        this.kind = kind;
    }
}

const damaged = detail => new HexcodecError(`The archive is damaged: ${detail}`);
const unsupported = detail => new HexcodecError(detail, "unsupported");

/** True when `head` (the first bytes of a file, at least 30 + 11) starts like a .hexcodec archive. */
export function isHexcodecHeader(head) {
    if (!head || head.byteLength < 30 || head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 3 || head[3] !== 4) return false;
    const length = head[26] | head[27] << 8;
    if (30 + length > head.byteLength) return false;
    const first = new TextDecoder().decode(head.subarray(30, 30 + length));
    return ["metadata.pt", "config.json", "manifest.json"].includes(first) || first.startsWith("state/");
}

// ---------------------------------------------------------------------------------------------------------------
// ZIP container

/** Read the end-of-central-directory record and the central directory; members are looked up by name. */
function readDirectory(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = bytes.byteLength;
    let end = -1;
    for (let offset = size - 22; offset >= Math.max(0, size - 22 - 0xffff); offset--) {
        if (view.getUint32(offset, true) === END_OF_DIRECTORY && offset + 22 + view.getUint16(offset + 20, true) === size) {
            end = offset;
            break;
        }
    }
    if (end < 0) {
        if (size >= 4 && view.getUint32(0, true) === LOCAL_HEADER) throw damaged("its ZIP directory is missing, so the file is probably incomplete.");
        throw new HexcodecError("This is not a .hexcodec archive (no ZIP directory found).");
    }
    const entries = view.getUint16(end + 10, true);
    const directorySize = view.getUint32(end + 12, true);
    const directoryOffset = view.getUint32(end + 16, true);
    if ((end >= 20 && view.getUint32(end - 20, true) === ZIP64_LOCATOR) || entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
        if (!isHexcodecHeader(bytes.subarray(0, 512))) throw foreignArchive(bytes);
        throw unsupported("This archive uses ZIP64, which the viewer does not read (Python only writes it for archives or members past 2 GB).");
    }
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== entries) {
        throw unsupported("Split (multi-volume) ZIP archives are not supported.");
    }
    // Bytes prepended to the archive shift every offset; Python's zipfile accepts that, and so does this reader.
    const shift = end - directorySize - directoryOffset;
    if (shift < 0) throw damaged("its ZIP directory points past the end of the file.");
    const members = new Map();
    const names = new TextDecoder();
    let cursor = directoryOffset + shift;
    for (let index = 0; index < entries; index++) {
        if (cursor + 46 > end || view.getUint32(cursor, true) !== CENTRAL_HEADER) throw damaged("its ZIP directory is corrupt.");
        const nameLength = view.getUint16(cursor + 28, true);
        const next = cursor + 46 + nameLength + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
        if (next > end) throw damaged("its ZIP directory is corrupt.");
        const entry = {
            flags: view.getUint16(cursor + 8, true),
            method: view.getUint16(cursor + 10, true),
            crc: view.getUint32(cursor + 16, true),
            compressedSize: view.getUint32(cursor + 20, true),
            size: view.getUint32(cursor + 24, true),
            disk: view.getUint16(cursor + 34, true),
            offset: view.getUint32(cursor + 42, true),
            nameBytes: bytes.slice(cursor + 46, cursor + 46 + nameLength),  // a copy: entries must not pin the archive
        };
        entry.name = names.decode(entry.nameBytes);
        if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff || entry.offset === 0xffffffff) {
            throw unsupported("This archive uses ZIP64, which the viewer does not read (Python only writes it for archives or members past 2 GB).");
        }
        entry.offset += shift;
        members.set(entry.name, entry);  // a repeated name replaces the earlier entry, as in Python's zipfile
        cursor = next;
    }
    return {bytes, view, members, dataEnd: directoryOffset + shift};
}

/** The error for a ZIP that is not a .hexcodec archive, naming a PyTorch checkpoint when it is one. */
function foreignArchive(bytes) {
    const length = bytes.byteLength >= 30 ? bytes[26] | bytes[27] << 8 : 0;
    const first = length && 30 + length <= bytes.byteLength ? new TextDecoder().decode(bytes.subarray(30, 30 + length)) : "";
    if (/(^|\/)data\.pkl$/.test(first)) return new HexcodecError("This is a PyTorch checkpoint (.pt), not a .hexcodec deployment archive.");
    return new HexcodecError("This ZIP file is not a .hexcodec deployment archive.");
}

/** The compressed bytes of one member, after checking its local header against the directory. */
function memberData(archive, entry) {
    if (entry.flags & 0x41) throw unsupported(`${entry.name} is encrypted; Hexels archives are never encrypted.`);
    if (entry.disk) throw unsupported("Split (multi-volume) ZIP archives are not supported.");
    const {view, bytes} = archive;
    const offset = entry.offset;
    if (offset + 30 > archive.dataEnd || view.getUint32(offset, true) !== LOCAL_HEADER) throw damaged(`the entry of ${entry.name} is corrupt.`);
    const nameLength = view.getUint16(offset + 26, true);
    const start = offset + 30 + nameLength + view.getUint16(offset + 28, true);
    const local = bytes.subarray(offset + 30, offset + 30 + nameLength);
    if (local.byteLength !== entry.nameBytes.byteLength || local.some((value, index) => value !== entry.nameBytes[index])) {
        throw damaged(`the entry of ${entry.name} does not match the ZIP directory.`);
    }
    if (start + entry.compressedSize > archive.dataEnd) throw damaged(`${entry.name} runs past the end of the archive data.`);
    return bytes.subarray(start, start + entry.compressedSize);
}

let crcTable = null;

/** CRC-32 (the ZIP and gzip polynomial); only stored, uncompressed members need it here. */
function crc32(bytes) {
    if (!crcTable) {
        crcTable = new Int32Array(256);
        for (let value = 0; value < 256; value++) {
            let crc = value;
            for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
            crcTable[value] = crc;
        }
    }
    let crc = -1;
    for (let index = 0; index < bytes.byteLength; index++) crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
}

function allocateBytes(size, what) {
    try {
        return new Uint8Array(size);
    } catch (error) {
        console.info(`No memory for ${what}: ${error.message}`);
        throw new HexcodecError(`Out of memory: could not allocate ${(size / 1e6).toFixed(1)} MB for ${what}.`, "memory");
    }
}

/**
 * Inflate one member into a buffer of its exact size. DEFLATE members are wrapped in a gzip header and a trailer
 * holding the ZIP entry's CRC-32 and size, so the browser's DecompressionStream("gzip") inflates them and also
 * verifies both; a damaged member fails here rather than drawing garbage. report(bytes) follows the output.
 */
async function inflate(archive, entry, report) {
    const data = memberData(archive, entry);
    if (entry.method === 0) {
        if (data.byteLength !== entry.size || crc32(data) !== entry.crc) throw damaged(`${entry.name} fails its CRC check.`);
        report(entry.size);
        return data.slice();
    }
    if (entry.method !== 8) throw unsupported(`${entry.name} uses ZIP compression method ${entry.method}; the viewer reads stored and DEFLATE members.`);
    if (typeof DecompressionStream !== "function") {
        throw unsupported("This browser cannot unpack compressed archives (no DecompressionStream). Update it (Chrome or Edge 80+, Safari 16.4+, Firefox 114+).");
    }
    const output = allocateBytes(entry.size, entry.name);
    const stream = new DecompressionStream("gzip");
    const writer = stream.writable.getWriter();
    const trailer = new Uint8Array(8);
    const fields = new DataView(trailer.buffer);
    fields.setUint32(0, entry.crc, true);
    fields.setUint32(4, entry.size, true);
    const feeding = (async () => {
        await writer.write(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]));
        // Copies, not views: a stream that keeps its last input chunk must not keep the whole archive alive.
        for (let at = 0; at < data.byteLength; at += WRITE_CHUNK) await writer.write(data.slice(at, Math.min(data.byteLength, at + WRITE_CHUNK)));
        await writer.write(trailer);
        await writer.close();
    })();
    feeding.catch(() => {});  // a failure here also errors the readable side, which reports it below
    const reader = stream.readable.getReader();
    let written = 0, finished = false;
    try {
        for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            if (written + value.byteLength > output.byteLength) throw damaged(`${entry.name} is larger than its ZIP entry says.`);
            output.set(value, written);
            written += value.byteLength;
            report(written);
        }
        await feeding;
        finished = true;
    } catch (error) {
        if (error instanceof HexcodecError) throw error;
        // A damaged or cut-off download ends here; the visitor gets the message below, so this is no console error.
        console.info(`${entry.name} did not inflate:`, error);
        throw damaged(`${entry.name} does not unpack or fails its CRC check.`);
    } finally {
        if (!finished) reader.cancel().catch(() => {});
    }
    if (written !== entry.size) throw damaged(`${entry.name} is shorter than its ZIP entry says.`);
    return output;
}

// ---------------------------------------------------------------------------------------------------------------
// Manifest and model layout

/** JSON as Python's json module writes it; bare NaN and Infinity tokens (outside strings) are read as null. */
function parseJson(bytes, what) {
    let text;
    try {
        text = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
        return JSON.parse(text);
    } catch (error) {
        if (text !== undefined) {
            try {
                return JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|(-?Infinity|NaN)/g, (match, token) => token ? "null" : match));
            } catch (retry) {
                console.info(`${what} is not valid JSON: ${retry.message}`);
            }
        }
        throw damaged(`${what} is not valid JSON.`);
    }
}

/** Python truthiness, which the exporter applies to config values. */
const truthy = value => !(value === null || value === undefined || value === false || value === 0 || value === ""
    || (Array.isArray(value) ? value.length === 0 : typeof value === "object" && Object.keys(value).length === 0));

const ITEM_SIZE = {"<f4": 4, "<u2": 2, "|u1": 1, "|b1": 1};
const own = (object, key) => object !== null && typeof object === "object" && Object.prototype.hasOwnProperty.call(object, key);

/** Check one manifest array descriptor against the expected dtypes and shape (null for any size). */
function arrayEntry(archive, descriptor, label, dtypes, shape) {
    if (!descriptor || typeof descriptor.member !== "string" || typeof descriptor.dtype !== "string" || !Array.isArray(descriptor.shape)
        || !descriptor.shape.every(size => Number.isSafeInteger(size) && size >= 0)) {
        throw damaged(`manifest.json describes ${label} incorrectly.`);
    }
    if (!dtypes.includes(descriptor.dtype)) throw unsupported(`${label} is stored as ${descriptor.dtype}, not ${dtypes.join(" or ")}.`);
    if (descriptor.shape.length !== shape.length || shape.some((size, axis) => size !== null && size !== descriptor.shape[axis])) {
        throw new HexcodecError(`${label} has shape [${descriptor.shape}], expected [${shape.map(size => size ?? "any")}].`);
    }
    const entry = archive.members.get(descriptor.member);
    if (!entry) throw damaged(`member ${descriptor.member} is missing.`);
    const count = descriptor.shape.reduce((product, size) => product * size, 1);
    if (entry.size !== count * ITEM_SIZE[descriptor.dtype]) throw damaged(`${descriptor.member} has ${entry.size} bytes, not ${count * ITEM_SIZE[descriptor.dtype]}.`);
    return {entry, shape: descriptor.shape, dtype: descriptor.dtype, count};
}

/**
 * A float field of shape (count, width, channels): lossless ({array}) or product-quantized ({books, codes}, with
 * books (width, clusters, channels) and codes (count, width)), as both codec scripts store them.
 */
function fieldSource(archive, sources, field, count, width, channels) {
    const source = sources[field];
    if (!source) throw damaged(`the model field ${field} is missing.`);
    if (source.array) return {array: arrayEntry(archive, source.array, field, ["<f4"], [count, width, channels])};
    const books = arrayEntry(archive, source.books, `${field} codebooks`, ["<f4"], [width, null, channels]);
    const codes = arrayEntry(archive, source.codes, `${field} codes`, ["<u2", "|u1"], [count, width]);
    if (books.shape[1] < 1) throw damaged(`${field} has empty codebooks.`);
    return {books, codes, clusters: books.shape[1]};
}

/** Validate manifest.json and config.json and list what the rows need, mirroring viewer_model.py's checks. */
function describe(archive, manifest, config, name) {
    if (!manifest || typeof manifest !== "object" || !manifest.arrays || typeof manifest.arrays !== "object") throw damaged("manifest.json is incomplete.");
    if (manifest.format !== SH_FORMAT && manifest.format !== LINEAR_FORMAT) {
        throw unsupported(`This archive has format ${JSON.stringify(manifest.format)}; the viewer opens Hexels deployment archives (${SH_FORMAT} or ${LINEAR_FORMAT}).`);
    }
    if (manifest.version !== 1) throw unsupported(`This archive is ${manifest.format} version ${manifest.version}; the viewer reads version 1.`);
    const sources = {};
    for (const [field, descriptor] of Object.entries(manifest.arrays)) sources[field] = {array: descriptor};
    const quantized = {};
    if (manifest.format === SH_FORMAT) {
        if (manifest.quantized === true) sources.view_grads = {books: manifest.codebooks, codes: manifest.indices};
        else if (manifest.quantized !== false) throw damaged("manifest.json does not say whether the SH appearance is quantized.");
    } else {
        for (const [field, pair] of Object.entries(manifest.codebooks || {})) sources[field] = {books: pair?.books, codes: pair?.codes};
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw damaged("config.json is not a settings object.");
    const settings = {...RENDER_DEFAULTS, ...config};
    const viewModel = settings.view_model;
    if (settings.color_model !== "linear" || !own(BASIS_COUNT, viewModel)) {
        throw unsupported(`The viewer opens Hexels V1, V2 and V3 models (linear color; no, linear or SH3 view model), not color_model=${settings.color_model}, view_model=${viewModel}.`);
    }
    if (viewModel !== "none" && settings.use_view_grads !== true) throw unsupported(`A ${viewModel} view model without view gradients is not a V1, V2 or V3 deployment.`);
    if (settings.softness_mode !== "iso" && settings.softness_mode !== "aniso") throw unsupported(`Unknown softness_mode ${settings.softness_mode}.`);
    const basisCount = truthy(settings.use_view_grads) ? BASIS_COUNT[viewModel] : 0;

    const means = arrayEntry(archive, sources.means3d?.array, "means3d", ["<f4"], [null, 3]);
    const count = means.shape[0];
    if (count < 1) throw new HexcodecError("The archive holds no primitives.");
    if (sources.child_parent_idx?.array?.shape?.[0]) throw unsupported("Models with child primitives (grown hierarchies) cannot be shown in the browser viewer.");
    const softnessShape = settings.softness_mode === "aniso" ? [count, 3] : [count];
    const viewBasis = viewModel === "sh3" ? 15 : 3;
    const view = sources.view_grads;
    // viewer_model.py requires view_grads (P, K, 3) with K = 15 for SH3 and 3 otherwise, even when it is unused.
    const viewWidth = view?.array ? view.array.shape?.[1] : view?.books?.shape?.[0];
    if (viewWidth !== viewBasis || (view?.array && view.array.shape?.[2] !== 3)) throw new HexcodecError(`view_grads does not have the ${viewBasis} RGB coefficients that view_model=${viewModel} needs.`);
    const plan = {
        count, basisCount, viewModel, settings, name,
        means,
        logScales: arrayEntry(archive, sources.log_scales?.array, "log_scales", ["<f4"], [count, 2]),
        quaternions: arrayEntry(archive, sources.rotation_quats?.array, "rotation_quats", ["<f4"], [count, 4]),
        colors: arrayEntry(archive, sources.colors?.array, "colors", ["<f4"], [count, 3]),
        logits: arrayEntry(archive, sources.opacity_logits?.array, "opacity_logits", ["<f4"], [count]),
        logSoftness: arrayEntry(archive, sources.log_softness?.array, "log_softness", ["<f4"], softnessShape),
        active: sources.active_mask ? arrayEntry(archive, sources.active_mask.array, "active_mask", ["|b1"], [count]) : null,
        colorGrads: fieldSource(archive, sources, "color_grads", count, 2, 3),
        view: basisCount ? fieldSource(archive, sources, "view_grads", count, basisCount, 3) : null,
        quantized,
    };
    for (const [field, source] of [["color_grads", plan.colorGrads], ["view_grads", plan.view]]) if (source?.books) quantized[field] = source.clusters;
    return plan;
}

// ---------------------------------------------------------------------------------------------------------------
// float32 arithmetic of the reference exporter

/** Fused multiply-add of float32 values with one rounding to float32, as the FMA instruction computes it. */
function fmaf(a, b, c) {
    const product = a * b;  // exact: the product of two 24-bit significands fits in a double
    const sum = product + c;
    const rounded = Math.fround(sum);
    if (rounded === sum) return rounded;
    const other = 2 * sum - rounded;  // the float32 on the far side of sum when sum lies exactly halfway
    if (Math.fround(other) !== other) return rounded;
    // sum is a float32 midpoint, so its own rounding may hide which side the exact result lies on; TwoSum tells.
    const virtual = sum - product;
    const error = (product - (sum - virtual)) + (c - virtual);
    if (error === 0) return rounded;
    return (error > 0) === (other > rounded) ? other : rounded;
}

/** Round half to even, as _mm256_cvtps_epi32 does in the default rounding mode. */
function roundEven(value) {
    const rounded = Math.round(value);
    return rounded - value === 0.5 && rounded % 2 !== 0 ? rounded - 1 : rounded;
}

const LOG2E = Math.fround(1.442695040888963407359924681001892137426645954152985934135449406931);
const LN2_HIGH = Math.fround(0.693145751953125);
const LN2_LOW = Math.fround(1.428606765330187045e-06);
const EXP_POLYNOMIAL = [0.000198527617612853646278381, 0.00139304355252534151077271, 0.00833336077630519866943359,
    0.0416664853692054748535156, 0.166666671633720397949219, 0.5].map(Math.fround);
const POWERS_OF_TWO = new Float64Array(301);  // 2^(k - 150)
POWERS_OF_TWO[150] = 1;
for (let k = 151; k <= 300; k++) POWERS_OF_TWO[k] = POWERS_OF_TWO[k - 1] * 2;
for (let k = 149; k >= 0; k--) POWERS_OF_TWO[k] = POWERS_OF_TWO[k + 1] / 2;

/** SLEEF xexpf (expf_u10) with FMA, which PyTorch's AVX2 Vectorized<float>::exp calls. */
function sleefExpf(d) {
    if (d !== d) return NaN;
    if (d < -104) return 0;
    if (d > 100) return Infinity;
    const q = roundEven(Math.fround(d * LOG2E));
    let s = fmaf(q, -LN2_HIGH, d);
    s = fmaf(q, -LN2_LOW, s);
    let u = EXP_POLYNOMIAL[0];
    for (let index = 1; index < EXP_POLYNOMIAL.length; index++) u = fmaf(u, s, EXP_POLYNOMIAL[index]);
    u = Math.fround(1 + fmaf(Math.fround(s * s), u, s));
    const half = q >> 1;
    return Math.fround(Math.fround(u * POWERS_OF_TWO[half + 150]) * POWERS_OF_TWO[q - half + 150]);
}

/** torch.sigmoid on the CPU: the vectorized path for whole blocks, scalar libm expf for the remainder. */
const sigmoid = (x, vector) => Math.fround(1 / Math.fround(1 + (vector ? sleefExpf(Math.fround(0 - x)) : Math.fround(Math.exp(-x)))));
const expf = x => Math.fround(Math.exp(x));
const finite = value => value - value === 0;

// ---------------------------------------------------------------------------------------------------------------
// Rows

/** Unshuffle a byte-plane float32 member into its 32-bit words (view the buffer as Float32Array for values). */
function unshuffleWords(bytes) {
    const count = bytes.byteLength >>> 2;
    const words = new Int32Array(count);
    const second = count, third = 2 * count, fourth = 3 * count;
    for (let index = 0; index < count; index++) {
        words[index] = bytes[index] | bytes[second + index] << 8 | bytes[third + index] << 16 | bytes[fourth + index] << 24;
    }
    return words;
}

/** Where a field lands in a primitive's texels: component (w, c) goes to float offset base[w] + c * step. */
function placement(bases, step = 1) {
    return {bases: Int32Array.from(bases), step};
}

/** Copy a lossless float32 field (count, width, channels) into the rows bit for bit. */
function copyField(target, bytes, width, channels, place, label, report) {
    const {words, ids, count, stride} = target;
    const {bases, step} = place;
    const total = bytes.byteLength >>> 2;
    const second = total, third = 2 * total, fourth = 3 * total;
    const perRow = width * channels;
    let nonFinite = false;
    for (let row = 0; row < count; row++) {
        let at = (ids === null ? row : ids[row]) * perRow;
        const base = row * stride;
        for (let w = 0; w < width; w++) {
            let slot = base + bases[w];
            for (let channel = 0; channel < channels; channel++, at++, slot += step) {
                const bits = bytes[at] | bytes[second + at] << 8 | bytes[third + at] << 16 | bytes[fourth + at] << 24;
                if ((bits & 0x7f800000) === 0x7f800000) nonFinite = true;
                words[slot] = bits;
            }
        }
        if ((row & (REPORT_ROWS - 1)) === 0) report(row / count);
    }
    if (nonFinite) throw new HexcodecError(`The model has non-finite ${label}.`);
}

/**
 * Expand a product-quantized field: component (w, c) of a primitive is books[w, codes[primitive, w], c], as the
 * codec scripts' numpy indexing builds it. Like numpy, any code past its codebook fails, used or not; like the
 * exporter's finiteness check, a non-finite codebook vector fails only when an active primitive uses it.
 */
function copyCodebook(target, booksBytes, codesBytes, codeSize, shape, place, label, report) {
    const {words, ids, count, stride} = target;
    const {bases, step} = place;
    const [width, clusters, channels] = shape;
    const book = unshuffleWords(booksBytes);
    let broken = null;
    for (let vector = 0; vector < width * clusters; vector++) {
        for (let channel = 0; channel < channels; channel++) {
            if ((book[vector * channels + channel] & 0x7f800000) === 0x7f800000) (broken ??= new Uint8Array(width * clusters))[vector] = 1;
        }
    }
    const total = codesBytes.byteLength / codeSize;
    let codes = codesBytes, largest = 0;
    if (codeSize === 2) {
        codes = new Uint16Array(total);
        for (let index = 0; index < total; index++) {
            const code = codesBytes[index] | codesBytes[total + index] << 8;
            codes[index] = code;
            if (code > largest) largest = code;
        }
    } else {
        for (let index = 0; index < total; index++) if (codes[index] > largest) largest = codes[index];
    }
    if (largest >= clusters) throw damaged(`a ${label} code points past its codebook.`);
    if (channels === 3 && broken === null) {
        // the usual case (RGB codebooks, all finite), unrolled: this loop writes most of a V3 model's rows
        for (let row = 0; row < count; row++) {
            const at = (ids === null ? row : ids[row]) * width;
            const base = row * stride;
            for (let w = 0; w < width; w++) {
                const entry = 3 * (w * clusters + codes[at + w]);
                const slot = base + bases[w];
                words[slot] = book[entry];
                words[slot + step] = book[entry + 1];
                words[slot + 2 * step] = book[entry + 2];
            }
            if ((row & (REPORT_ROWS - 1)) === 0) report(row / count);
        }
        return;
    }
    for (let row = 0; row < count; row++) {
        const at = (ids === null ? row : ids[row]) * width;
        const base = row * stride;
        for (let w = 0; w < width; w++) {
            const vector = w * clusters + codes[at + w];
            if (broken !== null && broken[vector]) throw new HexcodecError(`The model has non-finite ${label}.`);
            let entry = vector * channels, slot = base + bases[w];
            for (let channel = 0; channel < channels; channel++, entry++, slot += step) words[slot] = book[entry];
        }
        if ((row & (REPORT_ROWS - 1)) === 0) report(row / count);
    }
}

/** Write one float field, lossless or product-quantized, taking (and so releasing) its inflated members. */
function writeField(target, members, source, width, channels, place, label, report) {
    if (source.array) {
        copyField(target, members.take(source.array.entry), width, channels, place, label, report);
        return;
    }
    const codeSize = source.codes.dtype === "<u2" ? 2 : 1;
    copyCodebook(target, members.take(source.books.entry), members.take(source.codes.entry), codeSize, source.books.shape, place, label, report);
}

/** The rows pack_for_rasterizer keeps: {count, ids}, with ids null when every primitive is active. */
function activeRows(mask) {
    let count = 0;
    for (let index = 0; index < mask.length; index++) if (mask[index]) count++;
    if (count === 0) throw new HexcodecError("The archive marks every primitive inactive.");
    if (count === mask.length) return {count, ids: null};
    const ids = new Uint32Array(count);
    for (let index = 0, row = 0; index < mask.length; index++) if (mask[index]) ids[row++] = index;
    return {count, ids};
}

/** Centers into texel 0 xyz; the float32 values are also kept for the framing quantiles. */
function copyCenters(target, centers, report) {
    const {rows, ids, count, stride} = target;
    let nonFinite = false;
    for (let row = 0; row < count; row++) {
        const index = 3 * (ids === null ? row : ids[row]);
        const base = row * stride;
        for (let channel = 0; channel < 3; channel++) {
            const value = centers[index + channel];
            if (!finite(value)) nonFinite = true;
            rows[base + channel] = value;
        }
        if ((row & (REPORT_ROWS - 1)) === 0) report(row / count);
    }
    if (nonFinite) throw new HexcodecError("The model has non-finite centers.");
}

/**
 * Texels 1 and 2 xyz: the rotation's first two columns times the scales, as pack_for_rasterizer (float32 torch)
 * and bundle_arrays (float64 numpy) compute them.
 */
function packAxes(target, logScales, quaternions, modifier, report) {
    const {rows, ids, count, stride} = target;
    for (let row = 0; row < count; row++) {
        const index = ids === null ? row : ids[row];
        const scale0 = Math.fround(expf(logScales[2 * index]) * modifier);
        const scale1 = Math.fround(expf(logScales[2 * index + 1]) * modifier);
        if (scale0 <= 0 || scale1 <= 0) throw new HexcodecError("The model has non-positive scales.");
        // torch.nn.functional.normalize(rotation_quats, dim=1) in float32
        const w = quaternions[4 * index], x = quaternions[4 * index + 1], y = quaternions[4 * index + 2], z = quaternions[4 * index + 3];
        const norm = Math.max(Math.fround(Math.sqrt(fmaf(z, z, fmaf(y, y, fmaf(x, x, Math.fround(w * w)))))), NORM_FLOOR);
        const qw = Math.fround(w / norm), qx = Math.fround(x / norm), qy = Math.fround(y / norm), qz = Math.fround(z / norm);
        // contact_mesh.py rotation_matrices in float64: renormalize, then rotation columns 0 and 1
        const length = Math.sqrt(((qw * qw + qx * qx) + qy * qy) + qz * qz);
        if (!(length > 0) || !finite(length)) throw new HexcodecError("The model has zero or non-finite rotations.");
        const real = qw / length, ax = qx / length, ay = qy / length, az = qz / length;
        const first0 = Math.fround((1 - 2 * (ay * ay + az * az)) * scale0);
        const first1 = Math.fround((2 * (ax * ay + real * az)) * scale0);
        const first2 = Math.fround((2 * (ax * az - real * ay)) * scale0);
        const second0 = Math.fround((2 * (ax * ay - real * az)) * scale1);
        const second1 = Math.fround((1 - 2 * (ax * ax + az * az)) * scale1);
        const second2 = Math.fround((2 * (ay * az + real * ax)) * scale1);
        if (!finite(first0 + first1 + first2 + second0 + second1 + second2)) throw new HexcodecError("The model has non-finite tangent axes.");
        const base = row * stride;
        rows[base + 4] = first0; rows[base + 5] = first1; rows[base + 6] = first2;
        rows[base + 8] = second0; rows[base + 9] = second1; rows[base + 10] = second2;
        if ((row & (REPORT_ROWS - 1)) === 0) report(row / count);
    }
}

/** Texel 0 w: torch.sigmoid(opacity_logits), whose CPU kernel switches to scalar code for the last count % 16. */
function packOpacity(target, logits, report) {
    const {rows, ids, count, stride} = target;
    const vectorRows = count - count % VECTOR_BLOCK;
    for (let row = 0; row < count; row++) {
        const value = sigmoid(logits[ids === null ? row : ids[row]], row < vectorRows);
        if (!finite(value)) throw new HexcodecError("The model has non-finite opacities.");
        rows[row * stride + 3] = value;
        if ((row & (REPORT_ROWS - 1)) === 0) report(row / count);
    }
}

/** Texels 1 to 3 w: exp(log_softness), one value (iso) or one per axis (aniso), floored at float32(1e-4). */
function packSoftness(target, logSoftness, width, report) {
    const {rows, ids, count, stride} = target;
    for (let row = 0; row < count; row++) {
        const index = (ids === null ? row : ids[row]) * width;
        const first = Math.max(expf(logSoftness[index]), SOFTNESS_FLOOR);
        const second = width === 3 ? Math.max(expf(logSoftness[index + 1]), SOFTNESS_FLOOR) : first;
        const third = width === 3 ? Math.max(expf(logSoftness[index + 2]), SOFTNESS_FLOOR) : first;
        if (!finite(first + second + third)) throw new HexcodecError("The model has non-finite softness.");
        const base = row * stride;
        rows[base + 7] = first; rows[base + 11] = second; rows[base + 15] = third;
        if ((row & (REPORT_ROWS - 1)) === 0) report(row / count);
    }
}

/** Order statistic: rearrange values[left..right] so values[k] is the k-th smallest (Numerical Recipes select). */
function select(values, k, left, right) {
    let low = left, high = right, swap;
    for (;;) {
        if (high <= low + 1) {
            if (high === low + 1 && values[high] < values[low]) { swap = values[low]; values[low] = values[high]; values[high] = swap; }
            return values[k];
        }
        const middle = (low + high) >>> 1;
        swap = values[middle]; values[middle] = values[low + 1]; values[low + 1] = swap;
        if (values[low] > values[high]) { swap = values[low]; values[low] = values[high]; values[high] = swap; }
        if (values[low + 1] > values[high]) { swap = values[low + 1]; values[low + 1] = values[high]; values[high] = swap; }
        if (values[low] > values[low + 1]) { swap = values[low]; values[low] = values[low + 1]; values[low + 1] = swap; }
        const pivot = values[low + 1];
        let i = low + 1, j = high;
        for (;;) {
            do i++; while (values[i] < pivot);
            do j--; while (values[j] > pivot);
            if (j < i) break;
            swap = values[i]; values[i] = values[j]; values[j] = swap;
        }
        values[low + 1] = values[j];
        values[j] = pivot;
        if (j >= k) high = j - 1;
        if (j <= k) low = i;
    }
}

/** numpy.quantile(values, QUANTILES) with method "linear" for float32 input (float64 result). */
function quantiles(values) {
    const count = values.length;
    const picks = QUANTILES.map(quantile => {
        const virtual = (count - 1) * quantile;
        let previous = Math.floor(virtual), next = previous + 1;
        if (virtual >= count - 1) previous = next = -1;
        if (virtual < 0) previous = next = 0;
        return {gamma: virtual - previous, previous: previous < 0 ? count + previous : previous, next: next < 0 ? count + next : next};
    });
    const ranks = [...new Set(picks.flatMap(pick => [pick.previous, pick.next]))].sort((a, b) => a - b);
    const ordered = new Map();
    let left = 0;
    for (const rank of ranks) {
        ordered.set(rank, select(values, rank, left, count - 1));
        left = rank;
    }
    return picks.map(({gamma, previous, next}) => {
        const a = ordered.get(previous), b = ordered.get(next);
        const difference = Math.fround(b - a);  // numpy subtracts the two float32 order statistics in float32
        return gamma >= 0.5 ? b - difference * (1 - gamma) : a + difference * gamma;
    });
}

/** scene_metadata: center and radius from the 5% and 95% quantiles of the active centers. */
function framing(target, centers, report) {
    const {ids, count} = target;
    const axis = new Float32Array(count);
    const lower = [], upper = [];
    for (let channel = 0; channel < 3; channel++) {
        for (let row = 0; row < count; row++) axis[row] = centers[3 * (ids === null ? row : ids[row]) + channel];
        const [low, high] = quantiles(axis);
        lower.push(low);
        upper.push(high);
        report((channel + 1) / 3);
    }
    const center = lower.map((low, channel) => (low + upper[channel]) * 0.5);
    const extent = upper.map((high, channel) => high - lower[channel]);
    // np.linalg.norm of a 3-vector is sqrt(x.dot(x)); MKL's ddot adds the products as (x0^2 + x2^2) + x1^2
    const radius = Math.max(Math.sqrt((extent[0] * extent[0] + extent[2] * extent[2]) + extent[1] * extent[1]) * 0.5, 0.5);
    return {center, radius};
}

/** Stage progress for onProgress: stages in order, each with a fraction from 0 to 1, at most one report per percent. */
class Progress {
    constructor(callback) {
        this.callback = typeof callback === "function" ? callback : null;
        this.stage = null;
        this.fraction = -1;
    }

    report(stage, fraction) {
        if (!this.callback) return;
        const value = Math.max(0, Math.min(1, fraction));
        if (stage === this.stage && value < 1 && value - this.fraction < 0.01) return;
        if (stage === this.stage && value <= this.fraction) return;
        this.stage = stage;
        this.fraction = value;
        this.callback({stage, fraction: value});
    }
}

function checkAborted(signal) {
    if (signal?.aborted) throw new HexcodecError("Decoding canceled.", "aborted");
}

function sceneName(settings) {
    const parts = typeof settings.source_path === "string" ? settings.source_path.split(/[\\/]+/).filter(Boolean) : [];
    return parts.length ? parts[parts.length - 1] : "model";
}

/**
 * Decode a .hexcodec archive (an ArrayBuffer or a view of one) into {rows: Float32Array, meta}, as described at
 * the top of this file. Options: onProgress({stage, fraction}); name, the meta.name to use (default: the scene
 * folder of config.json source_path); signal, an AbortSignal that cancels between steps.
 */
export async function decodeHexcodec(buffer, {onProgress = null, name = null, signal = null} = {}) {
    const progress = new Progress(onProgress);
    progress.report("unzip", 0);
    let archive = readDirectory(ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer));
    buffer = null;
    const archiveBytes = archive.bytes.byteLength;
    const small = async member => {
        const entry = archive.members.get(member);
        if (!entry) throw archive.members.has("metadata.pt") ? damaged(`${member} is missing.`) : foreignArchive(archive.bytes);
        return parseJson(await inflate(archive, entry, () => {}), member);
    };
    const manifest = await small("manifest.json");
    const config = await small("config.json");
    const plan = describe(archive, manifest, config, typeof name === "string" && name ? name : sceneName({...RENDER_DEFAULTS, ...config}));

    // unzip: every member the rows need, each inflated once into its own buffer
    const needed = [plan.active, plan.means, plan.logScales, plan.quaternions, plan.colors, plan.logits, plan.logSoftness,
        plan.colorGrads.array, plan.colorGrads.books, plan.colorGrads.codes, plan.view?.array, plan.view?.books, plan.view?.codes]
        .filter(Boolean).map(item => item.entry);
    const total = needed.reduce((sum, entry) => sum + entry.size, 0) || 1;
    const inflated = new Map();
    let done = 0;
    for (const entry of needed) {
        checkAborted(signal);
        if (inflated.has(entry.name)) continue;
        inflated.set(entry.name, await inflate(archive, entry, bytes => progress.report("unzip", (done + bytes) / total)));
        done += entry.size;
    }
    archive = null;  // nothing below reads the archive, so its memory can go once the caller lets go too
    progress.report("unzip", 1);
    const members = {
        take(entry) {
            const bytes = inflated.get(entry.name);
            if (!bytes) throw damaged(`two arrays share the member ${entry.name}.`);
            inflated.delete(entry.name);
            return bytes;
        },
    };

    // decode: active rows, then every stored array into the rows or into float32 arrays for the activations
    checkAborted(signal);
    const {count: stored, basisCount} = plan;
    const {count, ids} = plan.active ? activeRows(members.take(plan.active.entry)) : {count: stored, ids: null};
    const texels = 6 + basisCount;
    let rows;
    try {
        rows = new Float32Array(count * texels * 4);
    } catch (error) {
        console.info(`No memory for ${count} rows: ${error.message}`);
        throw new HexcodecError(`Out of memory: could not allocate ${(count * texels * 16 / 1e6).toFixed(1)} MB for ${count.toLocaleString()} primitives.`, "memory");
    }
    const stride = texels * 4;
    const target = {rows, words: new Int32Array(rows.buffer), ids, count, stride};
    // [label, source, width, channels, placement]; component (w, c) of a field lands at placement base[w] + c * step
    const fields = [
        ["colors", plan.colors, 1, 3, placement([12])],
        ["color gradients", plan.colorGrads, 2, 3, placement([16, 20])],
    ];
    if (basisCount === 3) fields.push(["view gradients", plan.view, 3, 3, placement([24, 25, 26], 4)]);  // rows[:, 6 + i, j] = view_grads[:, j, i]
    if (basisCount === 15) fields.push(["SH coefficients", plan.view, 15, 3, placement(Array.from({length: 15}, (_, k) => 24 + 4 * k))]);
    const softnessWidth = plan.logSoftness.shape.length === 2 ? 3 : 1;
    const weights = [3, ...fields.map(([, , width, channels]) => width * channels), 7 + softnessWidth];
    const decodeTotal = weights.reduce((sum, weight) => sum + weight, 0);
    let decodeDone = 0;
    const decodeStep = weight => {
        const start = decodeDone;
        decodeDone += weight;
        return fraction => progress.report("decode", (start + weight * fraction) / decodeTotal);
    };
    const floats = item => new Float32Array(unshuffleWords(members.take(item.entry)).buffer);
    const centers = floats(plan.means);
    copyCenters(target, centers, decodeStep(3));
    for (const [label, source, width, channels, place] of fields) {
        checkAborted(signal);
        const report = decodeStep(width * channels);
        if (source.entry) copyField(target, members.take(source.entry), width, channels, place, label, report);
        else writeField(target, members, source, width, channels, place, label, report);
    }
    let logScales = floats(plan.logScales);
    let quaternions = floats(plan.quaternions);
    let logits = floats(plan.logits);
    let logSoftness = floats(plan.logSoftness);
    progress.report("decode", 1);

    // pack: scaled tangent axes, opacity and softness as viewer_model.py bundle_arrays computes them, then framing
    checkAborted(signal);
    const packStep = part => fraction => progress.report("pack", (part + fraction) / 4);
    packAxes(target, logScales, quaternions, Math.fround(Number(plan.settings.scale_modifier)), packStep(0));
    logScales = quaternions = null;
    packOpacity(target, logits, packStep(1));
    logits = null;
    packSoftness(target, logSoftness, softnessWidth, packStep(2));
    logSoftness = null;
    const {center, radius} = framing(target, centers, packStep(3));
    const {settings} = plan;
    const iteration = Number.isSafeInteger(settings.iterations) && settings.iterations >= 0 ? settings.iterations : 0;
    const meta = {
        format: VIEWER_FORMAT, version: 1, count, iteration, center, radius,
        background: truthy(settings.white_background) ? [1, 1, 1] : [0, 0, 0], near: NEAR, far: FAR,
        prefilter: truthy(settings.prefilter_edge_on), conservative_bounds: truthy(settings.conservative_bounds),
        texels, view_model: plan.viewModel, basis_count: basisCount, name: plan.name,
        codec: {format: manifest.format, quantized: plan.quantized, archive_bytes: archiveBytes},
    };
    progress.report("pack", 1);
    return {rows, meta};
}
