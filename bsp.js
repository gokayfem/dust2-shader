const BSP30 = 30;
const LUMP_COUNT = 15;
const HEADER_BYTES = 4 + LUMP_COUNT * 8;
const decoder = new TextDecoder('windows-1252');
const LUMPS = {
  entities: 0, planes: 1, textures: 2, vertices: 3, texinfo: 6,
  faces: 7, lighting: 8, edges: 12, surfedges: 13, models: 14,
};

function text(bytes, start, count) {
  const slice = bytes.subarray(start, start + count);
  const end = slice.indexOf(0);
  return decoder.decode(end < 0 ? slice : slice.subarray(0, end));
}

function fileReader(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    bytes, length: bytes.length,
    u16: offset => view.getUint16(offset, true),
    i32: offset => view.getInt32(offset, true),
    u32: offset => view.getUint32(offset, true),
    f32: offset => view.getFloat32(offset, true),
    str: (offset, count) => text(bytes, offset, count),
  };
}

function readMiptex(file, offset, end, directoryName) {
  if (offset < 0 || offset + 40 > end) return null;
  const name = (directoryName || file.str(offset, 16)).toLowerCase();
  const width = file.u32(offset + 16);
  const height = file.u32(offset + 20);
  if (!name || width < 1 || height < 1 || width > 4096 || height > 4096) return null;
  const texture = { name, width, height, levels: [] };
  const mipOffsets = Array.from({ length: 4 }, (_, i) => file.u32(offset + 24 + 4 * i));
  if (mipOffsets[0] === 0) return texture;
  const widthAt = level => Math.max(1, width >> level);
  const heightAt = level => Math.max(1, height >> level);
  const countAt = level => widthAt(level) * heightAt(level);
  const paletteStart = offset + mipOffsets[3] + countAt(3);
  if (paletteStart + 2 > end || mipOffsets.some(n => n < 40)) return texture;
  const paletteSize = file.u16(paletteStart);
  if (paletteSize < 1 || paletteSize > 256 || paletteStart + 2 + paletteSize * 3 > end) return texture;
  texture.palette = file.bytes.subarray(paletteStart + 2, paletteStart + 2 + paletteSize * 3);
  for (let level = 0; level < 4; level++) {
    const start = offset + mipOffsets[level];
    const count = countAt(level);
    if (start + count > end) {
      texture.levels.length = 0;
      break;
    }
    texture.levels.push({
      width: widthAt(level), height: heightAt(level), indices: file.bytes.subarray(start, start + count),
    });
  }
  return texture;
}

export function readWad(buffer) {
  const file = fileReader(buffer);
  if (file.length < 12 || file.str(0, 4) !== 'WAD3') {
    throw new Error('Expected a GoldSrc WAD3 file.');
  }
  const count = file.i32(4);
  const directory = file.i32(8);
  if (count < 0 || directory < 12 || directory + count * 32 > file.length) {
    throw new Error('Invalid WAD3 directory.');
  }
  const textures = new Map();
  for (let i = 0; i < count; i++) {
    const entry = directory + i * 32;
    const offset = file.i32(entry);
    const size = file.i32(entry + 4);
    const type = file.bytes[entry + 12];
    const compression = file.bytes[entry + 13];
    // 0x43 identifies miptex. GoldSrc decal WADs also use 0x44 for miptex.
    if (compression || ![0x43, 0x44].includes(type) || offset < 12 || size < 40
        || offset + size > file.length) continue;
    const texture = readMiptex(file, offset, offset + size, file.str(entry + 16, 16));
    if (texture?.levels.length) textures.set(texture.name, texture);
  }
  return textures;
}

function readEntities(source) {
  const tokens = source.matchAll(/"([^"]*)"|([{}])/g);
  const entities = [];
  let entity;
  let key;
  for (const [, value, brace] of tokens) {
    if (brace === '{') {
      entity = Object.create(null);
      key = undefined;
    } else if (brace === '}') {
      if (entity) entities.push(entity);
      entity = undefined;
    } else if (entity && key === undefined) {
      key = value.toLowerCase();
    } else if (entity) {
      entity[key] = value;
      key = undefined;
    }
  }
  return entities;
}

export function readBsp(buffer) {
  const file = fileReader(buffer);
  if (file.length < HEADER_BYTES || file.i32(0) !== BSP30) {
    throw new Error('Expected a GoldSrc BSP version 30 map.');
  }
  const lumps = Array.from({ length: LUMP_COUNT }, (_, i) => {
    const offset = file.i32(4 + i * 8);
    const size = file.i32(8 + i * 8);
    if (offset < 0 || size < 0 || (size && offset < HEADER_BYTES) || offset + size > file.length) {
      throw new Error(`Invalid BSP lump ${i}.`);
    }
    return { offset, size, end: offset + size };
  });
  const lump = name => lumps[LUMPS[name]];
  const records = (name, stride, read) => {
    const { offset, size } = lump(name);
    if (size % stride !== 0) throw new Error(`Invalid BSP ${name} record size.`);
    return Array.from({ length: size / stride }, (_, i) => read(offset + i * stride));
  };
  const floats = (offset, n) => Array.from({ length: n }, (_, i) => file.f32(offset + i * 4));
  const textures = [];
  const textureLump = lump('textures');
  if (textureLump.size) {
    if (textureLump.size < 4) throw new Error('Invalid BSP miptexture directory.');
    const count = file.i32(textureLump.offset);
    if (count < 0 || 4 + count * 4 > textureLump.size) throw new Error('Invalid BSP miptexture count.');
    for (let i = 0; i < count; i++) {
      const relative = file.i32(textureLump.offset + 4 + i * 4);
      textures.push(relative < 4 + count * 4 ? null
        : readMiptex(file, textureLump.offset + relative, textureLump.end));
    }
  }
  const faces = records('faces', 20, offset => ({
    plane: file.u16(offset), side: file.u16(offset + 2), edge: file.i32(offset + 4),
    count: file.u16(offset + 8), texinfo: file.u16(offset + 10),
    styles: file.bytes.subarray(offset + 12, offset + 16), lightOffset: file.i32(offset + 16),
  }));
  const models = records('models', 64, offset => ({
    mins: floats(offset, 3), maxs: floats(offset + 12, 3), origin: floats(offset + 24, 3),
    firstFace: file.i32(offset + 56), faceCount: file.i32(offset + 60),
  }));
  if (!models.length || models.some(model => model.firstFace < 0 || model.faceCount < 0
      || model.firstFace + model.faceCount > faces.length)) throw new Error('Invalid BSP brush models.');
  const entities = readEntities(file.str(lump('entities').offset, lump('entities').size));
  return {
    entities, textures, faces, models,
    worldspawn: entities.find(entity => entity.classname === 'worldspawn') ?? {},
    planes: records('planes', 20, offset => floats(offset, 3)),
    vertices: records('vertices', 12, offset => floats(offset, 3)),
    texinfo: records('texinfo', 40, offset => ({
      s: floats(offset, 4), t: floats(offset + 16, 4),
      texture: file.i32(offset + 32), flags: file.i32(offset + 36),
    })),
    edges: records('edges', 4, offset => [file.u16(offset), file.u16(offset + 2)]),
    surfedges: records('surfedges', 4, offset => file.i32(offset)),
    lighting: file.bytes.subarray(lump('lighting').offset, lump('lighting').end),
  };
}
