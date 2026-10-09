import {vertex, fragment, screenVertex, screenFragment} from "./shaders.js";

const UPLOAD_BAND_ROWS = 512;

/** An Error with a kind (texture or memory) that the loader reports to the page. */
function failure(message, kind) {
    const error = new Error(message);
    error.kind = kind;
    return error;
}

/** True when `texels` model texels fit the texture layout of load() under this GPU's MAX_TEXTURE_SIZE. */
export function fitsTexture(texels, maximum) {
    const width = Math.min(maximum, Math.max(2048, 2 ** Math.ceil(Math.log2(Math.sqrt(texels)))));
    return Math.ceil(texels / width) <= maximum;
}

function program(gl, vertexSource, fragmentSource) {
    const result = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        gl.attachShader(result, shader);
        gl.deleteShader(shader);
    }
    gl.linkProgram(result);
    if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result));
    return result;
}

export class HexelRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        // No preserveDrawingBuffer: keeping the buffer costs a full-frame copy on every frame. "Save image" draws the
        // view again and reads the canvas in the same task instead (app.js).
        this.gl = canvas.getContext("webgl2", {alpha: false, antialias: false, depth: false});
        if (!this.gl) throw new Error("This viewer needs WebGL2. Enable hardware acceleration or try a current browser.");
        const gl = this.gl;
        this.floatTarget = Boolean(gl.getExtension("EXT_color_buffer_float"));
        this.float32Blend = this.floatTarget && Boolean(gl.getExtension("EXT_float_blend"));
        this.drawProgram = program(gl, vertex, fragment);
        this.screenProgram = program(gl, screenVertex, screenFragment);
        this.modelTexture = gl.createTexture();
        this.frameTexture = gl.createTexture();
        this.framebuffer = gl.createFramebuffer();
        this.order = gl.createBuffer();
        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.order);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 4, 0);
        gl.vertexAttribDivisor(0, 1);
        this.visible = 0;
        this.locations = new Map();
        for (const target of [this.drawProgram, this.screenProgram]) {
            const names = target === this.drawProgram
                ? ["model", "textureWidth", "texels", "basisCount", "view", "cameraPosition", "viewport", "focal", "prefilter", "conservativeBounds", "mode", "depthScale"]
                : ["accumulated", "background"];
            this.locations.set(target, Object.fromEntries(names.map(name => [name, gl.getUniformLocation(target, name)])));
        }
    }

    texture(texture) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    // Uploads straight from the bundle rows: immutable storage, then whole texture rows in bands and the
    // partial last row, so no padded copy of the model is made in JavaScript. A new model replaces the texture.
    // Nothing is drawn until setOrder() brings the first depth-sorted order: primitives drawn in storage order
    // would flash a garbled frame on large models.
    load(metadata, rows) {
        const gl = this.gl;
        this.metadata = metadata;
        const maximum = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        this.textureWidth = Math.min(maximum, Math.max(2048, 2 ** Math.ceil(Math.log2(Math.sqrt(rows.length / 4)))));
        const texels = rows.length / 4;
        const height = Math.ceil(texels / this.textureWidth);
        if (height > maximum) {
            throw failure(`This model needs a ${this.textureWidth}×${height} texture, but this GPU allows at most ${maximum}×${maximum} (MAX_TEXTURE_SIZE). Choose a smaller version of the scene, or use a computer with a larger GPU limit.`, "texture");
        }
        gl.deleteTexture(this.modelTexture);
        this.modelTexture = gl.createTexture();
        this.texture(this.modelTexture);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, this.textureWidth, height);
        const fullRows = Math.floor(texels / this.textureWidth);
        for (let row = 0; row < fullRows; row += UPLOAD_BAND_ROWS) {
            const band = Math.min(UPLOAD_BAND_ROWS, fullRows - row);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, this.textureWidth, band, gl.RGBA, gl.FLOAT, rows, row * this.textureWidth * 4);
        }
        const remainder = texels - fullRows * this.textureWidth;
        if (remainder) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, fullRows, remainder, 1, gl.RGBA, gl.FLOAT, rows, fullRows * this.textureWidth * 4);
        this.visible = 0;
        if (gl.getError() !== gl.NO_ERROR) throw failure("The GPU could not store the model, probably for lack of graphics memory. Choose a smaller version of the scene or close other tabs.", "memory");
    }

    setOrder(order) {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.order);
        gl.bufferData(gl.ARRAY_BUFFER, order, gl.DYNAMIC_DRAW);
        this.visible = order.length;
    }

    resize(width, height) {
        if (width === this.canvas.width && height === this.canvas.height && this.allocated) return;
        const gl = this.gl;
        const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        if (width > limit || height > limit) throw new Error("Viewport exceeds GPU texture limits");
        this.canvas.width = width; this.canvas.height = height;
        this.texture(this.frameTexture);
        const format = this.float32Blend ? gl.RGBA32F : this.floatTarget ? gl.RGBA16F : gl.RGBA8;
        const type = this.float32Blend ? gl.FLOAT : this.floatTarget ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
        gl.texImage2D(gl.TEXTURE_2D, 0, format, width, height, 0, gl.RGBA, type, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.frameTexture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Offscreen framebuffer is unsupported");
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.allocated = true;
    }

    render(camera, mode, depthScale, clip = null) {
        const gl = this.gl;
        const width = this.canvas.width, height = this.canvas.height;
        gl.viewport(0, 0, width, height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE, gl.ONE_MINUS_DST_ALPHA, gl.ONE);
        gl.useProgram(this.drawProgram);
        gl.bindVertexArray(this.vao);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.modelTexture);
        const uniforms = this.locations.get(this.drawProgram);
        gl.uniform1i(uniforms.model, 0);
        gl.uniform1i(uniforms.textureWidth, this.textureWidth);
        gl.uniform1i(uniforms.texels, this.metadata.texels);
        gl.uniform1i(uniforms.basisCount, this.metadata.basis_count);
        gl.uniformMatrix4fv(uniforms.view, false, camera.view);
        gl.uniform3fv(uniforms.cameraPosition, camera.position);
        gl.uniform2f(uniforms.viewport, width, height);
        const focal = height / (2 * Math.tan(camera.fov * Math.PI / 360));
        gl.uniform2f(uniforms.focal, focal, focal);
        gl.uniform1i(uniforms.prefilter, this.metadata.prefilter);
        gl.uniform1i(uniforms.conservativeBounds, Boolean(this.metadata.conservative_bounds));
        gl.uniform1i(uniforms.mode, mode);
        gl.uniform1f(uniforms.depthScale, depthScale);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.visible);
        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindVertexArray(null);
        gl.useProgram(this.screenProgram);
        gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
        const screen = this.locations.get(this.screenProgram);
        gl.uniform1i(screen.accumulated, 0);
        gl.uniform3fv(screen.background, mode === 0 ? this.metadata.background : [0, 0, 0]);
        if (clip) { gl.enable(gl.SCISSOR_TEST); gl.scissor(clip[0], 0, clip[1], height); }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.disable(gl.SCISSOR_TEST);
    }
}
