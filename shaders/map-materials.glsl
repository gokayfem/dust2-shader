

// Library code below is bundled from shader-skills (MIT): https://github.com/gokayfem/shader-skills
// ---- shader-skills library: common ----
const float TAU = 6.28318530717959;

// ---- shader-skills library: hash ----
uint pcgHash(uint v) {
    uint state = v * 747796405u + 2891336453u;
    uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}
uvec3 pcg3d(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    return v;
}
float uintToUnit(uint h) { return float(h >> 8u) * (1.0 / 16777216.0); }
vec2 uintToUnit(uvec2 h) { return vec2(h >> 8u) * (1.0 / 16777216.0); }
vec3 uintToUnit(uvec3 h) { return vec3(h >> 8u) * (1.0 / 16777216.0); }
vec4 uintToUnit(uvec4 h) { return vec4(h >> 8u) * (1.0 / 16777216.0); }
float hash12(vec2 p) {
    uvec2 q = uvec2(ivec2(floor(p)));
    return uintToUnit(pcgHash(q.x + pcgHash(q.y)));
}
float hash13(vec3 p) {
    uvec3 q = uvec3(ivec3(floor(p)));
    return uintToUnit(pcgHash(q.x + pcgHash(q.y + pcgHash(q.z))));
}
vec3 hash33(vec3 p) { return uintToUnit(pcg3d(uvec3(ivec3(floor(p))))); }

// ---- shader-skills library: noise ----
vec2 quinticFade(vec2 f) { return f * f * f * (f * (f * 6.0 - 15.0) + 10.0); }
vec3 quinticFade(vec3 f) { return f * f * f * (f * (f * 6.0 - 15.0) + 10.0); }
vec2 quinticFadeDeriv(vec2 f) { return 30.0 * f * f * (f * (f - 2.0) + 1.0); }
vec3 quinticFadeDeriv(vec3 f) { return 30.0 * f * f * (f * (f - 2.0) + 1.0); }
vec3 valueNoiseD(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = quinticFade(f), du = quinticFadeDeriv(f);
    float a = hash12(i);
    float b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0));
    float d = hash12(i + vec2(1.0, 1.0));
    float k1 = b - a, k2 = c - a, k3 = a - b - c + d;
    return vec3(a + k1 * u.x + k2 * u.y + k3 * u.x * u.y,
                du * vec2(k1 + k3 * u.y, k2 + k3 * u.x));
}
float valueNoise(vec2 p) { return valueNoiseD(p).x; }
float valueNoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = quinticFade(f);
    return mix(mix(mix(hash13(i + vec3(0, 0, 0)), hash13(i + vec3(1, 0, 0)), u.x),
                   mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
               mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x),
                   mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}
vec2 latticeGradient(vec2 cell) {
    float a = TAU * hash12(cell);
    return vec2(cos(a), sin(a));
}
vec3 gradientNoiseD(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = quinticFade(f), du = quinticFadeDeriv(f);
    vec2 ga = latticeGradient(i);
    vec2 gb = latticeGradient(i + vec2(1.0, 0.0));
    vec2 gc = latticeGradient(i + vec2(0.0, 1.0));
    vec2 gd = latticeGradient(i + vec2(1.0, 1.0));
    float va = dot(ga, f);
    float vb = dot(gb, f - vec2(1.0, 0.0));
    float vc = dot(gc, f - vec2(0.0, 1.0));
    float vd = dot(gd, f - vec2(1.0, 1.0));
    float k = va - vb - vc + vd;
    float value = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * k;
    vec2 deriv = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
               + du * (vec2(vb - va, vc - va) + u.yx * k);
    return vec3(value, deriv);
}
float gradientNoise(vec2 p) { return gradientNoiseD(p).x; }
float latticeGradDot(vec3 cell, vec3 corner, vec3 f) {
    vec3 g = hash33(cell + corner) * 2.0 - 1.0;
    return dot(g, f - corner);
}
float gradientNoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = quinticFade(f);
    return mix(mix(mix(latticeGradDot(i, vec3(0, 0, 0), f), latticeGradDot(i, vec3(1, 0, 0), f), u.x),
                   mix(latticeGradDot(i, vec3(0, 1, 0), f), latticeGradDot(i, vec3(1, 1, 0), f), u.x), u.y),
               mix(mix(latticeGradDot(i, vec3(0, 0, 1), f), latticeGradDot(i, vec3(1, 0, 1), f), u.x),
                   mix(latticeGradDot(i, vec3(0, 1, 1), f), latticeGradDot(i, vec3(1, 1, 1), f), u.x), u.y), u.z);
}
vec4 gradientNoiseD(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = quinticFade(f), du = quinticFadeDeriv(f);
    vec3 g000 = hash33(i) * 2.0 - 1.0;
    vec3 g100 = hash33(i + vec3(1, 0, 0)) * 2.0 - 1.0;
    vec3 g010 = hash33(i + vec3(0, 1, 0)) * 2.0 - 1.0;
    vec3 g110 = hash33(i + vec3(1, 1, 0)) * 2.0 - 1.0;
    vec3 g001 = hash33(i + vec3(0, 0, 1)) * 2.0 - 1.0;
    vec3 g101 = hash33(i + vec3(1, 0, 1)) * 2.0 - 1.0;
    vec3 g011 = hash33(i + vec3(0, 1, 1)) * 2.0 - 1.0;
    vec3 g111 = hash33(i + vec3(1, 1, 1)) * 2.0 - 1.0;
    float v000 = dot(g000, f);
    float v100 = dot(g100, f - vec3(1, 0, 0));
    float v010 = dot(g010, f - vec3(0, 1, 0));
    float v110 = dot(g110, f - vec3(1, 1, 0));
    float v001 = dot(g001, f - vec3(0, 0, 1));
    float v101 = dot(g101, f - vec3(1, 0, 1));
    float v011 = dot(g011, f - vec3(0, 1, 1));
    float v111 = dot(g111, f - vec3(1, 1, 1));
    // value = v000 + kx u.x + ky u.y + kz u.z + kxy u.x u.y + kyz u.y u.z + kzx u.z u.x + kxyz u.x u.y u.z
    float kx = v100 - v000, ky = v010 - v000, kz = v001 - v000;
    float kxy = v000 - v100 - v010 + v110;
    float kyz = v000 - v010 - v001 + v011;
    float kzx = v000 - v100 - v001 + v101;
    float kxyz = -v000 + v100 + v010 - v110 + v001 - v101 - v011 + v111;
    float value = v000 + kx * u.x + ky * u.y + kz * u.z
                + kxy * u.x * u.y + kyz * u.y * u.z + kzx * u.z * u.x + kxyz * u.x * u.y * u.z;
    vec3 grad = g000 + (g100 - g000) * u.x + (g010 - g000) * u.y + (g001 - g000) * u.z
              + (g000 - g100 - g010 + g110) * u.x * u.y
              + (g000 - g010 - g001 + g011) * u.y * u.z
              + (g000 - g100 - g001 + g101) * u.z * u.x
              + (-g000 + g100 + g010 - g110 + g001 - g101 - g011 + g111) * u.x * u.y * u.z
              + du * vec3(kx + kxy * u.y + kzx * u.z + kxyz * u.y * u.z,
                          ky + kxy * u.x + kyz * u.z + kxyz * u.x * u.z,
                          kz + kyz * u.y + kzx * u.x + kxyz * u.x * u.y);
    return vec4(value, grad);
}
const int FBM_MAX_OCTAVES = 12;
float fbmLod(vec2 p, int octaves, float footprint) {
    int count = clamp(octaves, 0, FBM_MAX_OCTAVES);
    if (count == 0) return 0.0;
    float width = max(footprint, 0.0);
    float sum = 0.0, amplitude = 1.0;
    const mat2 rotation = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < FBM_MAX_OCTAVES; i++) {
        if (i >= count || width >= 0.5) break;
        float keep = 1.0 - smoothstep(0.25, 0.5, width);
        sum += amplitude * keep * gradientNoise(p);
        p = 2.01 * (rotation * p) + vec2(17.13, -3.71);
        amplitude *= 0.5;
        width *= 2.01;
    }
    // Normalize by the requested spectrum so removing detail never boosts the remaining bands.
    return 1.4 * sum / (2.0 * (1.0 - exp2(-float(count))));
}

// ---- shader-skills library: color ----
vec3 srgbToLinear(vec3 c) {
    c = max(c, 0.0);
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
    c = max(c, 0.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// ---- shader ----
const vec3 sunDir=vec3(-.413,.501,.760);
float seam(float distanceToLine,float width,float footprint){
    return 1.-smoothstep(width,width+max(.15,footprint),abs(distanceToLine));
}
vec3 desertSky(vec3 ray){
    vec3 d=normalize(ray);
    vec2 az=d.xy/max(length(d.xy),.001);
    float ridge=.012+.055*valueNoise(az*8.)+.026*valueNoise(az*22.);
    vec3 sky=mix(vec3(.86,.78,.62),vec3(.31,.54,.78),smoothstep(0.,.85,d.z));
    vec2 cloud=d.xy/(.24+max(d.z,0.))*2.9;
    sky=mix(sky,vec3(.93,.91,.84),smoothstep(.09,.42,fbmLod(cloud,4,.004))*.54);
    sky+=vec3(.56,.39,.18)*pow(max(dot(d,sunDir),0.),48.);
    return mix(vec3(.56,.49,.39),sky,smoothstep(ridge-.002,ridge+.002,d.z));
}
vec3 mapMaterial(int id,vec3 p,vec3 n,vec2 uv,float fp){
    vec2 q=abs(n.z)>.65?p.xy:vec2(abs(n.x)>abs(n.y)?p.y:p.x,p.z);
    float coarse=fbmLod(q*.019,4,fp*.019);
    float fine=fbmLod(q*.30,3,fp*.30);
    vec3 ochre=vec3(.77,.62,.405);
    if(id==1 || id==2 || id==6){
        vec2 tile=fract(uv);
        float joints=min(fract(uv.x*6.),1.-fract(uv.x*6.));
        float grain=fbmLod(vec2(q.x*.29,q.y*.016)+coarse*.6,3,fp*.14);
        vec3 wood=mix(vec3(.305,.181,.078),vec3(.64,.433,.225),.55+grain);
        wood*=1.-.34*seam(joints,.017,fp*.012);
        if(id==2 || id==6){
            vec2 arch=vec2((tile.x-.5)/(id==6?.35:.49),(tile.y-(id==6?.23:.34))/(id==6?.15:.33));
            float cut=arch.y<0.?length(arch)-1.:abs(arch.x)-1.;
            if(id==6)cut=max(cut,(tile.y-.43)*4.);
            if(cut>0.) {
                vec2 course=q/vec2(46.,20.);
                course.x+=.5*mod(floor(course.y),2.);
                vec2 bevel=(.5-abs(fract(course)-.5))*vec2(46.,20.);
                float joint=seam(min(bevel.x,bevel.y),.55,fp);
                return ochre*(.98+.11*hash12(floor(course))-.20*joint)+.14*coarse+.1*fine;
            }
            if(id==6)return wood*.60+vec3(.03);

            float strap=seam(abs(tile.y-.5)-.29,.032,fp*.004);
            float stud=length(vec2(fract(tile.x*8.)-.5,(abs(tile.y-.5)-.29)*8.));
            return mix(wood,vec3(.20,.19,.17)+.07*fine,strap)+.14*strap*(1.-smoothstep(.09,.16,stud));
        }
        float border=min(min(tile.x,1.-tile.x),min(tile.y,1.-tile.y));
        float brace=min(abs(tile.x-tile.y),abs(tile.x+tile.y-1.));
        float bar=min(border-.069,brace-.06);
        float groove=seam(bar,.009,fp*.002);
        float stud=length(fract(tile*4.+.25)-.5);
        vec3 beam=mix(wood*.83,vec3(.57,.40,.23)+.14*grain,1.-smoothstep(-.012,.012,bar));
        return beam*(1.-.44*groove)-.19*float(border<.08)*(1.-smoothstep(.035,.06,stud));
    }
    if(id==3){
        vec2 t=fract(q/vec2(14,12))-.5;
        float diamond=seam(abs(t.x)+abs(t.y)-.35,.065,fp*.045);
        return ochre*(.82+.19*diamond+.065*cos(6.283*t.y))+.095*coarse+.08*fine;
    }
    if(id==4)return vec3(.68,.62,.51)+.13*coarse+.085*fine;
    if(id==5)return vec3(.95,.82,.60);
    if(id==7)return vec3(.50,.39,.28)+coarse*.26+fine*.12;
    if(id==8||abs(n.z)>.68){
        vec3 sand=vec3(.79,.665,.465)+.145*coarse+.12*fine;
        if(n.z>.68 && abs(p.z-(p.x>0.?96.:0.))<3.){
            vec2 a=(p.xy-vec2(1152,2528))/48.,b=(p.xy-vec2(-1552,2696))/48.;
            vec2 mark=length(a)<length(b)?a:b;
            float stroke=min(abs(mark.x-mark.y),abs(mark.x+mark.y));
            float ink=seam(stroke,.09,fp/48.)*(1.-smoothstep(.77,.84,max(abs(mark.x),abs(mark.y))));
            sand=mix(sand,vec3(.62,.19,.085),ink*(.83+.12*coarse));
        }
        return sand;
    }
    vec2 blocks=(q+coarse*1.9)/vec2(54.,23.);
    blocks.x+=.5*mod(floor(blocks.y),2.);
    vec2 edge=.5-abs(fract(blocks)-.5);
    float mortar=seam(min(edge.x*54.,edge.y*23.),.62,fp);
    float stone=hash12(floor(blocks));
    vec3 masonry=ochre*(.92+.16*stone)+.16*coarse+.12*fine;
    float plaster=smoothstep(.02,.30,coarse+.16*valueNoise(q*.047));
    return mix(mix(masonry,masonry*.68,mortar),ochre*1.08+.10*fine,plaster);
}
// Keep display transfer helpers in the bundle for the host's final shading pass.
vec3 mapDisplay(vec3 albedo,vec3 light){return linearToSrgb(srgbToLinear(albedo)*light);}
