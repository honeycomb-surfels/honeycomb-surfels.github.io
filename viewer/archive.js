/**
 * Decoding of .hexcodec deployment archives off the main thread.
 *
 * hexcodec-worker.js runs decodeHexcodec (hexcodec.js) in a module Web Worker: it receives the whole archive
 * (transferred, not copied), reports progress per stage ({type: "progress", stage: "unzip" | "decode" | "pack",
 * fraction}) and answers with {type: "done", rows, meta}, where rows (transferred back) and meta are exactly what
 * core.js parseBundle returns for the equivalent HEXVIEW1 bundle, or with {type: "error", message, kind?}. Archives
 * store their members with DEFLATE, which the decoder inflates with the browser's DecompressionStream("gzip").
 */
import {LoadError, aborted} from "./stream.js";

export const ARCHIVE_STAGES = {
    unzip: "Unpacking the archive",
    decode: "Decoding the model",
    pack: "Packing Hexels for the GPU",
};

const UPDATE_HINT = "Update the browser (Chrome or Edge 80+, Safari 16.4+, Firefox 114+), or open a .hexview bundle instead.";
const MEMORY_ERROR = /allocat|out of memory|array buffer|invalid array length|invalid typed array length|RangeError/i;

/** Null when this browser can inflate .hexcodec archives, else a visitor-facing reason. */
export function archiveSupport() {
    if (typeof DecompressionStream !== "function") return `This browser cannot unpack compressed Hexels archives (no DecompressionStream). ${UPDATE_HINT}`;
    try {
        new DecompressionStream("gzip");
    } catch (error) {
        console.info(`gzip decompression unavailable: ${error.message}`);
        return `This browser cannot unpack compressed Hexels archives (no gzip decompression). ${UPDATE_HINT}`;
    }
    if (typeof Worker !== "function") return "This browser cannot run background workers, which the viewer needs to unpack models.";
    return null;
}

/** A LoadError from the decoder's message and kind (format, unsupported, memory; older workers send no kind). */
function decodeError(message, kind) {
    const text = String(message || "unknown error");
    if (kind === "memory" || MEMORY_ERROR.test(text)) {
        return new LoadError(`This device ran out of memory while unpacking the model (${text.replace(/\.$/, "")}). Close other tabs or choose a smaller version.`, "memory");
    }
    if (kind === "unsupported") return new LoadError(text, "unsupported");
    return new LoadError(/archive|hexcodec/i.test(text) ? text : `This archive could not be decoded: ${text.replace(/\.$/, "")}.`, "format");
}

/** Structural checks before the rows reach the GPU; the decoder itself validates values. */
function checked({rows, meta}) {
    const count = meta?.count;
    if (!(rows instanceof Float32Array) || !meta || !Number.isSafeInteger(count) || count < 1) {
        throw new LoadError("The archive decoder returned no primitives.", "format");
    }
    if (![0, 3, 15].includes(meta.basis_count) || meta.texels !== 6 + meta.basis_count || rows.length !== count * meta.texels * 4) {
        throw new LoadError("The archive decoder returned an unsupported primitive layout.", "format");
    }
    return {rows, meta};
}

/**
 * Decode `buffer` (an ArrayBuffer holding a whole .hexcodec archive; it is transferred to the worker and unusable
 * afterwards). `onStage(stage, fraction)` follows the decoder's stages; aborting `signal` stops the worker at once.
 */
export function decodeArchive(buffer, {signal = null, onStage = () => {}} = {}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(aborted());
            return;
        }
        let worker;
        try {
            worker = new Worker(new URL("./hexcodec-worker.js", import.meta.url), {type: "module"});
        } catch (error) {
            console.error(error);
            reject(new LoadError("This browser cannot start the archive decoder (a module Web Worker). " + UPDATE_HINT, "unsupported"));
            return;
        }
        let settled = false;
        const settle = (callback, value) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", stop);
            worker.terminate();
            callback(value);
        };
        const stop = () => settle(reject, aborted());
        signal?.addEventListener("abort", stop, {once: true});
        worker.onmessage = ({data}) => {
            if (data?.type === "progress") {
                if (!settled) onStage(data.stage, Number.isFinite(data.fraction) ? Math.min(1, Math.max(0, data.fraction)) : null);
                return;
            }
            if (data?.type === "done") {
                try {
                    settle(resolve, checked(data));
                } catch (error) {
                    settle(reject, error);
                }
                return;
            }
            if (data?.type === "error") settle(reject, data.kind === "aborted" ? aborted() : decodeError(data.message, data.kind));
        };
        worker.onerror = event => {
            event.preventDefault?.();
            console.error("Archive decoder failed:", event.message || event);
            settle(reject, event.message && MEMORY_ERROR.test(event.message)
                ? decodeError(event.message)
                : new LoadError("The archive decoder could not run in this browser. " + UPDATE_HINT, "unsupported"));
        };
        worker.onmessageerror = () => settle(reject, new LoadError("The decoded model could not be handed to the viewer, possibly for lack of memory.", "memory"));
        worker.postMessage({type: "decode", buffer}, [buffer]);
    });
}
