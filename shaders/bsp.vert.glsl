precision highp float;

layout(location = 0) in vec3 aWorld;
layout(location = 1) in vec2 aUV;
layout(location = 2) in vec2 aLightUV;
layout(location = 3) in vec3 aNormal;

uniform vec3 uEye;
uniform vec3 uForward;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec2 uProjection;
uniform vec2 uDepth;

out vec2 vUV;
out vec2 vLightUV;
out vec3 vWorld;
flat out vec3 vNormal;

void main() {
    vec3 relative = aWorld - uEye;
    float depth = dot(relative, uForward);
    gl_Position = vec4(dot(relative, uRight) * uProjection.x,
                       dot(relative, uUp) * uProjection.y,
                       depth * uDepth.x + uDepth.y,
                       depth);
    vWorld = aWorld;
    vUV = aUV;
    vLightUV = aLightUV;
    vNormal = aNormal;
}
