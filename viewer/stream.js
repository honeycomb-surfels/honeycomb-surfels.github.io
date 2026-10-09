/**
 * Streamed reading of Hexels models from a URL or a local File, with byte progress.
 *
 * Two formats open here, recognised by their magic bytes rather than by the file name (hosted URLs carry a ?v=
 * query, and local files may be renamed):
 * - HEXVIEW1 viewer bundles written by hexels3dgs/viewer_model.py (.hexview), optionally wrapped in gzip for
 *   transfer (.hexview.gz). The HEXVIEW1 header gives the exact bundle size, so the model lands in one buffer
 *   allocated once (no second copy) and a damaged header fails after the first bytes. core.js parseBundle still
 *   validates the finished buffer.
 * - .hexcodec deployment archives (a ZIP written by the Hexels codec scripts). A ZIP keeps its directory at the
 *   end, so the whole archive is collected into one buffer, sized from the expected download size when known,
 *   and handed over intact to hexcodec-worker.js for decoding. A PyTorch checkpoint is also a ZIP; its first
 *   member (data.pkl) gives it away before the rest downloads.
 * Gzip transfer wrapping is inflated with the browser's DecompressionStream; a server that sends
 * Content-Encoding: gzip is inflated by the browser itself.
 */

const MAGIC = "HEXVIEW1";
const ZIP_MAGIC = "PK\u0003\u0004";
const HEADER_LIMIT = 16 * 1024 * 1024;
const SNIFF_BYTES = 64;
const MINIMUM_CAPACITY = 1 << 20;
const GZIP_DATA_ERROR = /compress|inflat|junk|zlib|gzip|header check|deflate/i;
const CHECKPOINT_MESSAGE = "This looks like a PyTorch checkpoint (.pt). The browser cannot read training checkpoints; open a .hexcodec deployment archive or a .hexview bundle instead.";

/**
 * A load failure with a visitor-facing message and a kind: network, not-found, http, format, memory, texture,
 * file, unsupported or aborted.
 */
export class LoadError extends Error {
    constructor(message, kind) {
        super(message);
        this.name = "LoadError";
        this.kind = kind;
    }
}

export const megabytes = bytes => `${(bytes / 1e6).toFixed(1)} MB`;

export const aborted = () => new LoadError("Loading canceled.", "aborted");

const text = (bytes, start, end) => String.fromCharCode(...bytes.subarray(start, end));

function concat(chunks, length) {
    if (chunks.length === 1) return chunks[0];
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return joined;
}

/** Name of the first member of a ZIP archive from its local file header, or null when the head is too short. */
function firstZipMember(head) {
    if (head.byteLength < 30) return null;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const length = view.getUint16(26, true);
    return head.byteLength >= 30 + length ? new TextDecoder().decode(head.subarray(30, 30 + length)) : null;
}

/** Name what a file that is no Hexels model most likely is, so the message says what to do instead. */
function foreignFileMessage(head) {
    const start = text(head, 0, 16);
    if (head[0] === 0x80) return CHECKPOINT_MESSAGE;
    if (/^ply\s/.test(start)) return "PLY files are not Hexels models. Open a .hexcodec deployment archive or a .hexview bundle instead.";
    if (/^\s*</.test(start)) return "The server sent a web page instead of a model file. Check the model URL.";
    return "This is not a Hexels model. The viewer opens .hexcodec deployment archives and .hexview bundles (or .hexview.gz).";
}

/** Validate a complete HEXVIEW1 header; returns the bundle's total byte length. Mirrors core.js parseBundle. */
function bundleLength(head, jsonLength) {
    let metadata;
    try {
        metadata = JSON.parse(new TextDecoder().decode(head.subarray(12, 12 + jsonLength)));
    } catch (error) {
        console.error(error);
        throw new LoadError("The bundle header is damaged.", "format");
    }
    if (metadata.version !== 1 || metadata.format !== "hexels.viewer" || !Number.isSafeInteger(metadata.count) || metadata.count < 1) {
        throw new LoadError("Unsupported bundle version or primitive count.", "format");
    }
    if (![0, 3, 15].includes(metadata.basis_count) || metadata.texels !== 6 + metadata.basis_count) {
        throw new LoadError("Unsupported appearance layout; this viewer opens Hexels V1, V2 and V3 bundles.", "format");
    }
    return 12 + jsonLength + metadata.count * metadata.texels * 16;
}

export function allocate(total) {
    try {
        return new Uint8Array(total);
    } catch (error) {
        console.info(`No memory for ${megabytes(total)}:`, error);
        throw new LoadError(`This device could not reserve ${megabytes(total)} of memory for the model. Close other tabs or choose a smaller version.`, "memory");
    }
}

/** A stream that yields `first`, then the rest of `reader`, counting the bytes of every later chunk. */
function prepend(first, reader, count) {
    let pending = first;
    return new ReadableStream({
        async pull(controller) {
            if (pending) {
                controller.enqueue(pending);
                pending = null;
                return;
            }
            const {done, value} = await reader.read();
            if (done) {
                controller.close();
                return;
            }
            count(value.byteLength);
            controller.enqueue(value);
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
}

/** Read chunks until at least `minimum` bytes arrived or the stream ended; returns them joined. */
async function readHead(reader, signal, minimum) {
    const chunks = [];
    let length = 0, ended = false;
    while (length < minimum) {
        const {done, value} = await reader.read();
        if (signal?.aborted) throw aborted();
        if (done) {
            ended = true;
            break;
        }
        chunks.push(value);
        length += value.byteLength;
    }
    return {head: concat(chunks, length), ended};
}

/** Copy the HEXVIEW1 bundle that starts with `head` into one exactly sized buffer, validating the header first. */
async function assemble(head, reader, ended, signal, report) {
    let pending = head;
    const more = async () => {
        if (ended) return false;
        const {done, value} = await reader.read();
        if (signal?.aborted) throw aborted();
        if (done) {
            ended = true;
            return false;
        }
        pending = concat([pending, value], pending.byteLength + value.byteLength);
        return true;
    };
    while (pending.byteLength < 12 && await more());
    if (pending.byteLength < 12) throw new LoadError("The file ended inside its header; it is not a complete Hexels bundle.", "format");
    const jsonLength = new DataView(pending.buffer, pending.byteOffset, pending.byteLength).getUint32(8, true);
    if (jsonLength % 4 || jsonLength > HEADER_LIMIT) throw new LoadError("The bundle header is damaged.", "format");
    while (pending.byteLength < 12 + jsonLength && await more());
    if (pending.byteLength < 12 + jsonLength) throw new LoadError("The file ended inside its header; it is not a complete Hexels bundle.", "format");
    const total = bundleLength(pending, jsonLength);
    if (pending.byteLength > total) throw new LoadError("The file is longer than its header says; it may be damaged.", "format");
    const bytes = allocate(total);
    bytes.set(pending);
    let written = pending.byteLength;
    pending = null;
    report(written, total);
    while (!ended) {
        const {done, value} = await reader.read();
        if (signal?.aborted) throw aborted();
        if (done) break;
        if (written + value.byteLength > total) throw new LoadError("The file is longer than its header says; it may be damaged.", "format");
        bytes.set(value, written);
        written += value.byteLength;
        report(written, total);
    }
    if (written !== total) throw new LoadError(`The data stopped early: ${megabytes(written)} of ${megabytes(total)} arrived. Try again.`, "network");
    return bytes.buffer;
}

/** Shrink a buffer to its first `length` bytes, without a copy where the browser can (ArrayBuffer.transfer). */
function fitted(buffer, length) {
    if (length === buffer.byteLength) return buffer;
    return typeof buffer.transfer === "function" ? buffer.transfer(length) : buffer.slice(0, length);
}

/** Collect a whole ZIP archive that starts with `head` into one buffer; `expected` is its size when known. */
async function collect(head, reader, ended, expected, signal, report) {
    let capacity = Math.max(expected || 0, head.byteLength, MINIMUM_CAPACITY);
    let bytes = allocate(capacity);
    bytes.set(head);
    let written = head.byteLength;
    report(written, expected);
    while (!ended) {
        const {done, value} = await reader.read();
        if (signal?.aborted) throw aborted();
        if (done) break;
        if (written + value.byteLength > capacity) {
            // More data than announced, for example a compressed transfer: grow with headroom, keeping what arrived.
            capacity = Math.max(Math.ceil(capacity * 1.5), written + value.byteLength);
            const grown = allocate(capacity);
            grown.set(bytes.subarray(0, written));
            bytes = grown;
        }
        bytes.set(value, written);
        written += value.byteLength;
        report(written, expected);
    }
    return {buffer: fitted(bytes.buffer, written), received: written};
}

/**
 * Read a whole model from `stream`. Returns {format: "hexview" | "hexcodec", buffer, received, expected}, where
 * received is the byte count that arrived and expected the announced size (null when unknown).
 * `onProgress({fraction, done, size})` reports the share finished (null until known) and the bytes behind it:
 * transfer bytes for gzip files inflated here, otherwise model bytes. `transferBytes` is the expected download
 * size when the stream cannot tell, and `local` marks a File stream, whose failures are read errors rather than
 * network errors.
 */
export async function readModel(stream, {transferBytes = null, local = false, signal = null, onProgress = () => {}} = {}) {
    if (!stream) throw new LoadError("The server sent an empty response.", "http");
    const source = stream.getReader();
    const cancel = () => { source.cancel().catch(error => console.debug("Stream cancel:", error)); };
    signal?.addEventListener("abort", cancel, {once: true});
    let received = 0, gzip = false;
    const report = (written, total) => {
        const size = gzip ? transferBytes : total || transferBytes;
        const done = gzip ? received : written;
        const fraction = size ? done / size : null;
        onProgress({fraction: fraction === null ? null : Math.min(1, Math.max(0, fraction)), done, size});
    };
    try {
        const first = await readHead(source, signal, 2);
        received = first.head.byteLength;
        if (!received) throw new LoadError("The file is empty.", "format");
        gzip = first.head[0] === 0x1f && first.head[1] === 0x8b;
        let body = prepend(first.head, source, count => { received += count; });
        if (gzip) {
            if (typeof DecompressionStream !== "function") {
                throw new LoadError("This browser cannot open compressed (.gz) models. Update it (Chrome or Edge 80+, Safari 16.4+, Firefox 114+) or open an uncompressed .hexview.", "unsupported");
            }
            body = body.pipeThrough(new DecompressionStream("gzip"));
        }
        const reader = body.getReader();
        const {head, ended} = await readHead(reader, signal, SNIFF_BYTES);
        if (text(head, 0, 8) === MAGIC) {
            const buffer = await assemble(head, reader, ended, signal, report);
            return {format: "hexview", buffer, received: buffer.byteLength, expected: buffer.byteLength};
        }
        if (text(head, 0, 4) === ZIP_MAGIC) {
            const member = firstZipMember(head);
            if (member !== null && /(^|\/)data\.pkl$/.test(member)) throw new LoadError(CHECKPOINT_MESSAGE, "format");
            const expected = gzip ? null : transferBytes;
            const archive = await collect(head, reader, ended, expected, signal, report);
            return {format: "hexcodec", ...archive, expected};
        }
        if (!head.byteLength) throw new LoadError("The file is empty.", "format");
        throw new LoadError(foreignFileMessage(head), "format");
    } catch (error) {
        if (signal?.aborted) throw aborted();
        if (error instanceof LoadError) throw error;
        console.error(error);
        const unreadable = error?.name === "NotReadableError" || error?.name === "NotFoundError";
        if (gzip && !unreadable && (local || GZIP_DATA_ERROR.test(String(error?.message)))) throw new LoadError("The compressed file is damaged or incomplete.", "format");
        if (local) throw new LoadError("The file could not be read. It may have been moved or changed while opening.", "file");
        throw new LoadError("The connection was interrupted while downloading the model. Try again.", "network");
    } finally {
        signal?.removeEventListener("abort", cancel);
    }
}

function networkMessage(url) {
    if (navigator.onLine === false) return "You appear to be offline. Reconnect and try again.";
    const target = new URL(url, location.href);
    if (target.origin === location.origin) return "Could not download the model. Check your connection and try again.";
    return `Could not download the model from ${target.host}. Check your connection; that server must also allow this page to read the file (CORS).`;
}

function httpMessage(status) {
    if (status === 404) return "The model file was not found (HTTP 404). It may not be uploaded yet.";
    if (status === 403) return "Access to the model file was denied (HTTP 403).";
    return `The model download failed (HTTP ${status}).`;
}

/** Download and read a model; `transferBytes` is the expected size when the server sends no Content-Length. */
export async function fetchModel(url, {transferBytes = null, signal = null, onProgress} = {}) {
    let response;
    try {
        response = await fetch(url, {signal});
    } catch (error) {
        if (signal?.aborted) throw aborted();
        // Offline or blocked by CORS: the browser logs the cause itself and the visitor gets the message below.
        console.info("Model download failed:", error);
        throw new LoadError(networkMessage(url), "network");
    }
    if (!response.ok) throw new LoadError(httpMessage(response.status), response.status === 404 ? "not-found" : "http");
    const length = Number(response.headers.get("Content-Length"));
    return readModel(response.body, {transferBytes: length > 0 ? length : transferBytes, signal, onProgress});
}

/** Read a model from a local File; nothing leaves the device. */
export function readFileModel(file, {signal = null, onProgress} = {}) {
    const stream = typeof file.stream === "function" ? file.stream() : new Response(file).body;
    return readModel(stream, {transferBytes: file.size, local: true, signal, onProgress});
}
