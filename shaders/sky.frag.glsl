precision highp float;

in vec3 vWorld;
uniform vec3 uEye;
uniform bool uHasSky;
uniform sampler2D uRt;
uniform sampler2D uLf;
uniform sampler2D uFt;
uniform sampler2D uBk;
uniform sampler2D uUpSide;
uniform sampler2D uDn;

out vec4 outColor;

vec2 skyUV(vec2 plane, float scale) {
    return 0.5 + 0.5 * plane / scale;
}

void main() {
    vec3 view = vWorld - uEye;
    if (!uHasSky) {
        float altitude = clamp(normalize(view).z, 0.0, 1.0);
        vec3 horizon = vec3(0.67, 0.73, 0.77);
        vec3 zenith = vec3(0.30, 0.48, 0.68);
        outColor = vec4(mix(horizon, zenith, smoothstep(0.0, 0.8, altitude)), 1.0);
        return;
    }

    vec3 d = abs(view);
    // GoldSrc sky sides use Z-up and image-space Y-down.
    vec4 color;
    if (d.x >= d.y && d.x >= d.z) {
        if (view.x >= 0.0) color = texture(uRt, skyUV(vec2(-view.y, -view.z), d.x));
        else color = texture(uLf, skyUV(vec2(view.y, -view.z), d.x));
    } else if (d.y >= d.z) {
        if (view.y >= 0.0) color = texture(uBk, skyUV(vec2(view.x, -view.z), d.y));
        else color = texture(uFt, skyUV(vec2(-view.x, -view.z), d.y));
    } else if (view.z >= 0.0) {
        color = texture(uUpSide, skyUV(vec2(-view.y, view.x), d.z));
    } else {
        color = texture(uDn, skyUV(vec2(-view.y, -view.x), d.z));
    }
    outColor = vec4(color.rgb, 1.0);
}
