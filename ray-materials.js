import { rgbaPixels } from "./gl-resources.js";

// Each original mip has a repeated one-texel gutter. Hardware bilinear filtering
// can then cross the authored wrap boundary without picking up its atlas neighbour.
export function packRayMaterials(batches) {
  const charts = [];
  const metadata = new Float32Array(batches.length * 4 * 4);
  for (const [index, batch] of batches.entries()) {
    if (!batch.texture?.levels.length)
      throw new Error("Ray material unresolved: " + batch.name);
    for (let mip = 0; mip < 4; mip++) {
      const levelIndex = Math.min(mip, batch.texture.levels.length - 1);
      const level = batch.texture.levels[levelIndex];
      charts.push({
        index,
        mip,
        width: level.width,
        height: level.height,
        rgba: rgbaPixels(batch.texture, level, false),
      });
    }
  }
  const width = 2048;
  charts.sort((a, b) => b.height - a.height);
  let x = 0,
    y = 0,
    rowHeight = 0;
  for (const c of charts) {
    if (c.width + 2 > width)
      throw new Error("Ray material is wider than the sampling atlas.");
    if (x + c.width + 2 > width) {
      y += rowHeight;
      rowHeight = 0;
      x = 0;
    }
    c.x = x + 1;
    c.y = y + 1;
    metadata.set([c.x, c.y, c.width, c.height], (c.index * 4 + c.mip) * 4);
    x += c.width + 2;
    rowHeight = Math.max(rowHeight, c.height + 2);
  }
  const height = y + rowHeight;
  const pixels = new Uint8Array(width * height * 4);
  for (const c of charts) {
    for (let v = -1; v <= c.height; v++) {
      const row = ((v + c.height) % c.height) * c.width * 4;
      const target = ((c.y + v) * width + c.x) * 4;
      pixels.set(c.rgba.subarray(row, row + c.width * 4), target);
      pixels.set(
        c.rgba.subarray(row + (c.width - 1) * 4, row + c.width * 4),
        target - 4,
      );
      pixels.set(c.rgba.subarray(row, row + 4), target + c.width * 4);
    }
  }
  return { width, height, pixels, metadata };
}
