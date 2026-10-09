/**
 * Module Web Worker that decodes one .hexcodec archive off the main thread (viewer/archive.js starts it).
 *
 * Post {type: "decode", buffer, name?} with the archive's ArrayBuffer in the transfer list; a bare ArrayBuffer, or
 * {type: "decode", file} with a Blob or File, works too. While decoding, the worker posts
 * {type: "progress", stage: "unzip" | "decode" | "pack", fraction}, the stages in that order and each fraction
 * from 0 to 1. It ends with {type: "done", rows, meta}, rows being a Float32Array whose buffer is transferred
 * back and meta the bundle metadata (see hexcodec.js), or with {type: "error", message, kind}, kind being format,
 * unsupported, memory or aborted. Replies repeat the request's id when it has one. One archive per worker;
 * terminate the worker to cancel.
 */
import {HexcodecError, decodeHexcodec} from "./hexcodec.js";

/** Take the archive out of the request, so the decoder holds the only reference and can let it go once unpacked. */
async function takeArchive(request) {
    if (request instanceof ArrayBuffer || ArrayBuffer.isView(request)) return request;
    if (!request || typeof request !== "object") throw new Error("Send the .hexcodec archive as an ArrayBuffer.");
    if (request.type !== undefined && request.type !== "decode") throw new Error(`Unknown request type ${request.type}.`);
    const {buffer, file} = request;
    request.buffer = request.file = null;
    if (buffer instanceof ArrayBuffer || ArrayBuffer.isView(buffer)) return buffer;
    if (typeof Blob === "function" && file instanceof Blob) return file.arrayBuffer();
    throw new Error("Send the .hexcodec archive as an ArrayBuffer.");
}

function kindOf(error) {
    if (typeof error?.kind === "string") return error.kind;
    return error instanceof RangeError ? "memory" : "format";
}

self.onmessage = async event => {
    const request = event.data;
    const id = request && typeof request === "object" && !ArrayBuffer.isView(request) ? request.id : undefined;
    const reply = (message, transfer = []) => self.postMessage(id === undefined ? message : {...message, id}, transfer);
    try {
        const name = typeof request?.name === "string" ? request.name : null;
        const {rows, meta} = await decodeHexcodec(await takeArchive(request), {
            name,
            onProgress: ({stage, fraction}) => reply({type: "progress", stage, fraction}),
        });
        reply({type: "done", rows, meta}, [rows.buffer]);
    } catch (error) {
        const kind = kindOf(error);
        // Damaged, unsupported or too large archives are expected and shown to the visitor; only bugs are errors.
        if (error instanceof HexcodecError || kind === "memory") console.info(`Archive not decoded (${kind}): ${error?.message || error}`);
        else console.error(error);
        const message = kind === "memory" && !/memory/i.test(String(error?.message))
            ? `Out of memory while decoding the archive (${error?.message || error}).`
            : String(error?.message || error);
        reply({type: "error", message, kind});
    }
};
