precision highp float;
precision highp int;
uniform sampler2D oldState, hulls, pick;
uniform int brushStart, brushes, ticks, spawn, trigger;
uniform vec4 inputKeys;
uniform float yaw;
uniform bool timed;
out vec4 value;
const float dt=1./120.;
vec4 row(int n){return texelFetch(hulls,ivec2(n%1024,n/1024),0);}
vec4 state(int n){return texelFetch(oldState,ivec2(n,0),0);}

// Visit intersected BSP leaves in travel order. The entry plane supplies the contact normal.
vec4 trace(vec3 a,vec3 b,bool duck){
    vec4 best=vec4(0,0,0,1);
    vec3 travel=b-a;
    for(int j=0;j<brushes;j++){
        int h=brushStart+3*j;
        vec4 lo=row(h), hi=row(h+1);
        if(j>0 && (any(lessThan(max(a,b),lo.xyz))||any(greaterThan(min(a,b),hi.xyz))))continue;
        vec3 start=a-row(h+2).xyz;
        int node=int(duck?hi.w:lo.w),top=0;
        ivec2 pending[48]; vec2 ranges[48];
        vec2 interval=vec2(0,1); int entry=0;
        while(true){
            if(node>=0){
                vec4 plane=row(node*2), children=row(node*2+1);
                float da=dot(plane.xyz,start)-plane.w, dv=dot(plane.xyz,travel);
                float x=da+interval.x*dv,y=da+interval.y*dv;
                int side=x<0.?1:0;
                if((x<0.)!=(y<0.) && top<48){
                    float split=clamp(-da/dv,interval.x,interval.y);
                    pending[top]=ivec2(int(children[1-side]),(node+1)*(side==0?1:-1));
                    ranges[top++]=vec2(split,interval.y);
                    interval.y=split;
                }
                node=int(children[side]);
                continue;
            }
            if(node==-2){
                vec3 n=entry==0?vec3(0):row((abs(entry)-1)*2).xyz*sign(float(entry));
                float f=max(0.,interval.x-.03125/max(.000001,abs(dot(n,travel))));
                if(f<best.w)best=vec4(n,f);
                break;
            }
            if(top==0)break;
            top--;node=pending[top].x;entry=pending[top].y;interval=ranges[top];
        }
    }
    return best;
}
vec3 vertical(float z){return vec3(0,0,z);}
bool slide(inout vec3 p,inout vec3 v,bool duck){
    float left=dt;bool blocked=false;
    for(int k=0;k<4;k++){
        if(dot(v,v)<.00001)break;
        vec3 move=v*left;vec4 hit=trace(p,p+move,duck);
        p+=move*hit.w;
        if(hit.w>=1.)break;
        blocked=true;
        if(dot(hit.xyz,hit.xyz)<.5){v=vec3(0);break;}
        v-=min(0.,dot(v,hit.xyz))*hit.xyz;
        left*=1.-hit.w;
    }
    return blocked;
}
void main(){
    int slot=int(gl_FragCoord.x);
    vec4 pos=state(0),vel=state(1),flags=state(2),game=state(3);
    vec4 timers=state(slot==5?5:4);
    if(spawn>=0){
        if(slot==0)value=vec4(spawn==0?vec3(-832,-800,164.03125):vec3(448,2464,-91.96875),28);
        else if(slot==2)value=vec4(1,0,0,0);
        else if(slot==3)value=vec4(0,0,0,1);
        else value=vec4(0);
        return;
    }
    int shotId=trigger==1?int(round(255.*texelFetch(pick,ivec2(0),0).r)):-1;
    bool fired=shotId>=0 && game.w>=.165;
    if(slot>=4){
        timers=max(vec4(0),timers-float(ticks)*dt);
        int i=shotId-1-(slot-4)*4;
        if(fired&&i>=0&&i<4)timers[i]=3.;
        value=timers;return;
    }
    if(fired){game.w=0.;if(shotId>0)game.x++;}
    game.w=min(1.,game.w+float(ticks)*dt);
    for(int tick=0;tick<ticks;tick++){
        vec3 p=pos.xyz,v=vel.xyz;
        bool duck=flags.y>.5,ground=flags.x>.5,want=inputKeys.w>.5;
        if(!want)flags.w=0.;
        if(want!=duck){
            flags.w+=dt;
            if(!want||!ground||flags.w>=.4){
                vec3 next=p+vertical(ground?(want?-18.:18.):0.);
                if(trace(next,next,want).w==1.){p=next;duck=want;}
                else if(want&&ground){
                    vec4 floorHit=trace(next+vertical(2.),next,true);
                    if(floorHit.z>=.7){p=next+vertical(2.*(1.-floorHit.w));duck=true;}
                }
            }
        }
        pos.w=duck?12.:28.-(want&&ground?34.*smoothstep(0.,.4,flags.w):0.);
        vec4 floorHit=trace(p,p-vertical(2.),duck);
        ground=v.z<=0.&&floorHit.z>=.7;
        if(ground){p.z-=2.*floorHit.w;v.z=0.;float speed=length(v.xy);
            v.xy*=max(0.,1.-max(75.,speed)*4.*dt/max(.001,speed));}
        vec2 wish=mat2(cos(yaw),sin(yaw),sin(yaw),-cos(yaw))*clamp(inputKeys.xy,-1.,1.);
        float m=length(wish),speed=min(1.,m)*(duck?100.:250.);
        vec2 dir=wish/max(.00001,m);
        v.xy+=dir*clamp((ground?speed:min(30.,speed))-dot(v.xy,dir),0.,10.*speed*dt);
        if(inputKeys.z>.5&&flags.z<.5&&ground){v.z=sqrt(72000.);ground=false;}
        if(!ground)v.z-=400.*dt;
        vec3 from=p,initial=v;
        if(slide(p,v,duck)&&ground){
            vec3 raised=from+vertical(18.*trace(from,from+vertical(18.),duck).w), rv=initial;
            slide(raised,rv,duck);
            vec4 down=trace(raised,raised-vertical(20.),duck);
            if(down.z>=.7&&distance(raised.xy,from.xy)>distance(p.xy,from.xy)){
                p=raised-vertical(20.*down.w);v.xy=rv.xy;
            }
        }
        if(!ground)v.z-=400.*dt;
        if(ground||v.z<=0.){
            floorHit=trace(p,p-vertical(2.),duck);ground=floorHit.z>=.7;
            if(ground){p.z-=2.*floorHit.w;v.z=0.;}
        }
        pos.xyz=p;vel.xyz=v;flags.xyz=vec3(ground,duck,inputKeys.z>.5);
        if(timed&&game.y<2.){
            game.z+=dt;
            vec3 low=game.y==0.?vec3(1024,2304,96):vec3(-1728,2496,0);
            vec3 high=game.y==0.?vec3(1280,2624,192):vec3(-1344,2880,96);
            if(all(greaterThanEqual(p,low))&&all(lessThanEqual(p,high)))game.y++;
        }
    }
    value=slot==0?pos:slot==1?vel:slot==2?flags:game;
}
