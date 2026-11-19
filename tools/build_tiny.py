"""Generate a directly playable offline HTML from the verified map and shader."""
import argparse
import gzip
import io
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import struct
import subprocess
import tempfile
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
from PIL import Image

from tiny_geometry import encode_geometry
from tiny_materials import pack_materials
from tiny_lights import pack_lights

ROOT = Path(__file__).resolve().parents[1]
package_game = runpy.run_path(str(ROOT / 'tools/package-game.py'))
SIDES = ['rt','lf','ft','bk','up','dn']


def pack_sky(size, quality):
    sheet = Image.new('RGB', (3*size, 2*size))
    for i, name in enumerate(SIDES):
        image = Image.open(ROOT / 'assets' / (name+'.png')).convert('RGB')
        sheet.paste(image.resize((size,size),Image.Resampling.LANCZOS),((i%3)*size,(i//3)*size))
    output = io.BytesIO()
    sheet.save(output,format='AVIF',speed=3,quality=quality)
    return output.getvalue()


def compile_client(work, bundler, light_quality, procedural=False, matched=None):
    for name in package_game['FILES']:
        if name.endswith('.js'):
            (work / name).write_bytes(package_game['pack_file'](name))
    shutil.copytree(ROOT / 'tiny', work / 'tiny')
    # This release has only opaque, stationary brush models, no brush rotations
    # or placed decals. Drop those generic importer branches from this one map.
    path = work / 'mesh.js'
    mesh = path.read_text()
    mesh = mesh.replace('const appearance = brushAppearance(entity);','const appearance = {blend:0,tint:[1,1,1],alpha:1,forceMask:false};')
    mesh = mesh.replace('const xform = index ? brushTransform(entity, model) : { rotate: point => point, transform: point => point };','')
    mesh = mesh.replace('verts.map(xform.transform)', 'verts').replace('xform.rotate(plane.map(v => face.side ? -v : v))','plane.map(v => face.side ? -v : v)')
    mesh = mesh.replace('const decals = buildDecals(bsp.entities, receivers, textures, missingDecals);','const decals = [];')
    mesh = mesh.replace('receivers.push({ verts, s: texinfo.s, t: texinfo.t, normal, chart });','')
    path.write_text(mesh)
    if light_quality == 0:
        path = work / 'tiny/lights.js'
        text = path.read_text()
        pos = text.index('  if (!scale)', text.index('export async function decodeLights'))
        path.write_text(text[:pos] + '  if(scale!==GRADIENT_MODE) throw Error("Unexpected light data");\n  return decodeGradients(await inflate(bytes.subarray(HEADER_BYTES)),dimensionsLength,length);\n}\n')
    path = work / 'ray-renderer.js'
    import base64
    rifle = base64.b64encode((ROOT / 'assets/ak-front.avif').read_bytes()).decode('ascii')
    ray = path.read_text().replace('fetch("assets/ak-front.avif")', 'fetch("data:image/avif;base64,' + rifle + '")')
    start = ray.index('  const textures = new Map();')
    end = ray.index('  const lightSize', start)
    ray=ray[:start] + '  const textures = wads;\n' + ray[end:]
    ray=ray.replace('const respawn = new Float64Array(8);','const gameUnit=samplers.length; gl.uniform1i(pipeline.uniform("uGame"),gameUnit); let game;')
    start=ray.index('      const now = performance.now();')
    end=ray.index('      gl.uniform1f(uniforms.uShot',start)
    ray=ray[:start]+'      gl.activeTexture(gl.TEXTURE0+gameUnit); gl.bindTexture(gl.TEXTURE_2D,game.texture);\n'+ray[end:]
    ray=ray.replace('resetTargets() { respawn.fill(0); },','setSimulation(sim) { game=sim; },').replace('if(pixel[0]) respawn[pixel[0]-1]=performance.now()+3000;', 'game.fire(pixel[0]);')
    start=ray.index('        const pixel=new Uint8Array(4);')
    end=ray.index('        return pixel[0];', start)+len('        return pixel[0];')
    ray=ray[:start]+"""        gl.bindFramebuffer(gl.FRAMEBUFFER,game.pickFb);
        gl.enable(gl.SCISSOR_TEST);gl.scissor(0,0,1,1);
        try { draw(null,yaw,pitch,90,0,-2); }
        finally { gl.disable(gl.SCISSOR_TEST);gl.bindFramebuffer(gl.FRAMEBUFFER,null); }
        game.fire();"""+ray[end:]
    ray=ray.replace('gl.uniform3fv(uniforms.uEye, eye);','gl.uniform3fv(uniforms.uEye, eye || [0,0,0]);')
    if procedural or matched=='fitted':
        from procedural_map import specialize
        ray=specialize(work,ray)
        if matched=="fitted":
            from matched_map import fitted_renderer
            ray=fitted_renderer(work,ray)
    if matched:
        from matched_map import renderer_pass
        ray=renderer_pass(ray)
    path.write_text(ray)
    path = work / 'ray-materials.js'
    path.write_text(path.read_text().replace('rgbaPixels(batch.texture, level, false)', 'level.rgba'))
    if matched=='original':
        path=work/'tiny/load.js'
        path.write_text(path.read_text().replace("import {decodeMaterials} from './materials.js'","import {readWad as decodeMaterials} from '../bsp.js'").replace('image/avif','image/png'))
        shutil.copyfile(ROOT/'ray-materials.js',work/'ray-materials.js')
    path = work/'app.js'
    code = path.read_text()
    start = code.index('  const suffixes = ')
    end = code.index('  player = createMovement(map);',start)
    code = code[:start] + '''  const {map,wads,skyImages} = await unpackScene();
  renderer = await createRayRenderer(canvas,map,wads,skyImages);
  el("shader-link").href = URL.createObjectURL(new Blob([await shaderSource("scene-ray.frag")], {type:"text/plain"}));
''' + code[end:]
    code=code.replace('player = createMovement(map);','player = await simulation(canvas,map,renderer); renderer.setSimulation(player);')
    code=code.replace('challenge = createChallenge(renderer.entities, renderer.models);','challenge=player;')
    code=code.replace('player.reset(session.team)','player.reset(session.team,session.mode!=="free")')
    code=code.replace('  challenge.reset();','').replace('  renderer.resetTargets?.();','')
    code=code.replace('if (playing && now-lastShot>=165)', 'if (playing)').replace('if(renderer.shoot?.(player.eye,yaw,pitch)) hits++;','renderer.shoot(null,yaw,pitch);')
    code=code.replace('if (session.mode !== "free") challenge.step(player.origin, tick);','')
    code=code.replace('"Target hits · "+hits','"Target hits · "+player.hits').replace('Math.min(1, Math.max(0, (now-lastShot)/1000))','2').replace('renderer.draw(player.eye','renderer.draw(null')
    code=code.replace('playing ? 2 : -1','playing ? 2 : -3')
    code=code.replace('el("shader-link").href = URL.createObjectURL', 'el("sim-link").href = URL.createObjectURL(new Blob([await shaderSource("sim.frag")],{type:"text/plain"})); el("shader-link").href = URL.createObjectURL')
    code="import {simulation} from './tiny/simulation.js';\n"+code
    path.write_text("import {unpackScene} from './tiny/load.js';\nimport {shaderSource} from './gl-resources.js';\n"+code)
    path = work/'gl-resources.js'
    code = path.read_text()
    start,end = code.index('export async function shaderSource'),code.index('export function compile')
    shaders = {name:(ROOT / 'shaders' / (name+'.glsl')).read_text() for name in ['fullscreen.vert','scene-ray.frag','sim.frag']}
    shaders['scene-ray.frag']=shaders['scene-ray.frag'].replace('uniform int uDown;', 'uniform sampler2D uGame;').replace('if((uDown & (1<<i))!=0)', 'if(texelFetch(uGame,ivec2(4+i/4,0),0)[i%4]>0.)')
    scene=shaders['scene-ray.frag'].replace('uniform vec3 uEye,', 'vec3 camera; uniform vec3 uEye,')
    scene=scene.replace('-uEye','-camera').replace('- uEye','- camera').replace('uEye-a','camera-a')
    scene=scene.replace('void main() {','void main() { vec4 pos=texelFetch(uGame,ivec2(0),0); camera=(uShot==2.||uShot<=-2.)?pos.xyz+vec3(0,0,pos.w):uEye;')
    shaders['scene-ray.frag']=scene.replace('1.-uShot*7.', '1.-age*7.').replace('uShot<.078','age<.078').replace('uShot/.078','age/.078').replace('bool rifle(out vec3 color) {','bool rifle(out vec3 color) { float age=texelFetch(uGame,ivec2(3,0),0).w;')
    shaders['scene-ray.frag']=shaders['scene-ray.frag'].replace('uniform sampler2D uGame;', '').replace('uniform float uShot;', 'uniform sampler2D uGame; uniform float uShot;')
    if procedural or matched=='fitted':
        from procedural_map import scene_shader
        shaders["scene-ray.frag"]=scene_shader(shaders["scene-ray.frag"])
        if matched=="fitted":
            from matched_map import fitted_shader
            shaders["scene-ray.frag"]=fitted_shader(shaders["scene-ray.frag"])
    if matched:
        from matched_map import shading_pass
        shaders['scene-ray.frag']=shading_pass(shaders['scene-ray.frag'])
    shaders={name:re.sub(r'//[^\n]*','',source) for name,source in shaders.items()}
    if procedural or matched=='fitted':
        shaders["scene-ray.frag"]="/*"+(ROOT/"shaders/shader-skills.LICENSE.txt").read_text()+"*/\n"+shaders["scene-ray.frag"]
    path.write_text(code[:start] + 'const shaderText='+json.dumps(shaders)+';\nexport async function shaderSource(name){return "#version 300 es\\n"+shaderText[name];}\n'+code[end:])
    subprocess.run([bundler,str(work/'app.js'),'--bundle','--format=esm','--target=es2022','--minify','--log-level=error','--outfile='+str(work/'game.mjs')],check=True)
    return (work/'game.mjs').read_bytes()


def make_page(parts, codec, bundler):
    payload = b''.join(struct.pack('<I',len(part)) for part in parts)+b''.join(parts)
    if codec == 'lzma':
        from tiny_lzma import compress_lzma, inline_lzma
        compressed = compress_lzma(payload)
        decoder = gzip.compress(inline_lzma(bundler),compresslevel=9,mtime=0)
    else:
        compressed = gzip.compress(payload,compresslevel=9,mtime=0)
        decoder = None

    def embed(name, data):
        # Preserve HTML raw-text delimiters, NUL and carriage returns explicitly.
        special = {0:65, 1:66, 13:67, 60:68}
        quoted = bytearray()
        for value in data:
            if value in special:
                quoted.extend((1,special[value]))
            else:
                quoted.append(value)
        return b'<script id="' + name + b'" type="application/octet-stream">' + quoted + b'</script>'

    head = b'''<!doctype html><html lang="en"><meta charset="windows-1252"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#171a15"><link rel="icon" href="data:,"><title>Dust II - Tiny</title><body style="background:#171a15;color:#fff9e9"><p>Loading Dust II...</p>'''
    if decoder:
        decoder_tag = embed(b"d", decoder)
        unpack = "const lib=document.createElement('script');lib.textContent=utf.decode(await gunzip(read('d')));document.head.append(lib);const raw=window.decodeLzma(read('p'));"
    else:
        decoder_tag = b""
        unpack = "const raw=await gunzip(read('p'));"
    bootstrap = '''<script type="module">
try{
const utf=new TextDecoder(),dec=new TextDecoder("windows-1252"),lut=new Uint8Array(65536);for(let i=0;i<256;i++)lut[dec.decode(Uint8Array.of(i)).charCodeAt(0)]=i;
const src=document.characterSet.toLowerCase()==="utf-8"?dec.decode(await(await fetch(location.href)).arrayBuffer()):"";
function read(id){const s=src?src.split('id="'+id+'" type="application/octet-stream">')[1].split('</scr'+'ipt>')[0]:document.getElementById(id).textContent,r=new Uint8Array(s.length),e=[0,1,13,60];let n=0;for(let j=0;j<s.length;j++){let v=lut[s.charCodeAt(j)];r[n++]=v===1?e[s.charCodeAt(++j)-65]:v}return r.subarray(0,n)}
async function gunzip(b){return new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer())}
UNPACK
const d=new DataView(raw.buffer,raw.byteOffset,raw.byteLength),parts=[];let j=28;for(let i=0;i<7;i++){let n=d.getUint32(i*4,true);parts.push(raw.subarray(j,j+n));j+=n}
const css=document.createElement("style");css.textContent=utf.decode(parts[0]);document.head.append(css);document.body.innerHTML=utf.decode(parts[1]);window.tinyData=parts.slice(3);
const script=document.createElement("script");script.type="module";script.textContent=utf.decode(parts[2]);document.body.append(script)
}catch(e){document.body.textContent="Could not unpack Dust II: "+e.message}
</script></body></html>'''.replace("UNPACK",unpack).encode("ascii")
    return head + embed(b"p",compressed) + decoder_tag + bootstrap, len(compressed)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    group=parser.add_mutually_exclusive_group()
    group.add_argument('--procedural', action='store_true')
    group.add_argument('--matched',choices=('original','compact','fitted'))
    parser.add_argument('--material-size',type=int,default=64)
    parser.add_argument('--material-quality',type=int,default=26)
    parser.add_argument('--sky-size',type=int,default=48)
    parser.add_argument('--sky-quality',type=int,default=25)
    parser.add_argument('--light-quality',type=int,default=0)
    parser.add_argument('--codec',choices=('gzip','lzma'),default='lzma')
    parser.add_argument('--output',type=Path,default=ROOT/'dust2-tiny.html')
    parser.add_argument('--esbuild',default=os.environ.get('ESBUILD') or shutil.which('esbuild'))
    args=parser.parse_args()
    if args.matched=='original':
        args.light_quality=100
    if not args.esbuild:
        parser.error('Set ESBUILD to an esbuild executable or install it on PATH.')
    with tempfile.TemporaryDirectory(prefix='dust2-tiny-build-') as folder:
        work=Path(folder)
        js=compile_client(work,args.esbuild,args.light_quality,args.procedural,args.matched)
    css=b'\n'.join((ROOT/n).read_bytes() for n in ['style.css','touch.css'])
    css=subprocess.run([args.esbuild,'--loader=css','--minify'],input=css,stdout=subprocess.PIPE,check=True).stdout
    original_html=package_game['pack_file']('index.html').decode()
    body=original_html.split('<body>',1)[1].split('</body>',1)[0]
    body=re.sub(r'<script\b[^>]*>\s*</script>','',body)
    body=body.replace('href="shaders/scene-ray.frag.glsl"','href="#"')
    if args.matched == 'compact':
        body = body.replace('<div id="menu">', '<div id="menu" hidden>')
    body=body.replace('</nav>','<a id="sim-link" target="_blank">Gameplay shader ↗</a></nav>',1)
    body=re.sub(r'>\s+<','><',body)
    raw=(ROOT/'assets/de_dust2.bsp').read_bytes()
    parts=[css,body.encode(),js,encode_geometry(raw)]
    if args.matched=='original':
        from matched_map import original_wad,original_sky
        parts.extend([original_wad(ROOT/'assets'),pack_lights(raw,100),original_sky(ROOT/'assets',SIDES)])
    elif args.matched=='fitted':
        from matched_map import fit_coefficients,face_colors
        parts.extend([fit_coefficients(ROOT/'assets'),face_colors(raw),b''])
    else:
        parts.extend([b"",b"",b""] if args.procedural else [pack_materials(ROOT,args.material_size,args.material_quality,args.matched=="compact"),pack_lights(raw,args.light_quality),pack_sky(args.sky_size,args.sky_quality)])
    html,packed_size=make_page(parts,args.codec,args.esbuild)
    if args.matched == 'compact':
        html = html.replace(b'<p>Loading Dust II...</p>', b'', 1)
    args.output.write_bytes(html)
    zip_path=args.output.with_suffix('.zip')
    with ZipFile(zip_path,'w') as archive:
        item=ZipInfo(args.output.name,date_time=(1980,1,1,0,0,0))
        item.external_attr=0o100644<<16
        archive.writestr(item,html,compress_type=ZIP_DEFLATED,compresslevel=9)
    print(json.dumps({'parts':{n:{'raw':len(v),'gzip':len(gzip.compress(v,mtime=0))} for n,v in zip(['css','ui','js','geometry','materials','light','sky'],parts)},'codec':args.codec,'compressedPayload':packed_size,'html':len(html),'zip':zip_path.stat().st_size},indent=2))

if __name__=='__main__':
    main()
