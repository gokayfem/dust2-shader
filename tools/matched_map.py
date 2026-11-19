"""Two-pass rendering and lossless material resources for the reference edition."""
import io
import struct
from PIL import Image
from tiny_materials import bsp_materials, load_wad, MIP_HEADER, HIDDEN, WAD_ENTRY


def original_wad(assets):
    lumps = {}
    for filename in ('cs_dust.wad', 'base-textures.wad'):
        lumps.update(load_wad(assets / filename))
    output = bytearray(12)
    directory = bytearray()
    for name, texture in bsp_materials(assets / 'de_dust2.bsp'):
        if name in HIDDEN or name.startswith('sky'):
            continue
        if not MIP_HEADER.unpack_from(texture)[3]:
            texture = lumps[name]
        _, w, h, _, _, _, last = MIP_HEADER.unpack_from(texture)
        palette = last + (w >> 3) * (h >> 3)
        end = palette + 2 + 3 * struct.unpack_from('<H', texture, palette)[0]
        directory.extend(WAD_ENTRY.pack(len(output),end,end,0x43,0,name.encode()))
        output.extend(texture[:end])
    struct.pack_into('<4sII',output,0,b'WAD3',len(directory)//WAD_ENTRY.size,len(output))
    return output + directory


def original_sky(assets,sides):
    width = Image.open(assets/'rt.png').width
    sheet = Image.new('RGB',(width*3,width*2))
    for i,side in enumerate(sides):
        sheet.paste(Image.open(assets/(side+'.png')).convert('RGB'),(i%3*width,i//3*width))
    output=io.BytesIO()
    sheet.save(output,format='PNG',optimize=True)
    return output.getvalue()


def shading_pass(source):
    source=source.replace('out vec4 outColor;', 'uniform int pass; uniform sampler2D visibility; out vec4 outColor;')
    source=source.replace('if(uShot>=0.0 && rifle(weapon))','if(pass!=1 && uShot>=0.0 && rifle(weapon))')
    return source.replace('int hit=nearestSurface(ray,depth,bary);', '''
    int hit;
    if(pass==2){
        vec4 sampleHit=texelFetch(visibility,ivec2(gl_FragCoord.xy),0);
        hit=int(sampleHit.x);depth=sampleHit.y;bary=sampleHit.zw;
    }else{
        hit=nearestSurface(ray,depth,bary);
        if(pass==1){outColor=vec4(float(hit),depth,bary);return;}
    }''')


def renderer_pass(ray):
    anchor='    function draw(eye'
    ray=ray.replace(anchor,'''    const visibility=gl.createTexture(), target=gl.createFramebuffer();
    const pass=pipeline.uniform("pass"), unit=gameUnit+1;
    gl.uniform1i(pipeline.uniform("visibility"),unit);
    let width=0,height=0;
'''+anchor)
    anchor='      gl.drawArrays(gl.TRIANGLES, 0, 3);'
    return ray.replace(anchor,'''      gl.activeTexture(gl.TEXTURE0+unit);
      gl.bindTexture(gl.TEXTURE_2D,visibility);
      if(width!==canvas.width||height!==canvas.height){
        width=canvas.width;height=canvas.height;
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,width,height,0,gl.RGBA,gl.FLOAT,null);
      }
      if(shot!==-2){
        gl.bindTexture(gl.TEXTURE_2D,null);
        gl.bindFramebuffer(gl.FRAMEBUFFER,target);
        gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,visibility,0);
        gl.uniform1i(pass,1);gl.drawArrays(gl.TRIANGLES,0,3);
        gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.bindTexture(gl.TEXTURE_2D,visibility);
      }
      gl.uniform1i(pass,shot===-2?0:2);
'''+anchor).replace('sceneDrawCalls: 1','sceneDrawCalls: 2')

def fit_coefficients(assets):
    """Fit periodic RGB material functions in original texture coordinates."""
    import numpy as np
    from tiny_materials import material_image, material_uses
    uses=material_uses(assets/'de_dust2.bsp')
    lumps={}
    for f in ('cs_dust.wad','base-textures.wad'):
        lumps.update(load_wad(assets/f))
    data=bytearray()
    for name,tex in bsp_materials(assets/'de_dust2.bsp'):
        if not uses[name] or name in HIDDEN or name.startswith('sky'):
            continue
        if not MIP_HEADER.unpack_from(tex)[3]:
            tex=lumps[name]
        image=np.asarray(material_image(name,tex,128),dtype=float)/255
        h,w=image.shape[:2]
        freq=np.fft.rfft2(image,axes=(0,1))/(w*h)
        power=np.sum(abs(freq)**2,axis=2)
        power[0,0]=0
        power[h//2+1:,0]=0
        power[:,w//2:]=0
        power[h//2,:]=0
        n=60
        data.extend(name.encode().ljust(16,b'\0'))
        data.extend(bytes(np.clip(np.round(freq[0,0].real*255),0,255).astype('u1')))
        selected=np.argsort(power.ravel())[-n:]
        luma=image @ np.array([.25,.55,.20])
        captured=sum(2*abs(freq.reshape(-1,3)[idx] @ np.array([.25,.55,.20]))**2 for idx in selected)
        data.append(min(255,round(600*np.sqrt(max(0,float(luma.var())-captured)))))
        for idx in selected:
            y,x=np.unravel_index(idx,power.shape)
            ky=y if y<h//2 else y-h
            c=2*freq[y,x]*np.exp(-1j*np.pi*(x/w+ky/h))
            luma=c @ np.array([.25,.55,.20])
            def signed(v):
                return int(np.clip(np.rint(127+np.sign(v)*np.sqrt(abs(v))*180),0,254))
            data.extend(bytes([x,ky+128,signed(luma.real),signed(luma.imag)]))
    return data


def fitted_renderer(work,ray):
    path=work/'tiny/load.js'
    path.write_text(path.read_text().replace('window.tinyData=null','const wads=window.tinyData[1];wads.light=window.tinyData[2];window.tinyData=null').replace('return {map}', 'return {map,wads}'))
    path=work/'mesh.js'
    mesh=path.read_text()
    mesh=mesh.replace('const chart = {page:0,at:()=>[0,0]};', """const {low,high}=faceBounds(texels);
      const [base,blue,slopes]=textures.light.subarray(i*3,i*3+3);
      const chart={page:0, at:(s,t)=>{
        const x=(s/16-Math.floor(Math.fround(low[0])/16))/Math.max(1,Math.ceil(Math.fround(high[0])/16)-Math.floor(Math.fround(low[0])/16));
        const y=(t/16-Math.floor(Math.fround(low[1])/16))/Math.max(1,Math.ceil(Math.fround(high[1])/16)-Math.floor(Math.fround(low[1])/16));
        const v=((slopes>>4)-8)*(2*x-1)*7+((slopes&15)-8)*(2*y-1)*7;
        return [(base+v)/255,(blue+v*blue/Math.max(1,base))/255];
      }};""")
    path.write_text(mesh)
    path=work/'ray-tree.js' 
    path.write_text(path.read_text().replace('family(batches[material].name)','material'))
    begin=ray.index('    const rifle =')
    return ray[:begin]+'''    const size=4+60*4, profiles=new Map();
    const decoder=new TextDecoder();
    for(let i=0;i<wads.length; i+=16+size){
      const name=decoder.decode(wads.subarray(i,i+16)).replace(/\\0.*$/,'');
      profiles.set(name,wads.subarray(i+16,i+16+size));
    }
    const coeffs=new Uint8Array(mesh.opaque.length*size);
    mesh.opaque.forEach((batch,i)=>coeffs.set(profiles.get(batch.name),i*size));
    upload2D("uFit",size/4,mesh.opaque.length,coeffs);
'''+ray[begin:]


def fitted_shader(scene):
    # The fitted series replaces the entire hand-authored material palette.
    scene=scene[:scene.index('vec3 mapMaterial(')]+scene[scene.index('uniform sampler2D uGame;'):]
    anchor='void main() {'
    scene=scene.replace(anchor,'''uniform sampler2D uFit;
vec3 fitted(int id,vec2 uv,vec2 du,vec2 dv){
    vec3 c=texelFetch(uFit,ivec2(0,id),0).rgb;
    vec3 tint=mix(vec3(1),c/max(.08,dot(c,vec3(.25,.55,.2))),.68);
    for(int j=0;j<60;j++){
        int col=1+j;
        vec4 k=round(texelFetch(uFit,ivec2(col,id),0)*255.);
        vec2 axis=k.xy-vec2(0,128);
        float width=max(abs(dot(axis,du)),abs(dot(axis,dv)));
        if(width>.6)continue;
        float phase=6.2831853*dot(axis,fract(uv));
        vec2 amp=(k.zw-127.)/180.;amp*=abs(amp);
        c+=tint*(amp.x*cos(phase)-amp.y*sin(phase))*(1.-smoothstep(.2,.6,width));
    }
    float footprint=max(length(du),length(dv));
    float grain=fbmLod(uv*128.,3,footprint*128.);
    c+=tint*grain*texelFetch(uFit,ivec2(0,id),0).a*1.15;
    return pow(clamp(c,0.,1.),vec3(.8));
}
'''+anchor)
    scene=scene[:scene.index('    vec3 upRay=')]+"    vec3 light;\n    "+scene[scene.index('vec3 color=mapDisplay(albedo,light);'):]
    scene=scene.replace('vec3 color=mapDisplay(albedo,light);','light=vec3(uv.z*1.015,uv.z*.985,uv.w)*(.96+.06*facing*float(open)); vec3 color=albedo*light;')
    return scene.replace('mapMaterial(material,position,n,uv.xy,footprint)','fitted(material,uv.xy,du.xy*footprint/max(length(e1),.001),dv.xy*footprint/max(length(e2),.001))').replace('if(material==5)light=max(light,vec3(.95));','')

def face_colors(raw):
    import numpy as np
    from tiny_lights import _charts
    lumps=[]
    for i in range(15):
        start,length=struct.unpack_from('<ii',raw,4+8*i)
        lumps.append(raw[start:start+length])
    sizes={off:(w,h) for off,w,h in _charts(lumps,len(lumps[8]))}
    def gamma(x):
        light=(np.minimum(1023,np.floor(x*(12*22/256)*(round(256*2**.4)/64)))/1023)**2.5
        return np.floor(np.floor(1023*np.minimum(1,light)**.4)/4)
    colors=bytearray()
    for *_,off in struct.iter_unpack('<4xiHH4si',lumps[7]):
        w,h=sizes.get(off,(0,0))
        slopes=[8,8]
        rgb=(255,255,255)
        if w:
            sample=np.frombuffer(lumps[8],dtype=np.uint8,count=3*w*h,offset=off).reshape(h,w,3)
            corrected=gamma(sample.astype(float))
            rgb=corrected.mean(axis=(0,1))
            gray=corrected[:,:,:2].mean(axis=2)
            for j,axis in enumerate([0,1]):
                line=gray.mean(axis=axis)
                if len(line)>1:
                    basis=np.linspace(-1,1,len(line))
                    slopes[j]=int(np.clip(8+round(np.dot(line,basis)/np.dot(basis,basis)/7),0,15))
        colors.extend(bytes([min(255,3*round((rgb[0]+rgb[1])/6)),min(255,3*round(rgb[2]/3)),16*slopes[0]+slopes[1]]))
    return colors
