precision highp float;
precision highp int;
precision highp sampler2DArray;

uniform sampler2D uNodes;
uniform sampler2D uTriangles;
uniform sampler2D uAttributes;
uniform sampler2D uMaterials;
uniform sampler2D uMaterialInfo;
uniform sampler2DArray uLightmaps;
uniform sampler2DArray uSky;
uniform vec3 uEye, uForward, uRight, uUp;
uniform vec2 uSize;
uniform float uTanHalfFov;
uniform int uNodesCount, uDebug;
out vec4 outColor;

// The data tables use 1024 RGBA texels per row.
vec4 entry(sampler2D table, int address) {
    return texelFetch(table, ivec2(address & 1023, address >> 10), 0);
}
bool withinBox(vec3 lo, vec3 hi, vec3 inverseRay, float closest) {
    vec3 a = (lo - uEye) * inverseRay;
    vec3 b = (hi - uEye) * inverseRay;
    vec3 near = min(a, b), far = max(a, b);
    float enter = max(max(near.x, near.y), max(near.z, 1.0));
    return enter <= min(min(far.x, far.y), min(far.z, closest));
}
int nearestSurface(vec3 ray, out float closest, out vec2 bary) {
    closest = 16384.0;
    bary = vec2(0.0);
    vec3 inv = vec3(1.0) / mix(ray, vec3(1e-15), lessThan(abs(ray),vec3(1e-15)));
    int hit = -1;
    int node = 0;
    while (node < uNodesCount) {
        vec4 lo = entry(uNodes, node * 2);
        vec4 hi = entry(uNodes, node * 2 + 1);
        if (!withinBox(lo.xyz, hi.xyz, inv, closest)) {
            node = int(lo.w);
            continue;
        }
        node++;
        int leaf = int(hi.w) - 1;
        if (leaf < 0) continue;
        int start = leaf >> 3;
        for (int offset=0; offset<= (leaf & 7); offset++) {
            int tri = start + offset;
            vec3 a = entry(uTriangles, tri*3).xyz;
            vec3 e1 = entry(uTriangles, tri*3+1).xyz;
            vec3 e2 = entry(uTriangles, tri*3+2).xyz;
            vec3 p = cross(ray,e2);
            float det = dot(e1,p);
            if (det <= 1e-7) continue;
            vec3 delta = uEye-a;
            float u = dot(delta,p);
            if (u < -1e-6*det || u > 1.000001*det) continue;
            vec3 q = cross(delta,e1);
            float v = dot(ray,q);
            if (v < -1e-6*det || u+v > 1.000001*det) continue;
            float t = dot(e2,q)/det;
            if (t<1.0 || t>=closest) continue;
            hit=tri; closest=t; bary=vec2(u,v)/det;
        }
    }
    return hit;
}

vec3 skyColor(vec3 d) {
    vec3 a=abs(d);
    vec2 uv;
    float layer;
    if (a.x>=a.y && a.x>=a.z) {
        layer=d.x>=0.0 ? 0.0 : 1.0;
        uv=vec2(d.x>=0.0 ? -d.y:d.y,-d.z)/a.x;
    } else if(a.y>=a.z) {
        layer=d.y>=0.0 ? 3.0:2.0;
        uv=vec2(d.y>=0.0 ? d.x:-d.x,-d.z)/a.y;
    } else {
        layer=d.z>=0.0 ? 4.0:5.0;
        uv=vec2(-d.y,d.z>=0.0 ? d.x:-d.x)/a.z;
    }
    return textureLod(uSky,vec3(0.5+0.5*uv,layer),0.0).rgb;
}
vec2 uvChange(vec3 derivative, vec3 ray, vec3 n, vec3 e1, vec3 e2,
              float depth, vec2 du, vec2 dv) {
    vec3 dp=depth*(derivative-ray*(dot(n,derivative)/dot(n,ray)));
    return (dot(cross(dp,e2),n)*du+dot(cross(e1,dp),n)*dv)/dot(n,n);
}
vec3 sampleMip(int mip,int mat,vec2 uv){
    vec4 chart=texelFetch(uMaterialInfo,ivec2(mip,mat),0);
    vec2 coord=(chart.xy+fract(uv)*chart.zw)/vec2(textureSize(uMaterials,0));
    return textureLod(uMaterials,coord,0.0).rgb;
}

uniform float uShot;

uniform sampler2D uRifle;
bool rifle(out vec3 color) {
    vec2 p=(gl_FragCoord.xy-.5*uSize)/uSize.y;
    float kick=max(0.,1.-uShot*7.);
    p=(p-vec2(0,.012*kick))/(1.+.035*kick);
    vec2 uv=vec2((p.x-.04)/.48,(-.07-p.y)/.5);
    if(any(lessThan(uv,vec2(0)))||any(greaterThan(uv,vec2(1))))return false;
    vec4 tex=texture(uRifle,uv);
    if(tex.a>.48){color=tex.rgb;return true;}
    vec2 flash=(p-vec2(.133,-.222))*vec2(1.,1.3);
    float flare=.017+.008*cos(5.*atan(flash.y,flash.x));
    if(uShot<.078 && length(flash)<flare*(1.-uShot/.078)){
        color=mix(vec3(1,.98,.68),vec3(1,.55,.13),smoothstep(0.,flare,length(flash)));return true;
    }
    return false;
}

uniform int uDown;
const vec3 stands[8]=vec3[](vec3(-256,-800,64),vec3(672,320,0),vec3(1312,1152,0),vec3(288,1568,0),vec3(-1664,896,32),vec3(-1568,2720,0),vec3(1152,2528,96),vec3(32,2208,-128));
int targetStand(vec3 ray,inout float depth,out vec3 color){
    int id=0;
    for(int i=0;i<8;i++){
        if((uDown & (1<<i))!=0)continue;
        vec3 delta=stands[i]-uEye;
        vec2 n=vec2(-uRight.y,uRight.x);
        float t=dot(delta.xy,n)/dot(ray.xy,n);
        if(t<1.||t>=depth)continue;
        vec3 local=ray*t-delta;
        vec2 p=vec2(abs(dot(local,uRight)),local.z);
        float radius=length(p-vec2(0,52));
        if(radius<=20.){
            bool red=mod(floor(radius/4.01),2.)==0.;
            color=red?vec3(.85,.075,.085):vec3(.98,.94,.84);
        }else if(p.x<=2.5 && p.y>=0. && p.y<52.){
            color=vec3(.44,.29,.16);
        }else continue;
        depth=t;id=i+1;
    }
    return id;
}

void main() {
    vec3 weapon;
    if(uShot>=0.0 && rifle(weapon)){outColor=vec4(weapon,1);return;}
    float pixel=2.0*uTanHalfFov/uSize.x;
    vec2 screen=(gl_FragCoord.xy-0.5*uSize)*pixel;
    vec3 ray=uForward+screen.x*uRight+screen.y*uUp;
    float depth;
    vec2 bary;
    bool picking=uShot==-2.;
    if(picking)ray=uForward;
    int hit=nearestSurface(ray,depth,bary);
    vec3 paint;
    int id=0;
    if(uShot>=0.||picking)id=targetStand(ray,depth,paint);
    if(picking){outColor=vec4(float(id)/255.,0,0,1);return;}
    if(id>0){outColor=vec4(paint,1);return;}
    if(hit<0){outColor=vec4(0.055,0.060,0.070,1.0);return;}
    int k=hit*3;
    int material=int(entry(uTriangles,k).w);
    if(material<0){outColor=vec4(skyColor(ray),1.0);return;}
    vec4 edge=entry(uTriangles,k+1);
    vec3 e1=edge.xyz, e2=entry(uTriangles,k+2).xyz, n=cross(e1,e2);
    vec4 base=entry(uAttributes,k), du=entry(uAttributes,k+1), dv=entry(uAttributes,k+2);
    vec4 uv=base+du*bary.x+dv*bary.y;
    vec2 dimensions=texelFetch(uMaterialInfo,ivec2(0,material),0).zw;
    vec2 dx=dimensions*uvChange(pixel*uRight,ray,n,e1,e2,depth,du.xy,dv.xy);
    vec2 dy=dimensions*uvChange(pixel*uUp,ray,n,e1,e2,depth,du.xy,dv.xy);
    float mip=clamp(0.5*log2(max(max(dot(dx,dx),dot(dy,dy)),1e-12)),0.0,3.0);
    int level=int(floor(mip));
    vec3 albedo=mix(sampleMip(level,material,uv.xy),sampleMip(min(3,level+1),material,uv.xy),fract(mip));
    vec3 light=textureLod(uLightmaps,vec3(uv.zw,edge.w),0.0).rgb;
    vec3 color=albedo*light;
    if(uDebug==1)color=albedo;
    if(uDebug==2)color=light;
    if(uDebug==3)color=0.5+0.5*normalize(n);
    if(uDebug==4)color*=0.25;
    outColor=vec4(color,1.0);
}
