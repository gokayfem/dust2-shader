import { LIGHTMAP_GAMMA, LIGHTMAP_SCALE } from './gamma.js';

const SAMPLE_SPACING = 16;
export const VERTEX_FLOATS = 10;
const HIDDEN = /^(?:aaatrigger|clip|hint|skip|null|origin|bevel|nodraw)$/i;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => a.map((x, i) => x - b[i]);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = a => {
  const length = Math.hypot(...a.slice(0, 3)) || 1;
  return a.slice(0, 3).map(value => value / length);
};
const coords = (value, fallback = [0, 0, 0]) => {
  const values = value?.trim().split(/\s+/).map(Number);
  return values?.length === 3 && values.every(Number.isFinite) ? values : fallback;
};
const clamp = (a, low, high) => Math.min(high, Math.max(low, a));

function faceBounds(uv) {
  const low = [Infinity, Infinity];
  const high = [-Infinity, -Infinity];
  for (const pair of uv) {
    for (let i = 0; i < 2; i++) {
      low[i] = Math.min(low[i], pair[i]);
      high[i] = Math.max(high[i], pair[i]);
    }
  }
  return { low, high };
}

function newPage(size) {
  const page = { pixels: new Uint8Array(size * size * 4), x: 0, y: 3, rowHeight: 0 };
  // Reserve a filtered fullbright chart.
  for (let y = 0; y < 3; y++) page.pixels.fill(255, y * size * 4, (y * size + 3) * 4);
  return page;
}

function lightmap(bsp, face, uv, pages, size, lightWeights) {
  const center = () => [1.5 / size, 1.5 / size];
  const { low, high } = faceBounds(uv);
  // GoldSrc stores each projected extent as a float before snapping to the 16-unit grid.
  const [s0, t0] = low.map(x => Math.floor(Math.fround(x) / SAMPLE_SPACING));
  const [s1, t1] = high.map(x => Math.ceil(Math.fround(x) / SAMPLE_SPACING));
  const width = s1 - s0 + 1;
  const height = t1 - t0 + 1;
  const stride = width * height * 3;
  const styles = [];
  for (const index of face.styles) {
    if (index === 255) break;
    styles.push(lightWeights.get(index) ?? 1);
  }
  if (face.lightOffset < 0 || !styles.length || width + 2 > size || height + 2 > size
      || face.lightOffset + stride * styles.length > bsp.lighting.length) {
    return { page: 0, at: center };
  }
  let page = pages[pages.length - 1];
  if (page.x + width + 2 > size) {
    page.x = 0;
    page.y += page.rowHeight;
    page.rowHeight = 0;
  }
  if (page.y + height + 2 > size) {
    page = newPage(size);
    pages.push(page);
  }

  const left = page.x + 1;
  const top = page.y + 1;
  page.x += width + 2;
  page.rowHeight = Math.max(page.rowHeight, height + 2);
  for (let y = -1; y <= height; y++) {
    for (let x = -1; x <= width; x++) {
      const source = face.lightOffset + (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 3;
      const target = ((top + y) * size + left + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        let intensity = 0;
        for (let style = 0; style < styles.length; style++) {
          intensity += bsp.lighting[source + style * stride + channel] * styles[style];
        }
        const sample = Math.min(LIGHTMAP_GAMMA.length - 1, Math.floor(intensity * LIGHTMAP_SCALE));
        page.pixels[target + channel] = LIGHTMAP_GAMMA[sample];
      }
      page.pixels[target + 3] = 255;
    }
  }
  return {
    page: pages.length - 1,
    at: (s, t) => [
      (left + 0.5 + s / SAMPLE_SPACING - s0) / size,
      (top + 0.5 + t / SAMPLE_SPACING - t0) / size,
    ],
  };
}

function brushTransform(entity, model) {
  const origin = coords(entity.origin, model.origin);
  const [pitch, yaw, roll] = coords(entity.angles).map(angle => angle * Math.PI / 180);
  const sp = Math.sin(pitch), cp = Math.cos(pitch);
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  const sr = Math.sin(roll), cr = Math.cos(roll);
  const x = [cp * cy, cp * sy, -sp];
  const y = [sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, sr * cp];
  const z = [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp];
  const rotate = ([a, b, c]) => x.map((v, i) => a * v + b * y[i] + c * z[i]);
  return { rotate, transform: point => rotate(point).map((v, i) => v + origin[i]) };
}

function brushAppearance(entity) {
  const mode = Number(entity.rendermode) || 0;
  const alpha = clamp(Number(entity.renderamt ?? 255), 0, 255) / 255;
  const blend = [1, 2, 3, 5].includes(mode) ? mode : 0;
  const tint = coords(entity.rendercolor, [255, 255, 255]).map(c => clamp(c, 0, 255) / 255);
  return { blend, tint: mode === 1 ? tint : [1, 1, 1], alpha: blend ? alpha : 1, forceMask: mode === 4 };
}

function verticesOfFace(bsp, face) {
  if (!face || face.count < 3 || face.edge < 0 || face.edge + face.count > bsp.surfedges.length) {
    return null;
  }
  const positions = [];
  for (let i = 0; i < face.count; i++) {
    const surfedge = bsp.surfedges[face.edge + i];
    const edge = bsp.edges[Math.abs(surfedge)];
    const point = edge && bsp.vertices[edge[surfedge >= 0 ? 0 : 1]];
    if (!point || !point.every(Number.isFinite)) return null;
    positions.push(point);
  }
  return positions;
}

function addPolygon(batch, vertices, normal) {
  const a = vertices[0];
  for (let i = 1; i < vertices.length - 1; i++) {
    const b = vertices[i], c = vertices[i + 1];
    const alignment = dot(cross(sub(b, a), sub(c, a)), normal);
    if (Math.abs(alignment) < 1e-6) continue;
    for (const vertex of alignment > 0 ? [a, b, c] : [a, c, b]) {
      batch.vertices.push(...vertex, ...normal);
    }
  }
}

function decalClip(polygon, axis, edge, direction) {
  const result = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const da = (a[axis] - edge) * direction;
    const db = (b[axis] - edge) * direction;
    if (da >= 0) result.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      result.push(a.map((v, j) => v + (b[j] - v) * t));
    }
  }
  return result;
}

function buildDecals(entities, receivers, textures, missingDecals) {
  const decals = new Map();
  for (const entity of entities) {
    if (entity.classname !== 'infodecal' || entity.targetname) continue;
    const name = entity.texture?.toLowerCase();
    const texture = textures.get(name);
    if (!texture) {
      if (name) missingDecals.add(name);
      continue;
    }
    const origin = coords(entity.origin, null);
    if (!origin) continue;
    for (const { verts, s, t, normal, chart } of receivers) {
      if (Math.abs(dot(sub(origin, verts[0]), normal)) >= 4) continue;
      const u = unit(s), v = unit(t);
      let polygon = verts.map(p => {
        const local = sub(p, origin);
        return [...p, dot(local, u) / texture.width + 0.5, dot(local, v) / texture.height + 0.5,
          ...chart.at(dot(p, s) + s[3], dot(p, t) + t[3])];
      });
      polygon = decalClip(polygon, 3, 0, 1);
      polygon = decalClip(polygon, 3, 1, -1);
      polygon = decalClip(polygon, 4, 0, 1);
      polygon = decalClip(polygon, 4, 1, -1);
      if (polygon.length < 3) continue;
      const key = JSON.stringify([name, chart.page]);
      if (!decals.has(key)) decals.set(key, {
        name, texture, page: chart.page, vertices: [], alpha: 1, tint: [1, 1, 1], blend: 0,
      });
      addPolygon(decals.get(key), polygon, normal);
    }
  }
  return [...decals.values()];
}

export function buildMesh(bsp, textures, atlasSize) {
  const pages = [newPage(atlasSize)];
  const opaque = new Map();
  const transparent = [];
  const sky = { vertices: [] };
  const missingTextures = new Set();
  const missingDecals = new Set();
  const normalStyle = 12 * 22 / 256;
  const lightWeights = new Map([[0, normalStyle], [63, 0]]);
  const modelEntities = new Map();
  const receivers = [];
  for (const entity of bsp.entities) {
    if (/^\*\d+$/.test(entity.model ?? '')) modelEntities.set(Number(entity.model.slice(1)), entity);
    if (entity.classname?.startsWith('light') && Number(entity.style) >= 32) {
      lightWeights.set(Number(entity.style), Number(entity.spawnflags) & 1 ? 0 : normalStyle);
    }
  }

  let faces = 0;
  let skyFaces = 0;
  let brushModels = 0;
  bsp.models.forEach((model, index) => {
    const entity = index ? modelEntities.get(index) : bsp.worldspawn;
    if (!entity) return;
    const classname = entity.classname ?? '';
    if (/^(?:trigger_|func_(?:illusionary_clip|ladder|buyzone|bomb_target|hostage_rescue|escapezone|vip_safetyzone|vehiclecontrols)$)/.test(classname)) return;
    const appearance = brushAppearance(entity);
    if (appearance.alpha === 0) return;
    const xform = index ? brushTransform(entity, model) : { rotate: point => point, transform: point => point };
    if (index) brushModels++;

    for (let i = model.firstFace; i < model.firstFace + model.faceCount; i++) {
      const face = bsp.faces[i];
      const texinfo = bsp.texinfo[face.texinfo];
      const plane = bsp.planes[face.plane];
      const verts = verticesOfFace(bsp, face);
      if (!texinfo || !plane || !verts || ![...texinfo.s, ...texinfo.t, ...plane].every(Number.isFinite)) continue;
      const descriptor = bsp.textures[texinfo.texture];
      const name = descriptor?.name ?? '__missing__';
      const isSky = name.startsWith('sky');
      if (HIDDEN.test(name)) continue;

      const positions = verts.map(xform.transform);
      const normal = xform.rotate(plane.map(v => face.side ? -v : v));
      faces++;
      if (isSky) {
        skyFaces++;
        addPolygon(sky, positions.map(p => [...p, 0, 0, 0, 0]), normal);
        continue;
      }

      const texture = descriptor?.levels.length ? descriptor : textures.get(name);
      const missing = !texture && appearance.blend !== 1;
      if (missing) missingTextures.add(name);
      const width = descriptor?.width ?? texture?.width ?? 64;
      const height = descriptor?.height ?? texture?.height ?? 64;
      const texels = verts.map(p => [dot(p, texinfo.s) + texinfo.s[3], dot(p, texinfo.t) + texinfo.t[3]]);
      const chart = lightmap(bsp, face, texels, pages, atlasSize, lightWeights);
      const masked = appearance.forceMask || name.includes('{');
      if (!index && !masked && !name.startsWith('!') && !appearance.blend) {
        receivers.push({ verts, s: texinfo.s, t: texinfo.t, normal, chart });
      }
      const state = {
        ...appearance, name, texture, missing, masked, page: chart.page, vertices: [],
      };
      const vertices = positions.map((p, j) => {
        const [s, t] = texels[j];
        return [...p, s / width, t / height, ...chart.at(s, t)];
      });
      if (appearance.blend) {
        state.center = [0, 1, 2].map(axis => positions.reduce((sum, p) => sum + p[axis], 0) / positions.length);
        addPolygon(state, vertices, normal);
        transparent.push(state);
      } else {
        const key = JSON.stringify([name, chart.page, masked]);
        if (!opaque.has(key)) opaque.set(key, state);
        addPolygon(opaque.get(key), vertices, normal);
      }
    }
  });
  const decals = buildDecals(bsp.entities, receivers, textures, missingDecals);
  return {
    opaque: [...opaque.values()], transparent, sky, pages, decals,
    stats: {
      faces, skyFaces, brushModels,
      missingTextures: [...missingTextures].sort(), missingDecals: [...missingDecals].sort(),
    },
  };
}
