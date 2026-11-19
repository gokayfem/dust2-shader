const SIGNATURE = 0x4c4d3031; // "LM01"
const HEADER_BYTES = 13;
const ATLAS_WIDTH = 512;
const GRADIENT_MODE = 4;
const BRIGHTNESS_STEP = 6;
const GRADIENT_STEP = 20;
const LIGHT_TINTS = [[256, 256, 181], [256, 256, 214], [256, 256, 249], [256, 265, 288]];

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readCharts(dimensions, length, scale) {
  const charts = [];
  const view = new DataView(dimensions.buffer, dimensions.byteOffset, dimensions.byteLength);
  let offset = 0;
  for (let i = 0; i < dimensions.length; i++) {
    const packed = dimensions[i];
    let width = (packed >> 4) + 1;
    let height = (packed & 15) + 1;
    if (packed === 255) {
      width = view.getUint16(i + 1, true);
      height = view.getUint16(i + 3, true);
      i += 4;
    }
    if (!width || !height) throw new Error("Invalid compact lightmap chart.");
    charts.push({
      offset, width, height,
      sampleWidth: Math.ceil(width / scale),
      sampleHeight: Math.ceil(height / scale),
    });
    offset += width * height * 3;
  }
  if (offset !== length) throw new Error("Compact lightmap chart lengths do not match the BSP lump.");
  return charts;
}

async function readAtlas(bytes, height) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/webp" }), {
    colorSpaceConversion: "none",
  });
  try {
    if (bitmap.width !== ATLAS_WIDTH || bitmap.height !== height) {
      throw new Error("Unexpected compact lightmap atlas dimensions.");
    }
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  } finally {
    bitmap.close();
  }
}

function decodeGradients(payload, dimensionsLength, length) {
  if (dimensionsLength > payload.length) throw new Error("Invalid compact lightmap dimensions.");
  const charts = readCharts(payload.subarray(0, dimensionsLength), length, 1);
  const planes = payload.subarray(dimensionsLength);
  const count = charts.length;
  if (planes.length !== count * 4) throw new Error("Invalid compact lightmap coefficients.");
  const coefficient = value => ((value >> 1) ^ -(value & 1)) * GRADIENT_STEP;
  const result = new Uint8Array(length);
  for (const [index, { offset, width, height }] of charts.entries()) {
    const color = planes[index];
    const chroma = LIGHT_TINTS[color & 3];
    const brightness = (color >> 2) * BRIGHTNESS_STEP;
    const xGrad = coefficient(planes[count + index]);
    const yGrad = coefficient(planes[count * 2 + index]);
    const xyGrad = coefficient(planes[count * 3 + index]);
    let target = offset;
    for (let row = 0; row < height; row++) {
      const v = height > 1 ? 2 * row / (height - 1) - 1 : 0;
      const rowBrightness = brightness + yGrad * v;
      const rowGrad = xGrad + xyGrad * v;
      for (let column = 0; column < width; column++) {
        const u = width > 1 ? 2 * column / (width - 1) - 1 : 0;
        const value = rowBrightness + rowGrad * u;
        for (const ratio of chroma) {
          result[target++] = Math.max(0, Math.min(255, Math.round(value * ratio / 256)));
        }
      }
    }
  }
  return result;
}

export async function decodeLights(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < HEADER_BYTES || view.getUint32(0) !== SIGNATURE) {
    throw new Error("Invalid compact lightmap header.");
  }
  const scale = bytes[4];
  const length = view.getUint32(5, true);
  const dimensionsLength = view.getUint32(9, true);
  if (!scale) {
    const result = await inflate(bytes.subarray(HEADER_BYTES));
    if (result.length !== length) throw new Error("Invalid compact lightmap lump length.");
    return result;
  }
  if (scale === GRADIENT_MODE) {
    const payload = await inflate(bytes.subarray(HEADER_BYTES));
    return decodeGradients(payload, dimensionsLength, length);
  }
  const dimensionsEnd = HEADER_BYTES + dimensionsLength;
  if (scale > 3 || dimensionsEnd >= bytes.length) throw new Error("Invalid compact lightmap payload.");
  const dimensions = await inflate(bytes.subarray(HEADER_BYTES, dimensionsEnd));
  const charts = readCharts(dimensions, length, scale);
  charts.sort((a, b) => b.sampleHeight - a.sampleHeight);
  let x = 0, y = 0, rowHeight = 0;
  for (const chart of charts) {
    const width = chart.sampleWidth + 2;
    const height = chart.sampleHeight + 2;
    if (width > ATLAS_WIDTH) throw new Error("Compact lightmap chart exceeds atlas width.");
    if (x + width > ATLAS_WIDTH) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    chart.x = x + 1;
    chart.y = y + 1;
    x += width;
    rowHeight = Math.max(rowHeight, height);
  }

  const atlas = await readAtlas(bytes.subarray(dimensionsEnd), y + rowHeight);
  const result = new Uint8Array(length);
  for (const chart of charts) {
    const { width, height, sampleWidth, sampleHeight } = chart;
    let target = chart.offset;
    // Resample within the chart, using the original texel centers. The WebP
    // image also carries a gutter, but no reconstruction samples its neighbors.
    for (let row = 0; row < height; row++) {
      const v = Math.max(0, Math.min(sampleHeight - 1, (row + 0.5) * sampleHeight / height - 0.5));
      const upperRow = Math.floor(v);
      const lowerRow = Math.min(upperRow + 1, sampleHeight - 1);
      const top = (chart.y + upperRow) * ATLAS_WIDTH + chart.x;
      const bottom = (chart.y + lowerRow) * ATLAS_WIDTH + chart.x;
      for (let column = 0; column < width; column++) {
        const u = Math.max(0, Math.min(sampleWidth - 1, (column + 0.5) * sampleWidth / width - 0.5));
        const left = Math.floor(u);
        const right = Math.min(left + 1, sampleWidth - 1);
        const fraction = u - left;
        for (let channel = 0; channel < 3; channel++) {
          const a = atlas[(top + left) * 4 + channel];
          const b = atlas[(top + right) * 4 + channel];
          const c = atlas[(bottom + left) * 4 + channel];
          const d = atlas[(bottom + right) * 4 + channel];
          const upper = a + (b - a) * fraction;
          const lower = c + (d - c) * fraction;
          result[target++] = Math.round(upper + (lower - upper) * (v - upperRow));
        }
      }
    }
  }
  return result;
}
