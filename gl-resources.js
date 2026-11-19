import { PALETTE_GAMMA } from './gamma.js';

export async function shaderSource(name) {
  const url = new URL(`./shaders/${name}.glsl`, import.meta.url);
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load shader ${name}.`);
  return '#version 300 es\n' + await response.text();
}

export function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return shader;
}

export function program(gl, vertexShader, fragmentSource) {
  const fragmentShader = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const result = gl.createProgram();
  gl.attachShader(result, vertexShader);
  gl.attachShader(result, fragmentShader);
  gl.linkProgram(result);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(result);
    gl.deleteProgram(result);
    throw new Error(`Shader link failed: ${log}`);
  }
  return { id: result, uniform: name => gl.getUniformLocation(result, name) };
}

export function rgbaPixels(texture, level, decal) {
  const { width, height, indices } = level;
  const pixels = new Uint8Array(indices.length * 4);
  const palette = texture.palette;
  const tintIndex = palette.length - 3;
  const cutout = texture.name.includes('{');
  const alphaRamp = decal && cutout && !(
    palette[tintIndex] === 0 && palette[tintIndex + 1] === 0 && palette[tintIndex + 2] === 255
  );
  const mask = cutout && !alphaRamp;
  const rgb = value => (cutout ? value : PALETTE_GAMMA[value]) ?? 0;
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i];
    const start = 4 * i;
    let color = index * 3;
    let alpha = 255;
    if (alphaRamp) {
      color = tintIndex;
      alpha = index === 255 ? 0 : index;
    } else if (mask && index === 255) {
      alpha = 0;
      const x = i % width;
      const y = Math.floor(i / width);
      // Borrow the adjacent visible color so filtered cutout silhouettes stay clean.
      const around = [
        x > 0 ? indices[i - 1] : 255, x < width - 1 ? indices[i + 1] : 255,
        y > 0 ? indices[i - width] : 255, y < height - 1 ? indices[i + width] : 255,
      ];
      color = 3 * (around.find(value => value !== 255) ?? 0);
    }
    pixels[start] = rgb(palette[color]);
    pixels[start + 1] = rgb(palette[color + 1]);
    pixels[start + 2] = rgb(palette[color + 2]);
    pixels[start + 3] = alpha;
  }
  return pixels;
}
