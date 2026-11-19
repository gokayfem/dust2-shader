"""Specialize the tiny renderer to GLSL map materials and ray-traced sunlight."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def specialize(work, ray):
    (work/'tiny/load.js').write_text("""import {decodeGeometry} from './geometry.js';
export function unpackScene(){
  const map=decodeGeometry(window.tinyData[0],new Uint8Array());
  window.tinyData=null;
  return {map};
}""")
    path=work/'tiny/geometry.js'
    path.write_text(path.read_text().replace('lightOffset !== lightLength || ', '').replace('if (lit) {','if (lit && lightLength) {'))
    path=work/'mesh.js'
    mesh=path.read_text().replace('const pages = [newPage(atlasSize)];','const pages = [];')
    mesh=mesh.replace('descriptor?.levels.length ? descriptor : textures.get(name)','descriptor')
    mesh=mesh.replace('lightmap(bsp, face, texels, pages, atlasSize, lightWeights)','{page:0,at:()=>[0,0]}')
    path.write_text(mesh)
    path=work/'ray-tree.js'
    tree=path.read_text()
    families="""const family=name=>/door/.test(name)?2:/crt/.test(name)?1:/trim/.test(name)?3:/ccrete/.test(name)?4:/lgt|white/.test(name)?5:/wndw/.test(name)?6:/rock|black|credit|generic/.test(name)?7:/^-.[s]and$|sandroad/.test(name)?8:0;
  """
    tree=tree.replace('const batches =',families+'const batches =').replace('? -1 : material;', '? -1 : family(batches[material].name);')
    path.write_text(tree)
    ray=ray.replace('  const material = packRayMaterials(mesh.opaque);','')
    return ray[:ray.index('    upload2D("uMaterials"')]+ray[ray.index('    const rifle ='):]


def scene_shader(scene):
    start=scene.index('vec3 skyColor(')
    scene=scene[:start]+(ROOT/'shaders/map-materials.glsl').read_text()+'\n'+scene[scene.index('uniform sampler2D uGame;',start):]
    scene=scene.replace('skyColor(ray)','desertSky(ray)')
    scene=scene[:scene.index('    vec2 dimensions=')]+"""
    n=normalize(n);
    vec3 position=camera+ray*depth;
    float footprint=pixel*depth/max(.15,abs(dot(normalize(ray),n)));
    vec3 albedo=mapMaterial(material,position,n,uv.xy,footprint);
    // Trace lighting rays against the same map BVH as the camera ray.
    camera=position+n*.28;
    float shadowDistance;vec2 ignored;
    float facing=max(dot(n,sunDir),0.);
    int blocker=nearestSurface(sunDir,shadowDistance,ignored);
    bool open=blocker<0 || entry(uTriangles,3*max(0,blocker)).w<0.;
    vec3 upRay=normalize(vec3(.19,.11,1.)+n*.55);
    int roof=nearestSurface(upRay,shadowDistance,ignored);
    float enclosure=roof>=0 && entry(uTriangles,3*max(0,roof)).w>=0.?exp(-shadowDistance/380.):0.;
    vec3 ambient=mix(vec3(.63,.66,.69),vec3(.28,.24,.20),enclosure);
    vec3 light=ambient+vec3(.69,.59,.43)*facing*float(open);
    if(material==5)light=max(light,vec3(.95));
    vec3 color=mapDisplay(albedo,light);
    color=mix(color,vec3(.78,.72,.60),.22*(1.-exp(-depth/3200.)));
    if(uDebug==1)color=albedo;
    if(uDebug==2)color=light;
    if(uDebug==3)color=.5+.5*n;
    if(uDebug==4)color=vec3(fract(float(material)*vec3(.273,.549,.719)));
    outColor=vec4(color,1);
}
"""
    for sampler in ['uMaterials','uMaterialInfo','uLightmaps','uSky']:
        import re
        scene=re.sub(r'uniform sampler\w+ '+sampler+r';\n','',scene)
    return scene
