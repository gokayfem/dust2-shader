// Rebuild the BSP subset needed by the game. It contains the standing and
// crouched collision hulls for the world and solid brushes, plus render data.
const SIGN = 0x80000000;
const MAGNITUDE = SIGN - 1;
const VERTEX_CACHE = 24;
const NEIGHBOR_CACHE = 6;
const little = true;

function reader(bytes) {
  let pos = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  function take(length) {
    const end = pos + length;
    if (end > bytes.length) throw new Error("Truncated compact map");
    const result = bytes.subarray(pos, end);
    pos = end;
    return result;
  }

  function u8() {
    if (pos >= bytes.length) throw new Error("Truncated compact map");
    return bytes[pos++];
  }

  function u16() {
    const result = view.getUint16(pos, little);
    pos += 2;
    return result;
  }

  function block() {
    const size = view.getUint32(pos, little);
    pos += 4;
    return take(size);
  }

  function variable() {
    let value = 0;
    for (let shift = 0; shift < 32; shift += 7) {
      const byte = u8();
      value |= (byte & 127) << shift;
      if (!(byte & 128)) return value >>> 0;
    }
    throw new Error("Invalid compact map integer");
  }

  function column(count, width) {
    const source = take(count * width);
    const result = new Uint32Array(count);
    for (let byte = 0; byte < width; byte++) {
      for (let i = 0; i < count; i++) {
        result[i] |= source[byte * count + i] << (8 * byte);
      }
    }
    return result;
  }

  return { take, u8, u16, block, variable, column, done: () => pos === bytes.length };
}

function decodeDescriptors(input) {
  const count = input.u16();
  const headerSize = 4 + count * 4;
  const bytes = new Uint8Array(headerSize + count * 40);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, count, little);
  let offset = headerSize;
  for (let i = 0; i < count; i++) {
    const size = input.u8();
    if (size === 0) {
      view.setInt32(4 + i * 4, -1, little);
      continue;
    }
    if (size > 16) throw new Error("Invalid compact map texture name");
    view.setInt32(4 + i * 4, offset, little);
    bytes.set(input.take(size), offset);
    view.setUint32(offset + 16, input.u16(), little);
    view.setUint32(offset + 20, input.u16(), little);
    offset += 40;
  }
  return bytes.subarray(0, offset);
}

function decodePlanes(input) {
  const count = input.u16();
  const normalCount = input.u16();
  const normals = input.column(normalCount * 3, 4);
  const ids = input.column(count, 2);
  const distances = input.column(count, 4);
  const flags = input.take(count);
  const bytes = new Uint8Array(count * 40);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) {
    const offset = i * 40;
    for (let axis = 0; axis < 3; axis++) {
      const bits = normals[ids[i] * 3 + axis];
      const flip = (bits & MAGNITUDE) || (flags[i] & (1 << (axis + 3)));
      view.setUint32(offset + axis * 4, bits, little);
      view.setUint32(offset + axis * 4 + 20, flip ? bits ^ SIGN : bits, little);
    }
    view.setUint32(offset + 12, distances[i], little);
    view.setUint32(offset + 32, distances[i] ^ SIGN, little);
    view.setUint32(offset + 16, flags[i] & 7, little);
    view.setUint32(offset + 36, flags[i] & 7, little);
  }
  return bytes;
}

function decodeVertices(input) {
  const count = input.u16();
  const bytes = new Uint8Array(count * 12);
  const view = new DataView(bytes.buffer);
  for (let axis = 0; axis < 3; axis++) {
    const values = Uint32Array.from({ length: count }, input.variable);
    const residuals = input.column(values.filter((value) => value === 0).length, 4);
    let residual = 0;
    let previous = 0;
    for (let i = 0; i < count; i++) {
      const offset = i * 12 + axis * 4;
      const value = values[i];
      if (value === 0) {
        view.setUint32(offset, residuals[residual++], little);
      } else {
        const delta = value - 1;
        previous += (delta >>> 1) ^ -(delta & 1);
        view.setFloat32(offset, previous, little);
      }
    }
  }
  return bytes;
}

function decodeTexinfo(input) {
  const count = input.u16();
  const bytes = new Uint8Array(count * 40);
  const view = new DataView(bytes.buffer);
  for (let axis = 0; axis < 10; axis++) {
    const values = input.column(count, 4);
    for (let i = 0; i < count; i++) {
      view.setUint32(i * 40 + axis * 4, values[i], little);
    }
  }
  return bytes;
}

function projectedSpan(points, axes, offset) {
  const x = axes.getFloat32(offset, little);
  const y = axes.getFloat32(offset + 4, little);
  const z = axes.getFloat32(offset + 8, little);
  const bias = axes.getFloat32(offset + 12, little);
  let lo = Infinity;
  let hi = -Infinity;
  for (const [px, py, pz] of points) {
    const p = (px * x + py * y + pz * z) + bias;
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
  }
  return Math.ceil(Math.fround(hi) / 16) - Math.floor(Math.fround(lo) / 16) + 1;
}

function faceSide(points, planes, plane) {
  let areaX = 0;
  let areaY = 0;
  let areaZ = 0;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay, az] = points[i];
    const [bx, by, bz] = points[(i + 1) % points.length];
    areaX += ay * bz - az * by;
    areaY += az * bx - ax * bz;
    areaZ += ax * by - ay * bx;
  }
  const offset = plane * 20;
  const area = areaX * planes.getFloat32(offset, little)
    + areaY * planes.getFloat32(offset + 4, little)
    + areaZ * planes.getFloat32(offset + 8, little);
  if (!area) throw new Error("Compact map face has invalid winding");
  return Number(area > 0);
}

function remember(cache, value, limit) {
  const old = cache.indexOf(value);
  if (old >= 0) cache.splice(old, 1);
  cache.unshift(value);
  if (cache.length > limit) cache.pop();
}

function rememberNeighbor(neighbors, vertex, neighbor) {
  if (!neighbors[vertex]) neighbors[vertex] = [];
  remember(neighbors[vertex], neighbor, NEIGHBOR_CACHE);
}

function decodeFaces(input, vertices, planeBytes, axes, lightLength) {
  const count = input.u16();
  const planes = Uint16Array.from({ length: count }, input.variable);
  const textureAxes = input.column(count, 2);
  const flags = input.take(count);
  const surfCount = flags.reduce((sum, flag) => sum + (flag & 63), 0);
  const faces = new Uint8Array(count * 20);
  const faceView = new DataView(faces.buffer);
  const edges = new Uint8Array((surfCount + 1) * 4);
  const edgeView = new DataView(edges.buffer);
  const surfedges = new Uint8Array(surfCount * 4);
  const surfedgeView = new DataView(surfedges.buffer);
  const vertexView = new DataView(vertices.buffer);
  const planeView = new DataView(planeBytes.buffer);
  const axesView = new DataView(axes.buffer);
  const edgeIds = new Map();
  const recent = [];
  const neighbors = [];
  let nextVertex = 0;
  let nextSurfedge = 0;
  let lightOffset = 0;
  for (let i = 0; i < count; i++) {
    const flag = flags[i];
    const length = flag & 63;
    const lit = flag & 128;
    const offset = i * 20;
    faceView.setUint16(offset, planes[i], little);
    faceView.setInt32(offset + 4, nextSurfedge, little);
    faceView.setUint16(offset + 8, length, little);
    faceView.setUint16(offset + 10, textureAxes[i], little);
    faceView.setUint32(offset + 12, lit ? 0xffffff00 : 0xffffffff, little);
    faceView.setInt32(offset + 16, lit ? lightOffset : -1, little);

    const polygon = new Uint16Array(length);
    for (let j = 0; j < length; j++) {
      const code = input.variable();
      let vertex;
      if (code === 0) vertex = nextVertex++;
      else if (code <= NEIGHBOR_CACHE) vertex = neighbors[polygon[j - 1]]?.[code - 1];
      else if (code <= NEIGHBOR_CACHE + VERTEX_CACHE) vertex = recent[code - NEIGHBOR_CACHE - 1];
      else vertex = nextVertex + NEIGHBOR_CACHE + VERTEX_CACHE - code;
      if (!(vertex >= 0 && vertex * 12 < vertices.length)) {
        throw new Error("Invalid compact map vertex reference");
      }
      polygon[j] = vertex;
      remember(recent, vertex, VERTEX_CACHE);
    }
    const points = Array.from(polygon, (index) => [
      vertexView.getFloat32(index * 12, little),
      vertexView.getFloat32(index * 12 + 4, little),
      vertexView.getFloat32(index * 12 + 8, little),
    ]);
    faceView.setUint16(offset + 2, faceSide(points, planeView, planes[i]), little);

    // Restore oriented shared edges from the same ordered vertices on each face.
    for (let j = 0; j < length; j++) {
      const a = polygon[j];
      const b = polygon[(j + 1) % length];
      rememberNeighbor(neighbors, a, b);
      rememberNeighbor(neighbors, b, a);
      const low = Math.min(a, b);
      const high = Math.max(a, b);
      const key = low * 65536 + high;
      let edge = edgeIds.get(key);
      if (edge === undefined) {
        edge = edgeIds.size + 1;
        edgeIds.set(key, edge);
        edgeView.setUint16(edge * 4, low, little);
        edgeView.setUint16(edge * 4 + 2, high, little);
      }
      surfedgeView.setInt32(nextSurfedge * 4, a <= b ? edge : -edge, little);
      nextSurfedge++;
    }

    if (lit) {
      const axesOffset = textureAxes[i] * 40;
      const width = projectedSpan(points, axesView, axesOffset);
      const height = projectedSpan(points, axesView, axesOffset + 16);
      lightOffset += width * height * 3;
    }
  }
  if (lightOffset !== lightLength || nextVertex * 12 !== vertices.length) {
    throw new Error("Compact map face data do not match the lighting or vertex count");
  }
  return { faces, edges: edges.subarray(0, (edgeIds.size + 1) * 4), surfedges };
}

function decodeClipnodes(input) {
  const count = input.u16();
  const planes = Uint16Array.from({ length: count }, input.variable);
  const firstChildren = input.take(count);
  const bytes = new Uint8Array(count * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) {
    const first = firstChildren[i];
    const second = input.variable();
    view.setInt32(i * 8, planes[i], little);
    view.setInt16(i * 8 + 4, first < 2 ? first - 2 : i + 1, little);
    view.setInt16(i * 8 + 6, second < 2 ? second - 2 : i + second - 1, little);
  }
  return bytes;
}

export function decodeGeometry(bytes, lightBytes) {
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
  if (lightBytes instanceof ArrayBuffer) lightBytes = new Uint8Array(lightBytes);
  const input = reader(bytes);
  const magic = input.take(3);
  if (magic[0] !== 84 || magic[1] !== 71 || magic[2] !== 50) {
    throw new Error("Unknown compact map format");
  }
  const lumps = new Map();
  lumps.set(0, input.block());
  lumps.set(2, decodeDescriptors(input));
  const planes = decodePlanes(input);
  lumps.set(1, planes);
  const vertices = decodeVertices(input);
  const axes = decodeTexinfo(input);
  const { faces, edges, surfedges } = decodeFaces(input, vertices, planes, axes, lightBytes.length);
  lumps.set(3, vertices);
  lumps.set(6, axes);
  lumps.set(7, faces);
  lumps.set(8, lightBytes);
  lumps.set(9, decodeClipnodes(input));
  lumps.set(12, edges);
  lumps.set(13, surfedges);
  lumps.set(14, input.block());
  if (!input.done()) throw new Error("Unexpected bytes after compact map");

  let offset = 124;
  for (const data of lumps.values()) offset += (data.length + 3) & ~3;
  const bsp = new Uint8Array(offset);
  const header = new DataView(bsp.buffer);
  header.setInt32(0, 30, little);
  offset = 124;
  for (const [index, data] of lumps) {
    header.setInt32(4 + index * 8, offset, little);
    header.setInt32(8 + index * 8, data.length, little);
    bsp.set(data, offset);
    offset += (data.length + 3) & ~3;
  }
  return bsp.buffer;
}
