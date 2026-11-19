import { readBsp, readWad } from './bsp.js';
import { buildMesh, VERTEX_FLOATS } from './mesh.js';
import { shaderSource, compile, program, rgbaPixels } from './gl-resources.js';

const SKY_SIDES = {
  rt: 'uRt', lf: 'uLf', ft: 'uFt', bk: 'uBk', up: 'uUpSide', dn: 'uDn',
};
const DEBUG_MODES = { final: 0, albedo: 1, lightmap: 2, normals: 3, missing: 4 };

function setSampling(gl, hasMips, wraps) {
  const target = gl.TEXTURE_2D;
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, wraps ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, wraps ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, hasMips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
}

function drawCamera(gl, camera, eye, forward, right, up, projection) {
  gl.uniform3fv(camera.eye, eye);
  gl.uniform3fv(camera.forward, forward);
  gl.uniform3fv(camera.right, right);
  gl.uniform3fv(camera.up, up);
  gl.uniform2fv(camera.projection, projection);
  const near = 1;
  const far = 16384;
  gl.uniform2f(camera.depth, (far + near) / (far - near), -2 * far * near / (far - near));
}

function cameraUniforms(shader) {
  return { eye: shader.uniform('uEye'), forward: shader.uniform('uForward'),
    right: shader.uniform('uRight'), up: shader.uniform('uUp'),
    projection: shader.uniform('uProjection'), depth: shader.uniform('uDepth') };
}

export async function createRenderer(canvas, bspBuffer, wadBuffers = [], skyImages = {}) {
  const bsp = readBsp(bspBuffer);
  const textures = new Map();
  for (const buffer of wadBuffers) {
    for (const [name, texture] of readWad(buffer)) {
      if (!textures.has(name)) textures.set(name, texture);
    }
  }
  for (const texture of bsp.textures) {
    if (texture?.levels.length) textures.set(texture.name, texture);
  }
  const sources = await Promise.all(['bsp.vert', 'bsp.frag', 'sky.frag'].map(shaderSource));
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: true, depth: true });
  if (!gl) throw new Error('WebGL 2 is required to render a BSP map.');
  const atlasSize = Math.min(1024, gl.getParameter(gl.MAX_TEXTURE_SIZE));
  const mesh = buildMesh(bsp, textures, atlasSize);
  const gpuTextures = [];
  const gpuPrograms = [];
  const gpuShaders = [];
  let buffer;
  let vao;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const handle of gpuTextures) gl.deleteTexture(handle);
    for (const handle of gpuPrograms) gl.deleteProgram(handle);
    for (const handle of gpuShaders) gl.deleteShader(handle);
    if (vao) gl.deleteVertexArray(vao);
    if (buffer) gl.deleteBuffer(buffer);
  };
  const makeTexture = () => {
    const id = gl.createTexture();
    gpuTextures.push(id);
    gl.bindTexture(gl.TEXTURE_2D, id);
    return id;
  };
  const bindTexture = (unit, id) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, id);
  };
  const uploadRGBA = (level, width, height, bytes) => {
    gl.texImage2D(gl.TEXTURE_2D, level, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  };

  try {
    const vertex = compile(gl, gl.VERTEX_SHADER, sources[0]);
    gpuShaders.push(vertex);
    const world = program(gl, vertex, sources[1]);
    gpuPrograms.push(world.id);
    const sky = program(gl, vertex, sources[2]);
    gpuPrograms.push(sky.id);
    const worldCamera = cameraUniforms(world);
    const skyCamera = cameraUniforms(sky);
    const state = {
      tint: world.uniform('uTint'), alpha: world.uniform('uAlpha'), blend: world.uniform('uBlend'),
      masked: world.uniform('uMasked'), decal: world.uniform('uDecal'), debug: world.uniform('uDebug'),
      missing: world.uniform('uMissing'),
    };

    const lightmaps = mesh.pages.map(({ pixels }) => {
      const id = makeTexture();
      uploadRGBA(0, atlasSize, atlasSize, pixels);
      setSampling(gl, false, false);
      return id;
    });
    const mipTextures = new Map();
    const uploadMip = (texture, decal) => {
      const key = JSON.stringify([texture.name, decal]);
      if (mipTextures.has(key)) return mipTextures.get(key);
      const id = makeTexture();
      texture.levels.forEach((level, index) => {
        uploadRGBA(index, level.width, level.height, rgbaPixels(texture, level, decal));
      });
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, texture.levels.length - 1);
      setSampling(gl, texture.levels.length > 1, !decal);
      mipTextures.set(key, id);
      return id;
    };

    const fallback = makeTexture();
    const checker = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < 64; i++) {
      const color = (i % 8 < 4) === (i < 32) ? [150, 115, 144, 255] : [68, 57, 66, 255];
      checker.set(color, i * 4);
    }
    uploadRGBA(0, 8, 8, checker);
    setSampling(gl, false, true);

    const allBatches = [...mesh.opaque, ...mesh.transparent, ...mesh.decals, mesh.sky];
    const vertexLength = allBatches.reduce((sum, batch) => sum + batch.vertices.length, 0);
    const vertexData = new Float32Array(vertexLength);
    let offset = 0;
    for (const batch of allBatches) {
      batch.first = offset / VERTEX_FLOATS;
      batch.count = batch.vertices.length / VERTEX_FLOATS;
      vertexData.set(batch.vertices, offset);
      offset += batch.vertices.length;
      delete batch.vertices;
      if (!batch.texture) continue;
      const animated = /^\+([0-9])(.*)$/.exec(batch.name);
      if (animated && !mesh.decals.includes(batch)) {
        batch.animation = [];
        for (let frame = 0; frame < 10; frame++) {
          const texture = textures.get(`+${frame}${animated[2]}`);
          if (!texture) break;
          batch.animation.push(uploadMip(texture, false));
        }
      }
      batch.id = uploadMip(batch.texture, mesh.decals.includes(batch));
    }

    vao = gl.createVertexArray();
    buffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW);
    const stride = VERTEX_FLOATS * Float32Array.BYTES_PER_ELEMENT;
    for (const [index, count, start] of [[0, 3, 0], [1, 2, 3], [2, 2, 5], [3, 3, 7]]) {
      gl.enableVertexAttribArray(index);
      gl.vertexAttribPointer(index, count, gl.FLOAT, false, stride, start * Float32Array.BYTES_PER_ELEMENT);
    }
    gl.bindVertexArray(null);

    const hasSky = Object.keys(SKY_SIDES).every(key => skyImages[key]);
    gl.useProgram(sky.id);
    gl.uniform1i(sky.uniform('uHasSky'), Number(hasSky));
    const skyTextures = Object.entries(SKY_SIDES).map(([side, uniform], index) => {
      gl.uniform1i(sky.uniform(uniform), index);
      if (!hasSky) return fallback;
      const id = makeTexture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, skyImages[side]);
      setSampling(gl, false, false);
      return id;
    });
    gl.useProgram(world.id);
    gl.uniform1i(world.uniform('uAlbedo'), 0);
    gl.uniform1i(world.uniform('uLightmap'), 1);
    const glError = gl.getError();
    if (glError !== gl.NO_ERROR) throw new Error(`WebGL initialization failed (0x${glError.toString(16)}).`);

    function draw(eye, yaw, pitch, fov = 90, debug = 0) {
      if (disposed || !canvas.width || !canvas.height) return;
      const sy = Math.sin(yaw), cy = Math.cos(yaw);
      const sp = Math.sin(pitch), cp = Math.cos(pitch);
      const forward = [cp * cy, cp * sy, sp];
      const right = [sy, -cy, 0];
      const up = [-sp * cy, -sp * sy, cp];
      const aspect = canvas.width / canvas.height;
      const sx = 1 / Math.tan(Math.min(179, Math.max(1, fov)) * Math.PI / 360);
      const projection = [sx, sx * aspect];
      const frame = Math.floor(performance.now() / 100);
      const mode = typeof debug === 'string' ? (DEBUG_MODES[debug] ?? 0) : (debug | 0);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.clearColor(0.055, 0.06, 0.07, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.bindVertexArray(vao);
      if (mesh.sky.count) {
        gl.useProgram(sky.id);
        drawCamera(gl, skyCamera, eye, forward, right, up, projection);
        skyTextures.forEach((id, unit) => bindTexture(unit, id));
        gl.drawArrays(gl.TRIANGLES, mesh.sky.first, mesh.sky.count);
      }

      gl.useProgram(world.id);
      drawCamera(gl, worldCamera, eye, forward, right, up, projection);
      gl.uniform1i(state.debug, mode);
      const drawBatch = batch => {
        const animation = batch.animation;
        bindTexture(0, (animation?.length ? animation[frame % animation.length] : batch.id) ?? fallback);
        bindTexture(1, lightmaps[batch.page]);
        gl.uniform3fv(state.tint, batch.tint);
        gl.uniform1f(state.alpha, batch.alpha);
        gl.uniform1i(state.blend, batch.blend);
        gl.uniform1i(state.masked, Number(Boolean(batch.masked)));
        gl.uniform1i(state.missing, Number(Boolean(batch.missing)));
        gl.drawArrays(gl.TRIANGLES, batch.first, batch.count);
      };
      gl.uniform1i(state.decal, 0);
      for (const batch of mesh.opaque) drawBatch(batch);

      gl.enable(gl.BLEND);
      gl.depthMask(false);
      if (mesh.decals.length && mode === 0) {
        gl.uniform1i(state.decal, 1);
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(-1, -1);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        for (const batch of mesh.decals) drawBatch(batch);
        gl.disable(gl.POLYGON_OFFSET_FILL);
        gl.uniform1i(state.decal, 0);
      }
      const distance = batch => batch.center[0] * forward[0] + batch.center[1] * forward[1]
        + batch.center[2] * forward[2];
      mesh.transparent.sort((a, b) => distance(b) - distance(a));
      for (const batch of mesh.transparent) {
        gl.blendFunc(gl.SRC_ALPHA, batch.blend === 5 || batch.blend === 3 ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
        drawBatch(batch);
      }
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
    }

    return {
      draw, dispose, entities: bsp.entities, models: bsp.models, worldspawn: bsp.worldspawn,
      stats: { ...mesh.stats, triangles: vertexLength / VERTEX_FLOATS / 3, hasSky },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
