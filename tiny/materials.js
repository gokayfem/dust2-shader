import {PALETTE_GAMMA} from '../gamma.js';

export async function decodeMaterials(bytes) {
  const reader = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder();
  if (text.decode(bytes.subarray(0, 4)) !== 'TMT2') throw Error('Invalid material atlas');
  const count = reader.getUint16(4, true);
  const sheet = await createImageBitmap(new Blob([bytes.subarray(6 + 22 * count)], {type:'image/avif'}));
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', {willReadFrequently:true});
  const textures = new Map();
  try {
    for (let i = 0; i < count; i++) {
      const off = 6 + 22 * i;
      const name = text.decode(bytes.subarray(off, off+16)).replace(/\0.*$/, '');
      const x = reader.getUint16(off+16,true), y = reader.getUint16(off+18,true);
      const w = bytes[off+20], h = bytes[off+21];
      const levels = [];
      for (let mip=0; mip<4; mip++) {
        const width=canvas.width=Math.max(1,w>>mip), height=canvas.height=Math.max(1,h>>mip);
        ctx.imageSmoothingQuality='high';
        ctx.drawImage(sheet,x,y,w,h,0,0,width,height);
        const rgba=ctx.getImageData(0,0,width,height).data;
        for(let j=0;j<rgba.length;j+=4)
          for(let k=j;k<j+3;k++) rgba[k]=PALETTE_GAMMA[rgba[k]];
        levels.push({width,height,rgba});
      }
      textures.set(name,{name,levels});
    }
  } finally { sheet.close(); }
  return textures;
}
