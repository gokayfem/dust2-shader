import { VERTEX_FLOATS } from './mesh.js';

const TRIANGLE_FLOATS = 3 * VERTEX_FLOATS;
const TEXEL_TRIANGLE_FLOATS = 12;
const BIN_COUNT = 12;
const MAX_LEAF_SIZE = 8;
const MAX_PACKED_TRIANGLES = 2 ** 24 / MAX_LEAF_SIZE;

function resetBounds(bounds, offset) {
  bounds.fill(Infinity, offset, offset + 3);
  bounds.fill(-Infinity, offset + 3, offset + 6);
}

function includeBounds(target, offset, source, start) {
  for (let axis = 0; axis < 3; axis++) {
    target[offset + axis] = Math.min(target[offset + axis], source[start + axis]);
    target[offset + axis + 3] = Math.max(target[offset + axis + 3], source[start + axis + 3]);
  }
}

function halfArea(bounds, offset) {
  const x = bounds[offset + 3] - bounds[offset];
  const y = bounds[offset + 4] - bounds[offset + 1];
  const z = bounds[offset + 5] - bounds[offset + 2];
  return x * y + y * z + z * x;
}

export function buildRayTree(mesh) {
  const batches = [...mesh.opaque, mesh.sky];
  const triangleCount = batches.reduce((count, batch) => count + batch.vertices.length / TRIANGLE_FLOATS, 0);
  if (triangleCount > MAX_PACKED_TRIANGLES) {
    throw new RangeError('Ray-tree leaf indices exceed float32 integer precision.');
  }
  const geometry = new Float32Array(triangleCount * TEXEL_TRIANGLE_FLOATS);
  const attributes = new Float32Array(geometry.length);
  const triangleData = new Float32Array(geometry.length);
  const attributeData = new Float32Array(geometry.length);
  if (!triangleCount) return { nodeData: new Float32Array(0), triangleData, attributeData, triangleCount, nodeCount: 0 };

  const bounds = new Float64Array(triangleCount * 6);
  const centers = new Float64Array(triangleCount * 3);
  const order = new Uint32Array(triangleCount);
  let triangle = 0;
  batches.forEach(({ page = 0, vertices }, material) => {
    for (let start = 0; start < vertices.length; start += TRIANGLE_FLOATS, triangle++) {
      const offset = triangle * TEXEL_TRIANGLE_FLOATS;
      const second = start + VERTEX_FLOATS;
      const third = second + VERTEX_FLOATS;
      order[triangle] = triangle;
      for (let axis = 0; axis < 3; axis++) {
        const a = Math.fround(vertices[start + axis]);
        const b = Math.fround(vertices[second + axis]);
        const c = Math.fround(vertices[third + axis]);
        const edge1 = Math.fround(b - a);
        const edge2 = Math.fround(c - a);
        geometry[offset + axis] = a;
        geometry[offset + 4 + axis] = edge1;
        geometry[offset + 8 + axis] = edge2;

        // Include the endpoints reconstructed from the packed edges and allow for
        // float32 rounding in the slab test, including zero-thickness triangles.
        const padding = Math.max(1, Math.abs(a), Math.abs(b), Math.abs(c)) * 2 ** -21;
        bounds[triangle * 6 + axis] = Math.fround(Math.min(a, b, c, a + edge1, a + edge2) - padding);
        bounds[triangle * 6 + axis + 3] = Math.fround(Math.max(a, b, c, a + edge1, a + edge2) + padding);
        centers[triangle * 3 + axis] = (a + b + c) / 3;
      }
      geometry[offset + 3] = material === mesh.opaque.length ? -1 : material;
      geometry[offset + 7] = page;
      for (let channel = 0; channel < 4; channel++) {
        const base = Math.fround(vertices[start + 3 + channel]);
        attributes[offset + channel] = base;
        attributes[offset + 4 + channel] = Math.fround(vertices[second + 3 + channel]) - base;
        attributes[offset + 8 + channel] = Math.fround(vertices[third + 3 + channel]) - base;
      }
    }
  });

  const binBounds = new Float64Array(BIN_COUNT * 6);
  const binCounts = new Uint32Array(BIN_COUNT);
  const sweepBounds = new Float64Array(6);
  const prefixCost = new Float64Array(BIN_COUNT - 1);
  const prefixCount = new Uint32Array(BIN_COUNT - 1);
  const nodes = [];
  const binFor = (value, low, scale) => Math.min(BIN_COUNT - 1, Math.floor((value - low) * scale));

  function build(start, end, depth) {
    const node = nodes.length;
    const nodeBounds = new Float64Array(6);
    const centroidBounds = new Float64Array(6);
    resetBounds(nodeBounds, 0);
    resetBounds(centroidBounds, 0);
    for (let i = start; i < end; i++) {
      const index = order[i];
      includeBounds(nodeBounds, 0, bounds, index * 6);
      for (let axis = 0; axis < 3; axis++) {
        const center = centers[index * 3 + axis];
        centroidBounds[axis] = Math.min(centroidBounds[axis], center);
        centroidBounds[axis + 3] = Math.max(centroidBounds[axis + 3], center);
      }
    }
    nodes.push(nodeBounds[0], nodeBounds[1], nodeBounds[2], 0,
      nodeBounds[3], nodeBounds[4], nodeBounds[5], 0);

    const count = end - start;
    const nodeArea = halfArea(nodeBounds, 0);
    let splitAxis = -1;
    let splitBin = -1;
    let splitScale = 0;
    let bestCost = count <= MAX_LEAF_SIZE ? (count - 1) * nodeArea : Infinity;
    // Bound recursion even for ordered geometry that produces repeatedly unbalanced splits.
    if (count > 1 && depth < 32) {
      for (let axis = 0; axis < 3; axis++) {
        const low = centroidBounds[axis];
        const span = centroidBounds[axis + 3] - low;
        if (!span) continue;
        const scale = BIN_COUNT / span;
        binCounts.fill(0);
        for (let bin = 0; bin < BIN_COUNT; bin++) resetBounds(binBounds, bin * 6);
        for (let i = start; i < end; i++) {
          const index = order[i];
          const bin = binFor(centers[index * 3 + axis], low, scale);
          binCounts[bin]++;
          includeBounds(binBounds, bin * 6, bounds, index * 6);
        }

        let leftCount = 0;
        resetBounds(sweepBounds, 0);
        for (let bin = 0; bin < BIN_COUNT - 1; bin++) {
          leftCount += binCounts[bin];
          includeBounds(sweepBounds, 0, binBounds, bin * 6);
          prefixCount[bin] = leftCount;
          prefixCost[bin] = leftCount ? leftCount * halfArea(sweepBounds, 0) : 0;
        }

        let rightCount = 0;
        resetBounds(sweepBounds, 0);
        for (let bin = BIN_COUNT - 1; bin > 0; bin--) {
          rightCount += binCounts[bin];
          includeBounds(sweepBounds, 0, binBounds, bin * 6);
          if (!rightCount || !prefixCount[bin - 1]) continue;
          const cost = prefixCost[bin - 1] + rightCount * halfArea(sweepBounds, 0);
          if (cost < bestCost) {
            bestCost = cost;
            splitAxis = axis;
            splitBin = bin - 1;
            splitScale = scale;
          }
        }
      }
    }

    if (splitAxis >= 0 || count > MAX_LEAF_SIZE) {
      let middle = start + Math.floor(count / 2);
      if (splitAxis >= 0) {
        middle = start;
        const low = centroidBounds[splitAxis];
        for (let i = start; i < end; i++) {
          const index = order[i];
          const bin = binFor(centers[index * 3 + splitAxis], low, splitScale);
          if (bin <= splitBin) {
            order[i] = order[middle];
            order[middle++] = index;
          }
        }
      }
      build(start, middle, depth + 1);
      build(middle, end, depth + 1);
    } else {
      // Zero marks an internal node. Leaves pack their ordered start and count in one float.
      nodes[node + 7] = 1 + start * MAX_LEAF_SIZE + (count - 1);
    }
    // Nodes are in preorder. A miss or completed leaf jumps past the entire subtree.
    nodes[node + 3] = nodes.length / 8;
  }

  build(0, triangleCount, 0);
  for (let i = 0; i < triangleCount; i++) {
    const source = order[i] * TEXEL_TRIANGLE_FLOATS;
    const target = i * TEXEL_TRIANGLE_FLOATS;
    triangleData.set(geometry.subarray(source, source + TEXEL_TRIANGLE_FLOATS), target);
    attributeData.set(attributes.subarray(source, source + TEXEL_TRIANGLE_FLOATS), target);
  }
  return { nodeData: new Float32Array(nodes), triangleData, attributeData, triangleCount, nodeCount: nodes.length / 8 };
}
