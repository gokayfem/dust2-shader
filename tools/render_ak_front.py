"""Bake the CS 1.5 Studio viewmodel's textured front section. Takes v_ak47.mdl."""
from pathlib import Path
import struct
import sys
import numpy as np
from PIL import Image

data = Path(sys.argv[1]).read_bytes()
def ints(offset, count):
    return struct.unpack_from(f'<{count}i', data, offset)

texture_count, textures = ints(180, 2)
body = ints(208, 1)[0]
model = ints(body + 72, 1)[0]
mesh_count, meshes, count, _, vertices = ints(model + 72, 5)
points = np.frombuffer(data, '<f4', count*3, vertices).reshape(-1, 3)
view = np.stack((points[:,0]+2.6, points[:,2]-7.8, -points[:,1]), axis=1)
scale = 900
size = (432, 450)
pixels = np.zeros((size[1],size[0],4), dtype=np.uint8)
depth = np.zeros(pixels.shape[:2])
for mesh in range(mesh_count):
    _, pos, slot, _, _ = ints(meshes + mesh*20, 5)
    entry = textures + slot*80
    name = data[entry:entry+64].split(b'\0')[0]
    if name not in {b'forearm.bmp', b'barrel.bmp'}:
        continue
    _, w, h, offset = ints(entry+64,4)
    indexed = np.frombuffer(data, np.uint8, w*h, offset).reshape(h,w)
    palette = np.frombuffer(data,np.uint8,768,offset+w*h).reshape(256,3)
    while (run := struct.unpack_from('<h', data, pos)[0]):
        pos += 2
        commands = np.frombuffer(data,'<i2',abs(run)*4,pos).reshape(-1,4)
        pos += abs(run)*8
        for i in range(2,abs(run)):
            triangle = commands[[0 if run<0 else i-2,i-1,i]]
            v = view[triangle[:,0]]
            xy = v[:,:2] / v[:,2,None]
            x,y = (xy[:,0]-.04)*scale, (-.07-xy[:,1])*scale
            l,r=max(0,int(x.min())),min(size[0],int(x.max())+1)
            t,b=max(0,int(y.min())),min(size[1],int(y.max())+1)
            if l>=r or t>=b: continue
            denom=(y[1]-y[2])*(x[0]-x[2])+(x[2]-x[1])*(y[0]-y[2])
            if abs(denom)<1e-7: continue
            yy,xx=np.mgrid[t:b,l:r]+.5
            a=((y[1]-y[2])*(xx-x[2])+(x[2]-x[1])*(yy-y[2]))/denom
            c=((y[2]-y[0])*(xx-x[2])+(x[0]-x[2])*(yy-y[2]))/denom
            weights=np.stack((a,c,1-a-c),axis=-1)/v[:,2]
            z=weights.sum(axis=-1)
            mask=(weights.min(axis=-1)>=0)&(z>depth[t:b,l:r])
            uv=np.einsum('ni,ij->nj',weights[mask],triangle[:,2:])/z[mask,None]
            rgb=palette[indexed[uv[:,1].astype(int)%h,uv[:,0].astype(int)%w]]
            pixels[t:b,l:r][mask]=np.column_stack((rgb,np.full(len(rgb),255)))
            depth[t:b,l:r][mask]=z[mask]
Image.fromarray(pixels).resize((192,200),Image.Resampling.LANCZOS).save(Path(__file__).resolve().parents[1]/'assets/ak-front.avif', quality=48, speed=3)
