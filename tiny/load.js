import {decodeGeometry} from './geometry.js';
import {decodeLights} from './lights.js';
import {decodeMaterials} from './materials.js';

export async function unpackScene() {
  const [geometry, materials, light, skyImage] = window.tinyData;
  const [lighting, textures, sky] = await Promise.all([
    decodeLights(light),
    decodeMaterials(materials),
    createImageBitmap(new Blob([skyImage], {type:'image/avif'})),
  ]);
  const map = decodeGeometry(geometry, lighting);
  const names = ['rt','lf','ft','bk','up','dn'];
  const side = sky.width/3;
  const images = await Promise.all(names.map((name,i)=>
    createImageBitmap(sky,(i%3)*side,Math.floor(i/3)*side,side,side)
  ));
  sky.close();
  window.tinyData = null;
  return {map, wads:textures, skyImages:Object.fromEntries(names.map((key,i)=>[key,images[i]]))};
}
