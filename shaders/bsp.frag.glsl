precision highp float;
precision highp int;

in vec2 vUV;
in vec2 vLightUV;
flat in vec3 vNormal;

uniform sampler2D uAlbedo;
uniform sampler2D uLightmap;
uniform vec3 uTint;
uniform float uAlpha;
uniform int uDebug;
uniform int uBlend;
uniform bool uMasked;
uniform bool uDecal;
uniform bool uMissing;

out vec4 outColor;

void main() {
    vec4 base = texture(uAlbedo, vUV);
    vec3 baked = texture(uLightmap, vLightUV).rgb;
    if (uMasked && base.a <= 0.25) discard;
    float alpha = uDecal ? base.a : uAlpha;
    if (uDecal && alpha <= 0.0) discard;
    vec3 albedo = uBlend == 1 ? uTint : base.rgb;
    vec3 lit = uBlend == 0 ? albedo * baked : albedo;
    if (uDebug == 1) lit = albedo;
    else if (uDebug == 2) lit = baked;
    else if (uDebug == 3) lit = 0.5 * vNormal + 0.5;
    else if (uDebug == 4) lit = uMissing ? vec3(1.0, 0.15, 0.55) : lit * 0.25;
    outColor = vec4(clamp(lit, 0.0, 1.0), alpha);
}
