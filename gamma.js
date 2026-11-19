const DISPLAY_GAMMA = 2.5;
const TEXTURE_GAMMA = 2.0;
const LIGHT_GAMMA = 2.5;
const BRIGHTNESS = 0;
const LIGHTMAP_MAX = 1023;

// Fixed-point normalization for the ordinary multiply pass without overbright.
export const LIGHTMAP_SCALE = Math.round(256 * 2 ** (1 / LIGHT_GAMMA)) / 64;

export const PALETTE_GAMMA = Uint8Array.from({ length: 256 }, (_, value) =>
  Math.floor(255 * (value / 255) ** (TEXTURE_GAMMA / DISPLAY_GAMMA)));

const brightnessPivot = BRIGHTNESS <= 1 ? 0.125 - BRIGHTNESS ** 2 * 0.075 : 0.05;
export const LIGHTMAP_GAMMA = Uint8Array.from({ length: LIGHTMAP_MAX + 1 }, (_, value) => {
  const light = (value / LIGHTMAP_MAX) ** LIGHT_GAMMA * Math.max(1, BRIGHTNESS);
  const adjusted = light <= brightnessPivot
    ? 0.125 * light / brightnessPivot
    : 0.125 + 0.875 * (light - brightnessPivot) / (1 - brightnessPivot);
  return Math.min(LIGHTMAP_MAX, Math.floor(LIGHTMAP_MAX * adjusted ** (1 / DISPLAY_GAMMA))) >> 2;
});
