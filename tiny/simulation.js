import {compile,program,shaderSource} from '../gl-resources.js';

// The compact BSP keeps collision headnodes only for solid map models.
function collisionTables(map,entities) {
  const b=new DataView(map), lump=i=>b.getInt32(4+8*i,true);
  const count=i=>b.getInt32(8+8*i,true), f=i=>b.getFloat32(i,true);
  const records=[];
  for(let off=lump(9);off<lump(9)+count(9);off+=8){
    const plane=lump(1)+20*b.getInt32(off,true);
    records.push(f(plane),f(plane+4),f(plane+8),f(plane+12),b.getInt16(off+4,true),b.getInt16(off+6,true),0,0);
  }
  const start=records.length/4;
  for(let i=0;i<count(14)/64;i++){
    const off=lump(14)+64*i,stand=b.getInt32(off+40,true),duck=b.getInt32(off+48,true);
    if(stand<0&&duck<0)continue;
    const entity=entities.find(e=>e.model==='*'+i);
    const origin=entity?.origin?.split(' ').map(Number)||[f(off+24),f(off+28),f(off+32)];
    for(let end=0;end<2;end++){
      for(let k=0;k<3;k++)records.push(f(off+end*12+k*4)+origin[k]+(end?40:-40));
      records.push(end?duck:stand);
    }
    records.push(...origin,0);
  }
  const rows=Math.ceil(records.length/4096),data=new Float32Array(rows*4096);data.set(records);
  return {data,rows,start,count:(records.length/4-start)/3};
}

export async function simulation(canvas,map,renderer) {
  const gl=canvas.getContext('webgl2');
  if(!gl.getExtension('EXT_color_buffer_float'))throw Error('Floating-point GPU simulation unavailable');
  const vs=compile(gl,gl.VERTEX_SHADER,await shaderSource('fullscreen.vert'));
  const sim=program(gl,vs,await shaderSource('sim.frag'));gl.deleteShader(vs);
  function texture(w,h,data){
    const tex=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,tex);
    for(const kind of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,kind,gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,w,h,0,gl.RGBA,gl.FLOAT,data);
    return tex;
  }
  const tables=collisionTables(map,renderer.entities);
  const hull=texture(1024,tables.rows,tables.data);
  const buffers=[0,1].map(()=>{
    const tex=texture(6,1,new Float32Array(24)),fb=gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Simulation buffer incomplete');
    return {tex,fb};
  });
  const pick=gl.createTexture(), pickFb=gl.createFramebuffer();
  gl.bindTexture(gl.TEXTURE_2D,pick);gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,1,1);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER,pickFb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,pick,0);
  const u=Object.fromEntries('brushStart brushes hulls oldState ticks spawn trigger pick inputKeys yaw timed'.split(' ').map(k=>[k,sim.uniform(k)]));
  gl.useProgram(sim.id);gl.uniform1i(u.brushStart,tables.start);gl.uniform1i(u.brushes,tables.count);
  gl.uniform1i(u.hulls,1);gl.uniform1i(u.oldState,0);gl.uniform1i(u.pick,2);
  const data=new Float32Array(24);let index=0,dirty=true,mode=false;
  function run(ticks,input={},yaw=0,spawn=-1,trigger=0){
    gl.useProgram(sim.id);gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,buffers[index].tex);
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,hull);
    gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,pick);
    index=1-index;gl.bindFramebuffer(gl.FRAMEBUFFER,buffers[index].fb);
    gl.viewport(0,0,6,1);
    gl.uniform1i(u.spawn,spawn);gl.uniform1i(u.trigger,trigger);gl.uniform1i(u.ticks,ticks);
    gl.uniform1i(u.timed,mode);gl.uniform1f(u.yaw,yaw);
    gl.uniform4f(u.inputKeys,input.forward||0,input.side||0,+!!input.jump,+!!input.crouch);
    gl.drawArrays(gl.TRIANGLES,0,3);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);dirty=true;
  }
  function read(){
    if(dirty){
      gl.bindFramebuffer(gl.FRAMEBUFFER,buffers[index].fb);gl.readPixels(0,0,6,1,gl.RGBA,gl.FLOAT,data);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);dirty=false;
    }
    return data;
  }
  run(0,{},0,0);
  return {
    reset(team,timed=false){mode=timed;run(0,{},0,team==='CT'?1:0);return (team==='CT'?255:10)*Math.PI/180;},
    step(dt,input,yaw){run(Math.round(dt*120),input,yaw);},
    pickFb, fire(){run(0,{},0,-1,1);},
    get texture(){return buffers[index].tex;},
    get origin(){return Array.from(read().subarray(0,3));},
    get eye(){const d=read();return [d[0],d[1],d[2]+d[3]];},
    get grounded(){return !!read()[8];},get crouched(){return !!read()[9];},
    get hits(){return read()[12];},get stage(){return read()[13];},
    get seconds(){return read()[14];},get shotAge(){return read()[15];}
  };
}
