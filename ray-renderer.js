import { readBsp, readWad } from "./bsp.js";
import { buildMesh } from "./mesh.js";
import { shaderSource, compile, program } from "./gl-resources.js";
import { buildRayTree } from "./ray-tree.js";
import { packRayMaterials } from "./ray-materials.js";

const tableWidth = 1024;
const skyOrder = ["rt", "lf", "ft", "bk", "up", "dn"];
function rows(values) {
  const height = Math.ceil(values.length / (tableWidth * 4));
  const data = new Float32Array(tableWidth * height * 4);
  data.set(values);
  return { height, data };
}

export async function createRayRenderer(canvas, map, wads, skyImages) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: true,
    depth: true,
  });
  if (!gl) throw new Error("The fullscreen scene shader requires WebGL 2.");
  const bsp = readBsp(map);
  const textures = new Map();
  for (const wad of wads)
    for (const [name, tex] of readWad(wad))
      if (!textures.has(name)) textures.set(name, tex);
  for (const tex of bsp.textures)
    if (tex?.levels.length) textures.set(tex.name, tex);
  const lightSize = 1024;
  const mesh = buildMesh(bsp, textures, lightSize);
  if (
    mesh.transparent.length ||
    mesh.decals.length ||
    mesh.opaque.some((b) => b.masked)
  )
    throw new Error(
      "This ray shader supports opaque BSP materials and sky. This map has other surface types.",
    );
  const tree = buildRayTree(mesh);
  const material = packRayMaterials(mesh.opaque);
  const sources = await Promise.all(
    ["fullscreen.vert", "scene-ray.frag"].map(shaderSource),
  );
  const vertex = compile(gl, gl.VERTEX_SHADER, sources[0]);
  const resources = [];
  let pipeline, vao;
  function dispose() {
    for (const id of resources) gl.deleteTexture(id);
    gl.deleteShader(vertex);
    if (pipeline) gl.deleteProgram(pipeline.id);
    if (vao) gl.deleteVertexArray(vao);
  }
  try {
    pipeline = program(gl, vertex, sources[1]);
    gl.useProgram(pipeline.id);
    const samplers = [];
    function texture(name, target, filter) {
      const id = gl.createTexture(),
        unit = samplers.length;
      resources.push(id);
      samplers.push({ unit, target, id });
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, id);
      gl.uniform1i(pipeline.uniform(name), unit);
      for (const kind of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
        gl.texParameteri(target, kind, filter);
      for (const axis of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
        gl.texParameteri(target, axis, gl.CLAMP_TO_EDGE);
    }
    function upload2D(name, width, height, pixels, floating = false) {
      texture(name, gl.TEXTURE_2D, floating ? gl.NEAREST : gl.LINEAR);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        floating ? gl.RGBA32F : gl.RGBA8,
        width,
        height,
        0,
        gl.RGBA,
        floating ? gl.FLOAT : gl.UNSIGNED_BYTE,
        pixels,
      );
    }
    for (const [uniform, array] of [
      ["uNodes", tree.nodeData],
      ["uTriangles", tree.triangleData],
      ["uAttributes", tree.attributeData],
    ]) {
      const { height, data } = rows(array);
      upload2D(uniform, tableWidth, height, data, true);
    }
    upload2D("uMaterials", material.width, material.height, material.pixels);
    upload2D("uMaterialInfo", 4, mesh.opaque.length, material.metadata, true);
    function layers(name, width, height, images) {
      const target = gl.TEXTURE_2D_ARRAY;
      texture(name, target, gl.LINEAR);
      gl.texStorage3D(target, 1, gl.RGBA8, width, height, images.length);
      images.forEach((pixels, i) =>
        gl.texSubImage3D(
          target,
          0,
          0,
          0,
          i,
          width,
          height,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels,
        ),
      );
    }
    layers(
      "uLightmaps",
      lightSize,
      lightSize,
      mesh.pages.map((page) => page.pixels),
    );
    layers(
      "uSky",
      skyImages.rt.width,
      skyImages.rt.height,
      skyOrder.map((id) => skyImages[id]),
    );
    const rifle = await createImageBitmap(await (await fetch("assets/ak-front.avif")).blob());
    texture("uRifle", gl.TEXTURE_2D, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, rifle);
    rifle.close();
    gl.uniform1i(pipeline.uniform("uNodesCount"), tree.nodeCount);
    const uniforms = Object.fromEntries(
      [
        "uEye",
        "uForward",
        "uRight",
        "uUp",
        "uSize",
        "uTanHalfFov",
        "uDebug",
        "uShot",
        "uDown",
      ].map((n) => [n, pipeline.uniform(n)]),
    );
    vao = gl.createVertexArray();
    const error = gl.getError();
    if (error !== gl.NO_ERROR)
      throw new Error("Ray scene upload failed with WebGL error " + error);
    const debugModes = {
      final: 0,
      albedo: 1,
      lightmap: 2,
      normals: 3,
      missing: 4,
    };
    const respawn = new Float64Array(8);
    function draw(eye, yaw, pitch, fov = 90, debug = 0, shot = -1) {
      const cy = Math.cos(yaw),
        sy = Math.sin(yaw),
        cp = Math.cos(pitch),
        sp = Math.sin(pitch);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.BLEND);
      gl.useProgram(pipeline.id);
      for (const { unit, target, id } of samplers) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(target, id);
      }
      const now = performance.now();
      gl.uniform1i(uniforms.uDown,respawn.reduce((mask,time,i)=>time>now ? mask|(1<<i) : mask,0));
      gl.uniform1f(uniforms.uShot, shot);
      gl.uniform3fv(uniforms.uEye, eye);
      gl.uniform3f(uniforms.uForward, cy * cp, sy * cp, sp);
      gl.uniform3f(uniforms.uRight, sy, -cy, 0);
      gl.uniform3f(uniforms.uUp, -cy * sp, -sy * sp, cp);
      gl.uniform2f(uniforms.uSize, canvas.width, canvas.height);
      gl.uniform1f(uniforms.uTanHalfFov, Math.tan((Math.max(1, Math.min(179, fov)) * Math.PI) / 360));
      gl.uniform1i(
        uniforms.uDebug,
        typeof debug === "string" ? (debugModes[debug] ?? 0) : debug,
      );
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    }
    return {
      draw,
      resetTargets() { respawn.fill(0); },
      shoot(eye,yaw,pitch) {
        const pixel=new Uint8Array(4);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0,0,1,1);
        try {
          draw(eye,yaw,pitch,90,0,-2);
          gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
        } finally { gl.disable(gl.SCISSOR_TEST); }
        if(pixel[0]) respawn[pixel[0]-1]=performance.now()+3000;
        return pixel[0];
      },
      dispose,
      entities: bsp.entities,
      models: bsp.models,
      worldspawn: bsp.worldspawn,
      stats: {
        ...mesh.stats,
        renderer: "fullscreen ray shader",
        triangles: tree.triangleCount,
        nodes: tree.nodeCount,
        hasSky: true,
        sceneDrawCalls: 1,
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
