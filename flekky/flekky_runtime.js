/* ══════════════════════════════════════════════════════════════════════════
   フリッキー ランタイム（2026-09-22）

   いままで `editor.html` の中にあった「動かす部分」だけを、ここへ切り出した。
   **editor.html と、ゲーム（solo_show/game/break_beyond.html）が、同じこのファイルを読む。**

   坂田「アイフレームもなくしてゲームに入れ込んじゃおう フリッキー」。
   ゲームは今まで editor.html を iframe で置いていた。同じサイトの iframe は
   親と同じ1本のスレッドで動くので、1コマごとに
     ①ゲームのループ → ②postMessage の処理 → ③サンプラーの描画
   が順番待ちしていた。加えて全画面の screen 合成が毎コマ走る。
   ここを直接読み込みに変えると、②と合成が丸ごと無くなる。

   ★書き写しにはしない。**1本のファイルを2か所が読む。**
     書き写すと、片方だけ直して事故る（このプロジェクトで何度も起きている）。
     editor.html は本番の .mov を焼く道具でもあるので、壊せない。

   ここに入っているもの：サンプラー本体／形／状態と口パク／音源／描画／字幕／コマ送り／
                         ゲーム内で動かす本番再生モード
   入っていないもの（editor.html に残す）：操作・録画・サイドバー・焼き込み

   ★名前を4つだけ変えてある（ゲーム側と衝突したため）。
     G→FK_G   CAM→FK_CAM   cv→FK_cv   frame→FK_frame
     `S.frame` のようなプロパティ名や、関数の中のローカル変数 `cv` はそのまま。
   ══════════════════════════════════════════════════════════════════════════ */

/* ★素材の置き場所。editor.html からは '' （同じ階層）、
   ゲームからは 'flekky/' を先に入れてもらう（window.FLEKKY_BASE）。 */
const FK_BASE = (typeof window !== 'undefined' && window.FLEKKY_BASE) || '';

/* ★設定の受け口（2026-09-22）。
   エディタは URL の ?embed=1&res=1&fps=0&vv=… で渡してきた。
   ゲームは iframe ではなく**同じページの中**で動かすので、URL では渡せない。
   `window.FLEKKY_OPTS` を見て、無ければ今までどおり URL を見る。 */
const FK_Q = new URLSearchParams(location.search);
const FK_OPT = (typeof window !== 'undefined' && window.FLEKKY_OPTS) || null;
function FK_get(k, dflt){
  if(FK_OPT && k in FK_OPT) return FK_OPT[k];
  const v = FK_Q.get(k);
  return v == null ? dflt : v;
}
const FK_EMBED = FK_OPT ? !!FK_OPT.embed : FK_Q.has('embed');
/* 置き場所のキャンバス。エディタは #gl、ゲームは #flekky（CSSをそのまま使うため） */
const FK_CANVAS_ID = (typeof window !== 'undefined' && window.FLEKKY_CANVAS_ID) || 'gl';
/* 収まる箱。エディタは #stage、ゲームは自前の箱（ゲームの画と同じ16:9の枠）を渡す。
   箱の中で 2:1 に収めて中央に置く＝iframe だった頃とまったく同じ見え方になる。 */
const FK_STAGE_ID = (typeof window !== 'undefined' && window.FLEKKY_STAGE_ID) || 'stage';

/* エディタには状態表示がある。ゲームには無いので、無ければコンソールへ流す */
function FK_say(m){
  try{ if(typeof say === 'function'){ say(m); return; } }catch(e){}
  console.log('[フリッキー] ' + m);
}
/* 同じく、エディタの再生バー。ゲームには無いので何もしない */
function FK_syncHud(){
  try{ if(typeof syncHud === 'function') syncHud(); }catch(e){}
}

"use strict";
/* ==========================================================================
   フリッキー サンプラー
   イラスト flekky.png を立体にして、音に合わせて叩いて喋らせる。
   骨格は performance/video_sampler/editor.html と同じ:
     音を鳴らしながら収録 → イベントJSON → 決定論的に巻き戻せる
   紗幕前提: 黒が投影されない。元絵の「黒い輪郭線」は発光線に反転してある。
   ========================================================================== */

/* ---------- 行列 ---------- */
const M4={
 id:()=>new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]),
 mul(a,b){const o=new Float32Array(16);
   for(let i=0;i<4;i++)for(let j=0;j<4;j++){let s=0;
     for(let k=0;k<4;k++)s+=a[k*4+j]*b[i*4+k]; o[i*4+j]=s;} return o;},
 persp(fov,asp,n,f){const t=1/Math.tan(fov/2),o=new Float32Array(16);
   o[0]=t/asp;o[5]=t;o[10]=(f+n)/(n-f);o[11]=-1;o[14]=2*f*n/(n-f);return o;},
 trans(x,y,z){const o=M4.id();o[12]=x;o[13]=y;o[14]=z;return o;},
 scale(x,y,z){const o=M4.id();o[0]=x;o[5]=y;o[10]=z;return o;},
 rotX(a){const c=Math.cos(a),s=Math.sin(a),o=M4.id();o[5]=c;o[6]=s;o[9]=-s;o[10]=c;return o;},
 rotY(a){const c=Math.cos(a),s=Math.sin(a),o=M4.id();o[0]=c;o[2]=-s;o[8]=s;o[10]=c;return o;},
 rotZ(a){const c=Math.cos(a),s=Math.sin(a),o=M4.id();o[0]=c;o[1]=s;o[4]=-s;o[5]=c;return o;},
 lookAt(e,c,u){const z=nrm(sub(e,c)),x=nrm(cross(u,z)),y=cross(z,x);
   return new Float32Array([x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0,
     -dot(x,e),-dot(y,e),-dot(z,e),1]);},
 /* 3x3法線行列（等方スケールのみ前提だが、非等方でも逆転置で正しく出す） */
 norm3(m){const a=m[0],b=m[1],c=m[2],d=m[4],e=m[5],f=m[6],g=m[8],h=m[9],i=m[10];
   const A=e*i-f*h,B=f*g-d*i,C=d*h-e*g,det=a*A+b*B+c*C||1e-9,id=1/det;
   return new Float32Array([A*id,B*id,C*id, (c*h-b*i)*id,(a*i-c*g)*id,(b*g-a*h)*id,
     (b*f-c*e)*id,(c*d-a*f)*id,(a*e-b*d)*id]);}
};
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const nrm=a=>{const l=Math.hypot(a[0],a[1],a[2])||1;return[a[0]/l,a[1]/l,a[2]/l];};
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const lerp=(a,b,t)=>a+(b-a)*t;
const smoothstep=(e0,e1,x)=>{const t=clamp((x-e0)/(e1-e0),0,1);return t*t*(3-2*t);};

/* ---------- メッシュ ---------- */
/* 面を張った三角形の袋。pos/nrm/idx をまとめて持つだけ。 */
class Mesh{
  constructor(){this.pos=[];this.nrm=[];this.idx=[];}
  get count(){return this.idx.length;}
  /* 別のMeshを行列で焼き込んで合流させる */
  add(m,mat){
    const base=this.pos.length/3, n3=M4.norm3(mat);
    for(let i=0;i<m.pos.length;i+=3){
      const x=m.pos[i],y=m.pos[i+1],z=m.pos[i+2];
      this.pos.push(mat[0]*x+mat[4]*y+mat[8]*z+mat[12],
                    mat[1]*x+mat[5]*y+mat[9]*z+mat[13],
                    mat[2]*x+mat[6]*y+mat[10]*z+mat[14]);
      const a=m.nrm[i],b=m.nrm[i+1],c=m.nrm[i+2];
      const nx=n3[0]*a+n3[3]*b+n3[6]*c, ny=n3[1]*a+n3[4]*b+n3[7]*c, nz=n3[2]*a+n3[5]*b+n3[8]*c;
      const l=Math.hypot(nx,ny,nz)||1;
      this.nrm.push(nx/l,ny/l,nz/l);
    }
    for(const k of m.idx) this.idx.push(base+k);
    return this;
  }
}

/* 球（緯度経度）。fn(y) で高さごとに横幅を細らせる＝顎のすぼまり */
function sphere(seg=48,ring=32,fn=null,vFrom=0,vTo=1){
  const m=new Mesh();
  for(let j=0;j<=ring;j++){
    const v=vFrom+(vTo-vFrom)*(j/ring), th=v*Math.PI, sy=Math.cos(th), sr=Math.sin(th);
    const w=fn?fn(sy):1;
    for(let i=0;i<=seg;i++){
      const ph=i/seg*Math.PI*2, x=Math.cos(ph)*sr, z=Math.sin(ph)*sr;
      m.pos.push(x*w,sy,z*w);
      const n=nrm([x*(w?1/w:1),sy,z*(w?1/w:1)]);
      m.nrm.push(n[0],n[1],n[2]);
    }
  }
  for(let j=0;j<ring;j++)for(let i=0;i<seg;i++){
    const a=j*(seg+1)+i,b=a+seg+1;
    m.idx.push(a,a+1,b, a+1,b+1,b);
  }
  return m;
}
/* 円盤を厚みぶん押し出したもの。つば・目の白・歯などの平たい部品用 */
function disc(seg=40,thick=0.12){
  const m=new Mesh(), h=thick/2;
  for(const s of[1,-1]){
    const base=m.pos.length/3;
    m.pos.push(0,0,s*h); m.nrm.push(0,0,s);
    for(let i=0;i<=seg;i++){const a=i/seg*Math.PI*2;
      m.pos.push(Math.cos(a),Math.sin(a),s*h); m.nrm.push(0,0,s);}
    for(let i=0;i<seg;i++){
      if(s>0)m.idx.push(base,base+1+i,base+2+i); else m.idx.push(base,base+2+i,base+1+i);}
  }
  const base=m.pos.length/3;
  for(let i=0;i<=seg;i++){const a=i/seg*Math.PI*2,c=Math.cos(a),n=Math.sin(a);
    m.pos.push(c,n,h,c,n,-h); m.nrm.push(c,n,0,c,n,0);}
  for(let i=0;i<seg;i++){const a=base+i*2;m.idx.push(a,a+1,a+2,a+2,a+1,a+3);}
  return m;
}

/* ---------- GL ---------- */
const FK_cv=document.getElementById(FK_CANVAS_ID);
const gl=FK_cv.getContext('webgl2',{antialias:true,alpha:false,preserveDrawingBuffer:true});
if(!gl) alert('WebGL2が使えません');
const F16=gl.getExtension('EXT_color_buffer_float');

function sh(t,src){const s=gl.createShader(t);gl.shaderSource(s,src);gl.compileShader(s);
  if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s)+"\n"+src);return s;}
function prog(vs,fs){const p=gl.createProgram();
  gl.attachShader(p,sh(gl.VERTEX_SHADER,vs));gl.attachShader(p,sh(gl.FRAGMENT_SHADER,fs));
  gl.linkProgram(p); if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));
  p.u=new Proxy({},{get:(c,k)=>k in c?c[k]:(c[k]=gl.getUniformLocation(p,k))}); return p;}

/* 面：粘土。拡散はごく弱く、縁(fresnel)で立たせる。紗幕はベタ面が死ぬので縁が主役 */
const SURF=prog(`#version 300 es
in vec3 aPos; in vec3 aNorm;
uniform mat4 uMVP, uModel; uniform mat3 uN;
out vec3 vN, vW;
void main(){ vN=normalize(uN*aNorm); vW=(uModel*vec4(aPos,1)).xyz;
  gl_Position=uMVP*vec4(aPos,1); }`,
`#version 300 es
precision highp float;
in vec3 vN, vW; out vec4 o;
uniform vec3 uColor, uEye, uLight; uniform float uRim, uDiff, uEmis, uGlow;
void main(){
  vec3 N=normalize(vN), V=normalize(uEye-vW), L=normalize(uLight);
  float d=max(dot(N,L),0.0);
  /* 縁光り。視線に対して寝ている面ほど明るい＝黒背景でも塊が立体に読める */
  float f=pow(1.0-max(dot(N,V),0.0),2.4);
  vec3 c=uColor*(uDiff*(0.25+0.75*d)+uEmis) + uColor*f*uRim;
  o=vec4(c*uGlow,1.0);
}`);

/* 線：板ポリゴンに展開して太さを出す（WebGLのlineWidthは1pxしか効かない） */
const LINE=prog(`#version 300 es
in vec3 aPos; in vec3 aNext; in float aSide; in float aT;
uniform mat4 uMVP; uniform float uW, uAspect, uTaper;
out float vT;
void main(){
  vec4 a=uMVP*vec4(aPos,1), b=uMVP*vec4(aNext,1);
  vec2 sa=a.xy/a.w, sb=b.xy/b.w;
  vec2 d=normalize((sb-sa)*vec2(uAspect,1.0)+vec2(1e-6));
  vec2 n=vec2(-d.y,d.x)/vec2(uAspect,1.0);
  float w=uW*mix(1.0,1.0-aT,uTaper);
  gl_Position=vec4(a.xy+n*aSide*w*a.w, a.z, a.w);
  vT=aT;
}`,
`#version 300 es
precision highp float;
in float vT; out vec4 o;
uniform vec3 uColor; uniform float uGlow, uTaper;
void main(){ o=vec4(uColor*uGlow*mix(1.0,1.0-vT,uTaper*0.7),1.0); }`);

/* 全画面：ぼかし と 合成（halation） */
const QUAD=prog(`#version 300 es
const vec2 P[3]=vec2[3](vec2(-1,-1),vec2(3,-1),vec2(-1,3));
out vec2 uv; void main(){ vec2 p=P[gl_VertexID]; uv=p*0.5+0.5; gl_Position=vec4(p,0,1); }`,
`#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D uT; uniform vec2 uDir; uniform int uMode; uniform float uAmt;
void main(){
  if(uMode==0){                                  /* しきい値で明るい所だけ抜く */
    vec3 c=texture(uT,uv).rgb; float l=max(max(c.r,c.g),c.b);
    o=vec4(c*smoothstep(0.35,0.95,l),1.0);
  }else if(uMode==1){                            /* 分離ぼかし */
    vec3 s=vec3(0.0); float wsum=0.0;
    for(int i=-8;i<=8;i++){ float w=exp(-float(i*i)/26.0);
      s+=texture(uT,uv+uDir*float(i)).rgb*w; wsum+=w; }
    o=vec4(s/wsum,1.0);
  }else if(uMode==3){ o=texture(uT,uv); }        /* 字幕: アルファ付きで重ねる */
  else{ o=vec4(texture(uT,uv).rgb*uAmt,1.0); }   /* 加算合成 */
}`);

function mkFbo(w,h){
  const t=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,t);
  const [ifmt,typ]=F16?[gl.RGBA16F,gl.HALF_FLOAT]:[gl.RGBA8,gl.UNSIGNED_BYTE];
  gl.texImage2D(gl.TEXTURE_2D,0,ifmt,w,h,0,gl.RGBA,typ,null);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  const f=gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER,f);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);
  const rb=gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER,rb);
  gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,w,h);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,rb);
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  return {f,t,rb,w,h};
}

/* GPUに載せた面の塊 */
class GPUMesh{
  constructor(){this.vao=gl.createVertexArray();this.vb=gl.createBuffer();
    this.nb=gl.createBuffer();this.ib=gl.createBuffer();this.n=0;this.dyn=false;}
  upload(m,dynamic){
    const use=dynamic?gl.DYNAMIC_DRAW:gl.STATIC_DRAW;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.vb);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(m.pos),use);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.nb);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(m.nrm),use);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,3,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(m.idx),use);
    gl.bindVertexArray(null); this.n=m.idx.length; return this;
  }
  draw(){ if(!this.n)return; gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES,this.n,gl.UNSIGNED_SHORT,0); }
}

/* 折れ線を板ポリに展開したもの */
class GPULine{
  constructor(){this.vao=gl.createVertexArray();
    this.b={p:gl.createBuffer(),q:gl.createBuffer(),s:gl.createBuffer(),t:gl.createBuffer()};
    this.ib=gl.createBuffer(); this.n=0;}
  upload(pts,dynamic){         /* pts=[[x,y,z],...] */
    const P=[],Q=[],S=[],T=[],I=[]; const L=pts.length;
    if(L<2){this.n=0;return this;}
    for(let i=0;i<L;i++){
      const a=pts[i], b=pts[Math.min(i+1,L-1)], c=(i===L-1)?pts[L-2]:null;
      const nx=c?[2*a[0]-c[0],2*a[1]-c[1],2*a[2]-c[2]]:b;
      for(const s of[-1,1]){ P.push(a[0],a[1],a[2]); Q.push(nx[0],nx[1],nx[2]);
        S.push(s); T.push(i/(L-1)); }
      if(i<L-1){const k=i*2; I.push(k,k+1,k+2, k+2,k+1,k+3);}
    }
    const use=dynamic?gl.DYNAMIC_DRAW:gl.STATIC_DRAW;
    gl.bindVertexArray(this.vao);
    const put=(buf,arr,loc,sz)=>{gl.bindBuffer(gl.ARRAY_BUFFER,buf);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(arr),use);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc,sz,gl.FLOAT,false,0,0);};
    put(this.b.p,P,0,3); put(this.b.q,Q,1,3); put(this.b.s,S,2,1); put(this.b.t,T,3,1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(I),use);
    gl.bindVertexArray(null); this.n=I.length; return this;
  }
  draw(){ if(!this.n)return; gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES,this.n,gl.UNSIGNED_SHORT,0); }
}

/* ==========================================================================
   フリッキーの形

   プリミティブを組んで似せようとすると再現度が出ない（一度やって失敗した）。
   **元絵そのものをテクスチャとして立体に貼る。**だから正面は元絵と一致する。

     model/flekky_tex.png    元絵（口だけ消してある）
     model/flekky_height.png シルエットを距離変換で膨らませた高さマップ

   紗幕対策はシェーダ側でやる。テクスチャの黒い所を検出して、
   そこだけ発光色に差し替える＝黒線が消えずに光る線になる。
   ========================================================================== */
const P={
  scale:1.12,          // 世界座標での半径
  depth:0.62,          // 膨らみ（奥行き）
  lineMix:0.0,         // 0=元絵のまま黒い線 / 1=完全に発光線（紗幕用）
  lineGlow:1.40,       // 発光線の明るさ
  lineCut:0.30,        // どこまでを「線」とみなすか（明度のしきい値）
  amb:0.62,            // 地の明るさ。元絵は平坦な塗りなので陰影は控えめが正解
  mouthW:1.00, mouthH:1.00, mouthY:0.0, teeth:5,
  zoom:5.4,
  gaze:1.0,            // 黒目が首につられて動く量（0で固定）
  idle:1.0,            // ふわふわ・首の揺らぎの強さ
  dissolve:1.0,        // 出現/消滅の溶け際の光
  appearSec:0.85,      // 出現/消滅にかける秒数
  /* ★enterMode=1 … 溶解を使わず「下からせり上がる」。
     溶解シェーダ（画素ごとのノイズ）を通らないので、登場中も喋っている時と同じ負荷で済む。
     enterY … どれだけ下から出すか（モデル空間） */
  /* ★入る時と出る時で沈める距離を分ける（2026-09-22）。
     ・enterY … 下から**せり上がってくる**時の深さ。浅くないと、出てくるのが最後の一瞬だけになる
     ・exitY  … **沈んで消える**時の深さ。坂田「まだ頭が見えてる」→ 3倍にした
     1つの数字で両方をやると、どちらかが必ず破綻する（実際にした）。 */
  enterMode:1, enterY:2.4, exitY:7.2,
  subSize:1.0,         // 字幕の大きさ
  lineW:2.0, glow:1.0, rim:0.22, diff:0.52, halo:0.18,
};
const COL={ line:[0.62,0.98,1.00], dark:[0.02,0.02,0.03], teeth:[0.96,1.0,1.0] };

let TEX=null, PUPTEX=null, HMAP=null, HW=0, HH=0, META=null, MODEL_READY=false;

/* 高さマップの双一次補間。u,v は 0..1（v は上が0＝画像と同じ向き） */
function heightAt(u,v){
  if(!HMAP) return 0;
  const x=clamp(u,0,1)*(HW-1), y=clamp(v,0,1)*(HH-1);
  const x0=Math.floor(x), y0=Math.floor(y);
  const x1=Math.min(x0+1,HW-1), y1=Math.min(y0+1,HH-1);
  const fx=x-x0, fy=y-y0;
  const a=HMAP[y0*HW+x0], b=HMAP[y0*HW+x1], c=HMAP[y1*HW+x0], d=HMAP[y1*HW+x1];
  return lerp(lerp(a,b,fx),lerp(c,d,fx),fy);
}
const uvX=u=>(u-0.5)*2*P.scale;
const uvY=v=>(0.5-v)*2*P.scale;

/* 高さマップからグリッドを起こす。表と裏を張って閉じた立体にする */
function buildFlekky(res=200){
  const pos=[],nrm=[],uv=[],idx=[];
  const inside=(i,j)=>heightAt(i/res,j/res)>0.004;
  const gid=new Int32Array((res+1)*(res+1)).fill(-1);
  const gidB=new Int32Array((res+1)*(res+1)).fill(-1);
  const eps=3/res;                    // 差分は広めに取る。狭いと高さの段差を法線が拾って縞になる
  for(let j=0;j<=res;j++)for(let i=0;i<=res;i++){
    const u=i/res, v=j/res, h=heightAt(u,v);
    if(h<=0.004) continue;
    const z=h*P.depth;
    /* 法線は高さマップの傾き。世界のスケールに合わせて微分を補正する */
    const dx=(heightAt(u+eps,v)-heightAt(u-eps,v))*P.depth/(2*eps*2*P.scale);
    const dy=(heightAt(u,v+eps)-heightAt(u,v-eps))*P.depth/(2*eps*2*P.scale);
    const n=nrm3(-dx, dy, 1);
    gid[j*(res+1)+i]=pos.length/3;
    pos.push(uvX(u),uvY(v),z); nrm.push(n[0],n[1],n[2]); uv.push(u,v);
    gidB[j*(res+1)+i]=pos.length/3;
    pos.push(uvX(u),uvY(v),-z); nrm.push(-n[0],-n[1],-n[2]); uv.push(u,v);
  }
  for(let j=0;j<res;j++)for(let i=0;i<res;i++){
    const a=gid[j*(res+1)+i], b=gid[j*(res+1)+i+1];
    const c=gid[(j+1)*(res+1)+i], d=gid[(j+1)*(res+1)+i+1];
    if(a>=0&&b>=0&&c>=0&&d>=0){
      idx.push(a,c,b, b,c,d);                                  // 表
      const A=gidB[j*(res+1)+i],B=gidB[j*(res+1)+i+1];
      const C=gidB[(j+1)*(res+1)+i],D=gidB[(j+1)*(res+1)+i+1];
      idx.push(A,B,C, B,D,C);                                  // 裏（巻き逆）
    }
  }
  return {pos,nrm,uv,idx};
}
function nrm3(x,y,z){const l=Math.hypot(x,y,z)||1;return[x/l,y/l,z/l];}

/* --- 口。毎フレーム作り直す（喋る所なので固定にできない） --- */
/* m = {w,h,p}  w=横幅倍率 h=開き p=すぼめ(う/お) */
function mouthGeo(m){
  if(!META) return null;
  const M=META.mouth;
  const cu=M.cx, cv=M.cy+P.mouthY*0.02;
  const W=M.rx*0.84*m.w*P.mouthW;
  const H=(0.034+m.h*0.052)*P.mouthH;   // 0.034=元絵の閉じた口の実測(0.070UVの半分)
  const pk=m.p, N=28;
  const up=[],dn=[];
  for(let i=0;i<=N;i++){
    const x=lerp(-1,1,i/N);
    const bell=Math.pow(Math.max(0,1-x*x),0.42+pk*0.85);
    up.push([cu+x*W, cv-H*0.42*bell]);
    dn.push([cu+x*W, cv+H*0.58*bell]);
  }
  /* 顔の表面に貼り付ける。少しだけ手前へ出す */
  const put=(u,v,off)=>[uvX(u),uvY(v),heightAt(u,v)*P.depth+off+pk*0.03];
  const cav=new Mesh();
  for(let i=0;i<=N;i++){
    const a=up[i],b=dn[i];
    const pa=put(a[0],a[1],0.008), pb=put(b[0],b[1],0.008);
    cav.pos.push(...pa,...pb); cav.nrm.push(0,0,1, 0,0,1);
  }
  for(let i=0;i<N;i++){const k=i*2; cav.idx.push(k,k+1,k+2, k+2,k+1,k+3);}
  /* 歯。閉じている時ほど口いっぱいに見える＝元絵の食いしばった顔 */
  const show=clamp(1-m.h*0.60,0.10,1);
  const th=new Mesh();
  for(let t=0;t<P.teeth;t++){
    const base=th.pos.length/3;
    for(const uu of[t/P.teeth+0.015,(t+1)/P.teeth-0.015]){
      const q=uu*N, i0=Math.min(Math.floor(q),N-1), f=q-i0;
      const ux=lerp(up[i0][0],up[i0+1][0],f);
      const vT=lerp(up[i0][1],up[i0+1][1],f);
      const vB=lerp(dn[i0][1],dn[i0+1][1],f);
      const vE=lerp(vT,vB,show);
      const p1=put(ux,vT,0.014), p2=put(ux,vE,0.014);
      th.pos.push(...p1,...p2); th.nrm.push(0,0,1, 0,0,1);
    }
    th.idx.push(base,base+1,base+2, base+2,base+1,base+3);
  }
  const line=[];
  for(const a of up) line.push(put(a[0],a[1],0.024));
  for(let i=dn.length-1;i>=0;i--) line.push(put(dn[i][0],dn[i][1],0.024));
  line.push(put(up[0][0],up[0][1],0.024));
  return {cavity:cav, teeth:th, line};
}

/* ==========================================================================
   状態・口パク・収録
   liveも巻き戻しも固定コマ 1/60 で回す。イベントは同じコマ境界で発火させる。
   ＝ video_sampler と同じ約束（何度巻き戻しても同じ結果になる）
   ========================================================================== */
const STEP=1/60;

/* 口の形。w=横幅 h=開き p=すぼめ */
const VIS={
  closed:{w:1.00,h:0.00,p:0.00},
  a:     {w:0.88,h:1.00,p:0.10},
  i:     {w:1.18,h:0.26,p:0.00},
  u:     {w:0.56,h:0.42,p:0.90},
  e:     {w:1.02,h:0.60,p:0.05},
  o:     {w:0.72,h:0.86,p:0.62},
};
const VKEY=['a','i','u','e','o'];

let EV=[];                        // 収録したイベント {t,id,...} 時刻順
let evCursor=0;

const S={};                       // シミュレーション状態（巻き戻しで作り直す対象）
function resetState(){
  /* 出し入れを収録していない時は最初から映す。
     真っ黒で始まると「壊れている」ようにしか見えないため（実際に一度そうなった）。
     appear を1つでも収録したら、その通り消えた状態から始める＝本番の出し入れを作れる */
  const scripted=EV.some(e=>e.id==='appear');
  const a=scripted?0:1;
  Object.assign(S,{
    t:0, frame:0,
    appear:a, appearT:a,
    yaw:0,pitch:0,roll:0, yawT:0,pitchT:0,rollT:0,
    mouth:{w:1,h:0,p:0}, mouthT:{w:1,h:0,p:0},
    manual:null, manualUntil:-1,          // 手で叩いた口の形
    auto:1,                                // 自動口パク
    expr:0, exprT:0,                       // 0=しかめ 1=驚き -1=笑い
    glow:0, glowT:0,
    gest:null,                             // {kind,t0}
    scale:1, scaleT:1, fx:0, fy:0, gaze:0,
  });
}
resetState();

/* --- 音源から口パクを焼く（60fps） --- */
let lipTrack=null, audioBuf=null;
function bakeLip(buf){
  const sr=buf.sampleRate, ch=buf.getChannelData(0);
  const n=Math.ceil(buf.duration/STEP), win=Math.round(sr*0.035);
  const tr=new Float32Array(n*2);
  let peak=1e-6;
  const rms=new Float32Array(n), zcr=new Float32Array(n);
  for(let f=0;f<n;f++){
    const c=Math.round(f*STEP*sr), a=Math.max(0,c-win>>1), b=Math.min(ch.length,a+win);
    let s=0,z=0,prev=0;
    for(let i=a;i<b;i++){const v=ch[i]; s+=v*v; if(i>a&&((v<0)!==(prev<0)))z++; prev=v;}
    const m=Math.sqrt(s/Math.max(1,b-a));
    rms[f]=m; zcr[f]=z/Math.max(1,b-a);
    if(m>peak)peak=m;
  }
  for(let f=0;f<n;f++){
    // 開き＝音量。子音のパチつきを抑えるため少しだけ均す
    const o=clamp(Math.pow(rms[f]/peak,0.62)*1.25,0,1);
    // 明るさ＝ゼロ交差率。高い=い/え（横に広い）、低い=う/お（丸い）
    const br=clamp((zcr[f]-0.02)/0.14,0,1);
    tr[f*2]=o; tr[f*2+1]=br;
  }
  // 3コマの移動平均（コマ単位のガタつき取り）
  const sm=new Float32Array(tr.length);
  for(let f=0;f<n;f++)for(let k=0;k<2;k++){
    let s=0,c=0; for(let d=-2;d<=2;d++){const g=f+d; if(g>=0&&g<n){s+=tr[g*2+k];c++;}}
    sm[f*2+k]=s/c;
  }
  return {n,d:sm};
}
function lipAt(f){
  if(!lipTrack||f<0||f>=lipTrack.n) return null;
  const o=lipTrack.d[f*2], br=lipTrack.d[f*2+1];
  // 開き→あ/お、明るさ→い/え に寄せる
  const round=1-br;
  return { w:lerp(0.70,1.12,br)*lerp(1,0.92,o),
           h:o*lerp(0.85,1.0,br),
           p:round*clamp(1-o*0.5,0,1)*0.75 };
}

/* --- 何もしていない時の揺らぎ ---
   止まっていると死んで見える。周期の違う正弦を重ねただけ＝ループに聞こえず、時刻の関数なので
   巻き戻しても同じ。強さは「ふわふわ」スライダー。 */
function idlePose(t){
  const k=P.idle;
  return {
    yaw:  (Math.sin(t*0.37      )*0.105+Math.sin(t*0.231+1.7)*0.062)*k,
    pitch:(Math.sin(t*0.29 +0.9 )*0.052+Math.sin(t*0.187+2.4)*0.034)*k,
    roll: (Math.sin(t*0.213+3.1 )*0.048+Math.sin(t*0.121+0.4)*0.026)*k,
    fx:   (Math.sin(t*0.33 +1.2 )*0.020+Math.sin(t*0.157+5.0)*0.012)*k,
    fy:   (Math.sin(t*0.41 +0.5 )*0.026+Math.sin(t*0.269+2.2)*0.016)*k,
  };
}

/* --- 首の仕草（時間の関数＝決定論的） --- */
function gestPose(g,t){
  if(!g) return [0,0,0];
  const e=t-g.t0;
  if(e<0||e>1.4) return [0,0,0];
  const d=Math.exp(-e*3.1);
  if(g.kind==='nod')   return [0, -Math.sin(e*13)*0.30*d, 0];
  if(g.kind==='shake') return [Math.sin(e*12)*0.34*d, 0, 0];
  if(g.kind==='tilt')  return [0,0, Math.sin(e*7)*0.26*d];
  return [0,0,0];
}

function pushEvent(e){
  e.t=Math.round(e.t/STEP)*STEP;  // コマ境界に丸める＝巻き戻しても同じ所で鳴る
  let i=EV.length; while(i>0&&EV[i-1].t>e.t)i--;
  EV.splice(i,0,e); undoStack.push({add:e}); redoStack.length=0;
}
function applyEvent(e){
  switch(e.id){
    case 'appear': S.appearT=e.v; break;
    case 'vis':    S.manual=e.v===null?null:VIS[VKEY[e.v]]; S.manualUntil=S.t+(e.d||0.16); break;
    case 'auto':   S.auto=e.v; break;
    case 'gest':   S.gest={kind:e.v,t0:S.t}; break;
    case 'look':   S.yawT=e.x; S.pitchT=e.y; break;
    case 'expr':   S.exprT=e.v; break;
    case 'glow':   S.glowT=e.v; break;
    case 'scale':  S.scaleT=e.v; break;
  }
}

/* --- 1コマ進める --- */
function stepSim(){
  const t=S.t;
  while(evCursor<EV.length && EV[evCursor].t<=t+1e-6){ applyEvent(EV[evCursor]); evCursor++; }
  const k=(rate)=>1-Math.exp(-STEP*rate);
  S.appear+=(S.appearT-S.appear)*k(3.0/Math.max(0.2,P.appearSec));
  S.expr  +=(S.exprT  -S.expr  )*k(6.5);
  S.glow  +=(S.glowT  -S.glow  )*k(S.glowT>S.glow?11:3.0);
  S.scale +=(S.scaleT -S.scale )*k(4.0);
  const [gy,gp,gr]=gestPose(S.gest,t);
  const id=idlePose(t);
  S.yaw  +=((S.yawT  +gy+id.yaw  )-S.yaw  )*k(7.0);
  S.pitch+=((S.pitchT+gp+id.pitch)-S.pitch)*k(7.0);
  S.roll +=((S.rollT +gr+id.roll )-S.roll )*k(7.0);
  S.fx+=(id.fx-S.fx)*k(3.0);
  /* ★登場は「溶ける」ではなく「下からせり上がる」（坂田 2026-09-21
     「幻想的に出てくるのも落とそう。ただ登場はさせたいので、どっかからいい感じに出したい」）。
     溶解はノイズを画素ごとに計算するので高い。せり上がりは**位置を動かすだけ**でタダ。
     出ている間は下に P.enterY だけ沈め、appearT が1になったら定位置へ戻る。 */
  /* 目指している先が「出ている(1)」なら入りの深さ、「消える(0)」なら出の深さを使う */
  const _depth = (S.appearT >= 0.5 ? P.enterY : (P.exitY || P.enterY));
  const _sink = (P.enterMode ? (1 - S.appear) * _depth : 0);
  const _fyT = id.fy - _sink;
  /* ★まだ出ていない間は「追いつかせる」のではなく**その場に置く**（2026-09-22）。
     坂田「一番最初のフリッキーの登場の挙動がおかしい。真ん中に一瞬出て、下から真ん中にくるみたいな」。
     せり上がり（enterMode）では appear は姿を消さない。沈める距離を決めているだけ。
     なので出る瞬間 fy がまだ 0 だと、**真ん中に実体が居る**。
     そこから追従で下へ落ち、また上がる＝「一瞬出てから、下から出直す」に見えていた。
     隠れている間は目標位置に直接置いておけば、最初のコマから画面の下にいる。 */
  if(P.enterMode && S.appear < 0.02 && S.appearT >= 0.5) S.fy = _fyT;   // これから上がる＝出発点に置く
  else S.fy += (_fyT - S.fy) * k(P.enterMode ? 4.2 : 3.0);
  /* 黒目。首の向きにつられて横に滑る。首より速い＝先に目が行くと生き物に見える。
     可動域は白目の余白ぶんしかないので狭く clamp する */
  const gt=clamp((S.yaw*0.052 + Math.sin(t*0.53+2.7)*0.0035)*P.gaze, -0.018, 0.018);
  S.gaze+=(gt-S.gaze)*k(11.0);

  // 口：手で叩いた形が優先。切れたら自動へ戻る
  let tgt=VIS.closed;
  const auto=S.auto?lipAt(S.frame):null;
  if(S.manual && S.t<S.manualUntil) tgt=S.manual;
  else if(auto) tgt=auto;
  const mk=k(tgt.h>S.mouth.h?26:15);     // 開く時は速く、閉じる時は少しゆっくり
  S.mouth.w+=(tgt.w-S.mouth.w)*mk;
  S.mouth.h+=(tgt.h-S.mouth.h)*mk;
  S.mouth.p+=(tgt.p-S.mouth.p)*mk;

  S.t+=STEP; S.frame++;
}
/* 指定時刻まで頭から回し直す＝「ビデオを巻き戻す」 */
function seekTo(sec){
  resetState(); evCursor=0;
  const n=Math.round(sec/STEP);
  for(let i=0;i<n;i++) stepSim();
}
const undoStack=[],redoStack=[];
function undo(){const u=undoStack.pop(); if(!u)return;
  if(u.add){const i=EV.indexOf(u.add); if(i>=0)EV.splice(i,1);} redoStack.push(u); seekTo(S.t);}
function redo(){const u=redoStack.pop(); if(!u)return;
  if(u.add){let i=EV.length;while(i>0&&EV[i-1].t>u.add.t)i--;EV.splice(i,0,u.add);}
  undoStack.push(u); seekTo(S.t);}

/* ==========================================================================
   音源
   ========================================================================== */
let AC=null, srcNode=null, gainNode=null;
let playing=false, playT0=0, playOff=0, dur=0, audioName='';
function ensureAC(){ if(!AC){AC=new (window.AudioContext||window.webkitAudioContext)();
  gainNode=AC.createGain(); gainNode.connect(AC.destination);} return AC; }
async function loadAudio(file){
  ensureAC();
  const ab=await file.arrayBuffer();
  audioBuf=await AC.decodeAudioData(ab);
  audioName=file.name; dur=audioBuf.duration;
  lipTrack=bakeLip(audioBuf);
  seekTo(0); playOff=0; FK_syncHud();
  const nsub=await loadSubs(audioName);
  FK_say(`${audioName} / ${dur.toFixed(2)}秒 — 口パク${lipTrack.n}コマ・字幕${nsub}行`);
}
function play(){
  if(!audioBuf||playing)return;
  ensureAC(); AC.resume();
  srcNode=AC.createBufferSource(); srcNode.buffer=audioBuf; srcNode.connect(gainNode);
  srcNode.start(0,clamp(playOff,0,dur)); playT0=AC.currentTime-playOff; playing=true;
  document.getElementById('rec').classList.add('on');
  document.getElementById('play').textContent='❚❚';
}
function pause(){
  if(!playing)return;
  try{srcNode.stop();}catch(e){}
  playOff=S.t; playing=false;
  document.getElementById('rec').classList.remove('on');
  document.getElementById('play').textContent='▶';
}
const nowT=()=>playing?(AC.currentTime-playT0):playOff;

/* ==========================================================================
   描画
   ========================================================================== */
const FK_CAM=new Float32Array([0,0,5.4]);

/* テクスチャを貼った本体。黒かった所だけ発光色に差し替える＝紗幕で線が消えない */
const FLEK=prog(`#version 300 es
in vec3 aPos; in vec3 aNorm; in vec2 aUV;
uniform mat4 uMVP, uModel; uniform mat3 uN;
out vec3 vN, vW; out vec2 vUV;
void main(){ vN=normalize(uN*aNorm); vW=(uModel*vec4(aPos,1)).xyz; vUV=aUV;
  gl_Position=uMVP*vec4(aPos,1); }`,
`#version 300 es
precision highp float;
in vec3 vN, vW; in vec2 vUV; out vec4 o;
uniform sampler2D uTex;
uniform vec3 uEye, uLight, uLineCol;
uniform float uRim, uAmb, uDiff, uGlow, uLineMix, uLineGlow, uLineCut;
uniform float uAppear, uTime, uDissolve;

/* 値ノイズ。溶解の模様に使う。時刻はシミュレーションの時刻なので巻き戻しても同じ */
float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float vnoise(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),
             mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y);
}
/* ★2026-09-21：3段→2段（坂田「登場がガタつきすぎている」）。
   1画素あたりのハッシュが12回→8回。模様は少し粗くなるが、溶け際の光でほとんど分からない */
float fbm(vec2 p){ return vnoise(p)*0.66+vnoise(p*2.13+7.7)*0.34; }

void main(){
  vec4 t=texture(uTex,vUV,-0.55);          /* 少し鮮明側に寄せる。ボケると線が太る */
  if(t.a<0.40) discard;

  /* 溶解: 下から立ち上がり、境目が光る。uAppear 0→1 で出現、1→0 で消滅。
     ★出きっている間（uAppear≒1）は**ノイズを計算しない**。
     溶けるのは登場と退場の一瞬だけなのに、喋っている間もずっと計算していた */
  float burn=0.0;
  if(uAppear<0.995 && uDissolve>0.001){
    float n=fbm(vUV*7.0+vec2(uTime*0.06,-uTime*0.04))*0.66+(1.0-vUV.y)*0.34;
    float edge=0.16;
    float thr=mix(-edge,1.0+edge,1.0-uAppear);
    if(n<thr) discard;
    burn=(1.0-smoothstep(thr,thr+edge,n))*uDissolve;
  }

  vec3 N=normalize(vN), V=normalize(uEye-vW), L=normalize(uLight);
  float d=max(dot(N,L),0.0);
  float f=pow(1.0-max(dot(N,V),0.0),2.6);
  /* 元絵は平坦な塗り。陰影は「立体に見える最低限」に留める＝濃くすると別物になる */
  vec3 base=t.rgb*(uAmb+uDiff*d)+t.rgb*f*uRim;
  /* 元絵の黒＝線。uLineMix=0 なら元絵のまま黒、1 で完全に発光線へ */
  float lum=max(max(t.r,t.g),t.b);
  float line=1.0-smoothstep(uLineCut*0.45,uLineCut,lum);
  vec3 lineLit=mix(base,uLineCol*uLineGlow,uLineMix);
  vec3 c=mix(base,lineLit,line);
  c+=uLineCol*burn*2.6;                    /* 溶け際の光 */
  o=vec4(c*uGlow,1.0);
}`);

/* 黒目。本体と同じ形をもう一度描き、瞳だけのテクスチャを横にずらして貼る。
   瞳は上まぶたの黒帯にぶら下がった楔なので、帯に沿って横に滑らせるのが構造的に正しい。
   縦には動かせない（帯と一体化しているため）。 */
const PUPIL=prog(`#version 300 es
in vec3 aPos; in vec3 aNorm; in vec2 aUV;
uniform mat4 uMVP, uModel; uniform mat3 uN;
out vec3 vN, vW; out vec2 vUV;
void main(){ vN=normalize(uN*aNorm); vW=(uModel*vec4(aPos,1)).xyz; vUV=aUV;
  gl_Position=uMVP*vec4(aPos,1); }`,
`#version 300 es
precision highp float;
in vec3 vN, vW; in vec2 vUV; out vec4 o;
uniform sampler2D uTex;
uniform vec3 uEye, uLight, uLineCol;
uniform float uRim, uAmb, uDiff, uGlow, uLineMix, uLineGlow, uLineCut, uOff, uFade;
void main(){
  vec4 t=texture(uTex, vUV - vec2(uOff,0.0));
  if(t.a<0.5) discard;
  vec3 N=normalize(vN), V=normalize(uEye-vW), L=normalize(uLight);
  float d=max(dot(N,L),0.0);
  float f=pow(1.0-max(dot(N,V),0.0),2.6);
  vec3 base=t.rgb*(uAmb+uDiff*d)+t.rgb*f*uRim;
  float lum=max(max(t.r,t.g),t.b);
  float line=1.0-smoothstep(uLineCut*0.45,uLineCut,lum);
  vec3 c=mix(base, mix(base,uLineCol*uLineGlow,uLineMix), line);
  o=vec4(c*uGlow*uFade,1.0);
}`);

/* uv付き・Uint32インデックスのメッシュ（グリッドが65k頂点を超えるため） */
class HeadMesh{
  constructor(){this.vao=gl.createVertexArray();
    this.b=[gl.createBuffer(),gl.createBuffer(),gl.createBuffer()];
    this.ib=gl.createBuffer(); this.n=0;}
  upload(m){
    gl.bindVertexArray(this.vao);
    const put=(buf,arr,loc,sz)=>{gl.bindBuffer(gl.ARRAY_BUFFER,buf);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(arr),gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc,sz,gl.FLOAT,false,0,0);};
    put(this.b[0],m.pos,0,3); put(this.b[1],m.nrm,1,3); put(this.b[2],m.uv,2,2);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint32Array(m.idx),gl.STATIC_DRAW);
    gl.bindVertexArray(null); this.n=m.idx.length; return this;
  }
  draw(){ if(!this.n)return; gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES,this.n,gl.UNSIGNED_INT,0); }
}

const head=new HeadMesh();
const FK_G={cavity:new GPUMesh(), teeth:new GPUMesh()};
const mouthLine=new GPULine();

function rebuildHead(){ if(HMAP) head.upload(buildFlekky(200)); }

/* --- 素材を読む --- */
const loadImg=src=>new Promise((ok,ng)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=ng;i.src=src;});
async function loadModel(){
  META=await fetch(FK_BASE+'model/flekky_meta.json').then(r=>r.json());
  const [ti,hi]=await Promise.all([loadImg(FK_BASE+'model/flekky_tex.png'),loadImg(FK_BASE+'model/flekky_height.png')]);
  /* 高さマップを数値で持つ（頂点の高さと、口を顔に貼る時のZに使う） */
  const cn=document.createElement('canvas'); cn.width=hi.width; cn.height=hi.height;
  const cx=cn.getContext('2d',{willReadFrequently:true}); cx.drawImage(hi,0,0);
  const px=cx.getImageData(0,0,hi.width,hi.height).data;
  HW=hi.width; HH=hi.height; HMAP=new Float32Array(HW*HH);
  for(let i=0;i<HW*HH;i++) HMAP[i]=px[i*4]/255;
  TEX=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,TEX);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,ti);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  const ext=gl.getExtension('EXT_texture_filter_anisotropic');
  if(ext) gl.texParameterf(gl.TEXTURE_2D,ext.TEXTURE_MAX_ANISOTROPY_EXT,
                           Math.min(8,gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  try{
    const pi=await loadImg(FK_BASE+'model/flekky_pupils.png');
    PUPTEX=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,PUPTEX);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,pi);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  }catch(e){ PUPTEX=null; }
  rebuildHead(); MODEL_READY=true;
  FK_say(`フリッキーを読んだ（テクスチャ ${ti.width}px / 高さ ${HW}px）`);
}

let ASPECT=2.0, showGuide=false;
let fboA=null,fboB=null,fboC=null,VW=0,VH=0;
/* 焼き込み中だけ、窓の大きさと関係なく出力の実寸で描く。
   0 のときは今まで通り窓に合わせる（bakeW を立てたら resize() を呼ぶ） */
let bakeW=0,bakeH=0;
function resize(){
  if(bakeW){
    VW=bakeW; VH=bakeH; FK_cv.width=VW; FK_cv.height=VH;
    FK_cv.style.width=Math.round(VW/2)+'px'; FK_cv.style.height=Math.round(VH/2)+'px';
    fboA=mkFbo(VW,VH);
    const bw2=Math.max(2,VW>>2), bh2=Math.max(2,VH>>2);
    fboB=mkFbo(bw2,bh2); fboC=mkFbo(bw2,bh2);
    return;
  }
  const st=document.getElementById(FK_STAGE_ID) || document.getElementById('stage');
  const live=document.body.classList.contains('live');
  const aw=st.clientWidth-(live?0:24), ah=st.clientHeight-(live?0:70);
  let w=aw,h=w/ASPECT; if(h>ah){h=ah;w=h*ASPECT;}
  /* ゲームに埋め込む時は等倍。Retina の2倍だとゲームと合わせて GPU が詰まる。
     ★2026-09-21：さらに ?res= で落とせるようにした（既定0.75）。
     紗幕に18mで投影する絵なので、線がにじむより**動きが滑らかな方が効く**（坂田「カクツク」） */
  const EMBED_RES=Math.max(0.3,Math.min(1,+(FK_get('res',0.75))||0.75));
  const dpr=FK_EMBED?EMBED_RES:Math.min(devicePixelRatio||1,2);
  FK_cv.style.width=w+'px'; FK_cv.style.height=h+'px';
  VW=Math.round(w*dpr); VH=Math.round(h*dpr);
  FK_cv.width=VW; FK_cv.height=VH;
  fboA=mkFbo(VW,VH);
  const bw=Math.max(2,VW>>2), bh=Math.max(2,VH>>2);
  fboB=mkFbo(bw,bh); fboC=mkFbo(bw,bh);
}
addEventListener('resize',resize);

function drawSurf(mesh,mat,col,mvpBase,emis=0,mul=1){
  gl.useProgram(SURF);
  gl.uniformMatrix4fv(SURF.u.uMVP,false,M4.mul(mvpBase,mat));
  gl.uniformMatrix4fv(SURF.u.uModel,false,mat);
  gl.uniformMatrix3fv(SURF.u.uN,false,M4.norm3(mat));
  gl.uniform3fv(SURF.u.uColor,col);
  gl.uniform3fv(SURF.u.uEye,FK_CAM);
  gl.uniform3f(SURF.u.uLight,-0.35,0.55,0.85);
  gl.uniform1f(SURF.u.uRim,0.2); gl.uniform1f(SURF.u.uDiff,P.diff);
  gl.uniform1f(SURF.u.uEmis,emis);
  gl.uniform1f(SURF.u.uGlow,P.glow*(1+S.glow*1.6)*mul);
  mesh.draw();
}
function drawLine(g,col,mvpBase,w,mul=1){
  gl.useProgram(LINE);
  gl.uniformMatrix4fv(LINE.u.uMVP,false,mvpBase);
  gl.uniform1f(LINE.u.uW,w*P.lineW*0.0016);
  gl.uniform1f(LINE.u.uAspect,ASPECT);
  gl.uniform1f(LINE.u.uTaper,0);
  gl.uniform3fv(LINE.u.uColor,col);
  gl.uniform1f(LINE.u.uGlow,P.glow*P.lineGlow*(1+S.glow*2.2)*mul);
  g.draw();
}
function render(){
  const proj=M4.persp(0.62,ASPECT,0.1,50);
  const view=M4.lookAt(FK_CAM,[0,0,0],[0,1,0]);
  const vp=M4.mul(proj,view);
  const s=S.scale*(1+Math.max(S.expr,0)*0.05);   // 出入りは溶解で見せるので縮小はしない
  const model=M4.mul(M4.trans(S.fx,S.fy,0),
                M4.mul(M4.mul(M4.rotZ(S.roll),M4.mul(M4.rotY(S.yaw),M4.rotX(S.pitch))),
                       M4.scale(s,s,s)));
  const mvp=M4.mul(vp,model);
  const vis=S.appear>0.002 && MODEL_READY;

  gl.bindFramebuffer(gl.FRAMEBUFFER,fboA.f);
  gl.viewport(0,0,VW,VH);
  gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
  if(vis){
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);                 // 表裏を張ってあるので両面出す
    /* 本体 */
    gl.useProgram(FLEK);
    gl.uniformMatrix4fv(FLEK.u.uMVP,false,mvp);
    gl.uniformMatrix4fv(FLEK.u.uModel,false,model);
    gl.uniformMatrix3fv(FLEK.u.uN,false,M4.norm3(model));
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,TEX);
    gl.uniform1i(FLEK.u.uTex,0);
    gl.uniform3fv(FLEK.u.uEye,FK_CAM);
    gl.uniform3f(FLEK.u.uLight,-0.35,0.55,0.85);
    gl.uniform3fv(FLEK.u.uLineCol,COL.line);
    gl.uniform1f(FLEK.u.uRim,P.rim);
    gl.uniform1f(FLEK.u.uAmb,P.amb);
    gl.uniform1f(FLEK.u.uDiff,P.diff);
    gl.uniform1f(FLEK.u.uGlow,P.glow*(1+S.glow*1.6));
    gl.uniform1f(FLEK.u.uLineMix,P.lineMix);
    gl.uniform1f(FLEK.u.uLineGlow,P.lineGlow);
    gl.uniform1f(FLEK.u.uLineCut,P.lineCut);
    gl.uniform1f(FLEK.u.uAppear,S.appear);
    gl.uniform1f(FLEK.u.uTime,S.t);
    gl.uniform1f(FLEK.u.uDissolve, P.enterMode ? 0.0 : P.dissolve);   // ★せり上がりの時は溶解を使わない
    head.draw();
    /* 黒目（本体と同じ形を、瞳テクスチャでずらして重ねる） */
    if(PUPTEX){
      gl.useProgram(PUPIL);
      gl.uniformMatrix4fv(PUPIL.u.uMVP,false,mvp);
      gl.uniformMatrix4fv(PUPIL.u.uModel,false,model);
      gl.uniformMatrix3fv(PUPIL.u.uN,false,M4.norm3(model));
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,PUPTEX);
      gl.uniform1i(PUPIL.u.uTex,0);
      gl.uniform3fv(PUPIL.u.uEye,FK_CAM);
      gl.uniform3f(PUPIL.u.uLight,-0.35,0.55,0.85);
      gl.uniform3fv(PUPIL.u.uLineCol,COL.line);
      gl.uniform1f(PUPIL.u.uRim,P.rim);   gl.uniform1f(PUPIL.u.uAmb,P.amb);
      gl.uniform1f(PUPIL.u.uDiff,P.diff); gl.uniform1f(PUPIL.u.uGlow,P.glow*(1+S.glow*1.6));
      gl.uniform1f(PUPIL.u.uLineMix,P.lineMix); gl.uniform1f(PUPIL.u.uLineGlow,P.lineGlow);
      gl.uniform1f(PUPIL.u.uLineCut,P.lineCut);
      gl.uniform1f(PUPIL.u.uOff,S.gaze);
      gl.uniform1f(PUPIL.u.uFade,smoothstep(0.55,0.9,S.appear));
      gl.depthFunc(gl.LEQUAL); head.draw(); gl.depthFunc(gl.LESS);
    }
    /* 口 */
    const mf=smoothstep(0.45,0.83,S.appear);       // 口が溶けて出てくる度合い
    const mg=(mf>0.01)?mouthGeo(S.mouth):null;
    if(mg){
      FK_G.cavity.upload(mg.cavity,true); FK_G.teeth.upload(mg.teeth,true);
      drawSurf(FK_G.cavity,model,COL.dark,vp,0,mf);
      drawSurf(FK_G.teeth,model,COL.teeth,vp,0.80,mf);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA,gl.ONE); gl.depthMask(false);
      mouthLine.upload(mg.line,true);
      drawLine(mouthLine,COL.line,mvp,1.7,mf);
      gl.depthMask(true); gl.disable(gl.BLEND);
    }
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  gl.viewport(0,0,VW,VH);
  gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(QUAD); gl.uniform1i(QUAD.u.uT,0); gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(QUAD.u.uMode,2); gl.uniform1f(QUAD.u.uAmt,1.0);
  gl.bindTexture(gl.TEXTURE_2D,fboA.t); gl.drawArrays(gl.TRIANGLES,0,3);
  if(P.halo>0.001){
    gl.bindFramebuffer(gl.FRAMEBUFFER,fboB.f); gl.viewport(0,0,fboB.w,fboB.h);
    gl.uniform1i(QUAD.u.uMode,0); gl.bindTexture(gl.TEXTURE_2D,fboA.t); gl.drawArrays(gl.TRIANGLES,0,3);
    gl.bindFramebuffer(gl.FRAMEBUFFER,fboC.f);
    gl.uniform1i(QUAD.u.uMode,1); gl.uniform2f(QUAD.u.uDir,1.4/fboB.w,0);
    gl.bindTexture(gl.TEXTURE_2D,fboB.t); gl.drawArrays(gl.TRIANGLES,0,3);
    gl.bindFramebuffer(gl.FRAMEBUFFER,fboB.f);
    gl.uniform2f(QUAD.u.uDir,0,1.4/fboB.h);
    gl.bindTexture(gl.TEXTURE_2D,fboC.t); gl.drawArrays(gl.TRIANGLES,0,3);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.viewport(0,0,VW,VH);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE,gl.ONE);
    gl.uniform1i(QUAD.u.uMode,2); gl.uniform1f(QUAD.u.uAmt,P.halo);
    gl.bindTexture(gl.TEXTURE_2D,fboB.t); gl.drawArrays(gl.TRIANGLES,0,3);
    gl.disable(gl.BLEND);
  }
  compositeSub();
}
/* ==========================================================================
   字幕
   WebGLのキャンバスに焼き込む。DOMで重ねると録画に乗らないため。
   ========================================================================== */
let SUBS=[], subCv=null, subCtx=null, SUBTEX=null, subShown=null, subOn=true;
/* 音源ごとに subs/<ファイル名>.json がある。無ければ subtitles.json に落ちる */
async function loadSubs(name){
  const stem=(name||audioName||'').replace(/\.[^.]+$/,'');
  for(const f of [stem?`${FK_BASE}subs/${stem}.json`:null, FK_BASE+'subs/subtitles.json']){
    if(!f) continue;
    try{
      const r=await fetch(f); if(!r.ok) continue;
      const j=await r.json();
      SUBS=j.lines||[]; subShown=null;
      return SUBS.length;
    }catch(e){}
  }
  SUBS=[]; subShown=null; return 0;
}
function subAt(t){
  for(const l of SUBS) if(t>=l.t0 && t<=l.t1) return l;
  return null;
}
function drawSub(line){
  if(!subCv){ subCv=document.createElement('canvas'); subCtx=subCv.getContext('2d');
    SUBTEX=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,SUBTEX);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE); }
  if(subCv.width!==VW||subCv.height!==VH){ subCv.width=VW; subCv.height=VH; }
  subCtx.clearRect(0,0,VW,VH);
  if(line){
    const rows=String(line.ja).split('\n');
    const size=Math.round(VH*0.062*P.subSize);
    const lh=size*1.42;
    subCtx.font=`600 ${size}px "Hiragino Sans","Hiragino Kaku Gothic ProN",sans-serif`;
    subCtx.textAlign='center'; subCtx.textBaseline='alphabetic';
    const bottom=VH-Math.round(VH*0.075);
    rows.forEach((r,i)=>{
      const y=bottom-(rows.length-1-i)*0;
      const yy=bottom-(rows.length-1-i)*lh;
      /* 紗幕でも読めるように、細い縁取り＋わずかな影 */
      subCtx.lineWidth=Math.max(2,size*0.11); subCtx.strokeStyle='rgba(0,0,0,0.85)';
      subCtx.lineJoin='round'; subCtx.strokeText(r,VW/2,yy);
      subCtx.fillStyle='#fff'; subCtx.fillText(r,VW/2,yy);
    });
  }
  gl.bindTexture(gl.TEXTURE_2D,SUBTEX);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,subCv);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
}
function compositeSub(){
  const line=subOn?subAt(S.t):null;
  const key=line?`${line.t0}|${line.ja}|${VW}x${VH}|${P.subSize}`:null;
  if(key!==subShown){ drawSub(line); subShown=key; }
  if(!line||!SUBTEX) return;
  gl.useProgram(QUAD); gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(QUAD.u.uT,0); gl.uniform1i(QUAD.u.uMode,3);
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
  gl.bindTexture(gl.TEXTURE_2D,SUBTEX); gl.drawArrays(gl.TRIANGLES,0,3);
  gl.disable(gl.BLEND);
}

/* ==========================================================================
   ループ
   ========================================================================== */
/* ★描くコマ数の上限（2026-09-21・既定30fps）。
   ゲームの画と**画面全体で合成**されるので、こちらが60fpsで更新すると合成も60回走る。
   口の動きも首も、30fpsあれば足りる（映画は24）。?fps= で変えられる */
const EMBED_FPS=Math.max(0,+(FK_get('fps',30))||0);
let _lastDraw=0;
function FK_frame(){
  /* 眠っている間は何も描かない。起こされたら次のコマから元どおり */
  if(EXT.sleep){ requestAnimationFrame(FK_frame); return; }
  /* ★溶けて出る／消える間は上限を外す（2026-09-21・坂田「最初のフリッキー登場がガタつきすぎている」）。
     appearSec は1.7秒。30fps だと51コマの**段**になって、じわっと溶ける動きが階段に見える。
     喋っているだけの間は30fpsで足りるが、**ゆっくり変化する所だけは60必要**。 */
  const _moving = Math.abs(S.appearT - S.appear) > 0.002 || (S.appear > 0.002 && S.appear < 0.998);
  if(EMBED&&EMBED_FPS&&!_moving){
    const now=performance.now();
    if(now-_lastDraw < 1000/EMBED_FPS-1.5){
      /* 描かないコマでも**時計には追いつかせる**（描いた時にまとめて飛ばない） */
      if(EXT.on){ const T2=extNow(); if(T2<S.t-0.05) seekTo(Math.max(0,T2));
                  let g=0; while(S.t<T2-1e-9 && g++<600) stepSim(); }
      requestAnimationFrame(FK_frame); return;
    }
    _lastDraw=now;
  }
  if(EXT.on){
    /* ★自分の時計で進める。ゲームから来る値は合わせ込みにだけ使う */
    const T=extNow();
    if(T < S.t - 0.05){ seekTo(Math.max(0, T)); }
    let guard=0; while(S.t<T-1e-9 && guard++<600) stepSim();
    render(); requestAnimationFrame(FK_frame); return;
  }
  if(playing){
    const t=nowT();
    if(t>=dur){ pause(); playOff=dur; }
    else{ let guard=0; while(S.t<t-1e-9 && guard++<600) stepSim(); }
  }
  render(); FK_syncHud(); requestAnimationFrame(FK_frame);
}

/* ==========================================================================
   ゲーム内で動かす本番再生モード（2026-09-16）
   editor.html?embed=1 を客席プレイ（solo_show/game/break_beyond.html）が iframe で置く。
   ・音はゲーム側が鳴らし、毎フレーム時刻だけ送ってくる（iframe の自動再生制限を避ける／音と絵がずれない）
   ・こちらは口パク（音源から焼く）・演技（takes/）・字幕（subs/）をその時刻で描くだけ
   メッセージ： {cmd:'load', stem, keepAppear} → {src:'flekky', evt:'ready', stem, dur}
                {cmd:'t', t} ／ {cmd:'subs', on} ／ {cmd:'hide'}
   ========================================================================== */
/* ★2026-09-21：埋め込みでも**自分で時計を進める**（坂田「エディタ単体は軽い。違いを探そう」）。
   これが単体との決定的な違いだった。
    単体 … 毎コマ自分のオーディオ時計を読む（nowT）→ なめらか
    埋め込み（旧） … ゲームが postMessage で毎コマ送る値をそのまま使う
   ゲームの rAF とこちらの rAF は**別々に回る**ので、送られてくる時刻は
   「同じ値が2回」「1つ飛ぶ」を繰り返す。描画がいくら速くても**動きが段になる**＝カクカク。
   → 受け取った時刻は**合わせ込みの基準**にだけ使い、コマの間は自分の時計で埋める。
     ずれは一気に直さず少しずつ寄せる（snap すると跳ねて見える）。 */
const EXT={on:false,t:0,stem:'',sleep:false,base:0,at:0,have:false};
/* いま進めるべき時刻。基準からの経過を自分で足す */
function extNow(){
  if(!EXT.have) return EXT.t;
  return EXT.base + (performance.now()-EXT.at)/1000;
}
const EMBED=FK_EMBED;
if(EMBED){
  document.body.classList.add('live');
  document.body.style.background='#000';
  { const _v=document.getElementById('vis'); if(_v) _v.style.display='none'; }  // 編集用の状態表示は出さない
  /* ★最初は必ず消えている状態にする。
     出現の指示が無いと「最初から映る」作りなので、台本を読む前に素の顔が一瞬出て点滅に見えた（2026-09-20） */
  EV=[{t:0,id:'appear',v:0}]; seekTo(0);
  /* 紗幕に出す本番は黒い線を発光線にする（黒は投影できない）。稽古の画面確認は元絵のまま */
  const q=new URLSearchParams(location.search);
  if(q.has('lineMix')) P.lineMix=Math.max(0,Math.min(1,+q.get('lineMix')||0));
  addEventListener('message',async e=>{
    const m=e.data||{};
    if(m.cmd==='t'){
      const t=+m.t||0;
      EXT.t=t;
      if(!EXT.have || Math.abs(t-extNow())>0.25){        // 初回・飛んだ時は合わせ直す
        EXT.base=t; EXT.at=performance.now(); EXT.have=true;
      }else{
        /* 少しずつ寄せる。1秒あたり最大0.15秒ぶんまで（音とずれ続けない範囲） */
        const d=t-extNow();
        EXT.base+=Math.max(-0.0025,Math.min(0.0025,d));
      }
      return;
    }
    if(m.cmd==='subs'){ subOn=!!m.on; subShown=null; return; }
    if(m.cmd==='hide'){ S.appearT=0; EV=EV.filter(x=>x.id!=='appear'||x.t<S.t); return; }
    /* ★2026-09-21：ゲーム中は描画ごと止める。
       いままでは隠れていても毎フレーム 3D を描き続けていた（ゲームのカクつきの主因）。
       ゲーム側が sleep を送ったら render() を呼ばない＝GPU も CPU も使わない */
    /* ★隠れたまま一度だけ「本気で描く」（2026-09-21・坂田「フリッキーの出だしが重い」）。
       起動直後は appear=0 なので `vis` が false ＝ **一度も本体を描いていない**。
       そのため**最初に見えるコマで、シェーダの組み立てとテクスチャの転送が一気に走る**。
       ここで隠れているうちに済ませておけば、登場の1コマ目がただの描画になる。 */
    if(m.cmd==='warm'){
      try{
        const a0=S.appear, t0=S.appearT;
        S.appear=1; S.appearT=1;
        for(let i=0;i<3;i++) render();
        gl.finish && gl.finish();
        S.appear=a0; S.appearT=t0; render();
        parent.postMessage({src:'flekky',evt:'warm'},'*');
      }catch(e){}
      return;
    }
    if(m.cmd==='sleep'){ EXT.sleep=true; return; }
    if(m.cmd==='wake'){ EXT.sleep=false; return; }
    if(m.cmd==='load'){
      try{
        const stem=String(m.stem).replace(/[^\w-]/g,'');
        /* ★版を付けて取る（2026-09-21）。付けないと焼き直しても古い口パクのまま出る */
        const V=(FK_get('vv','')||'');
        const q=V?('?v='+encodeURIComponent(V)):'';
        const r=await fetch(`${FK_BASE}voice/out/${stem}.mp3${q}`);
        await loadAudio(new File([await r.blob()],`${stem}.mp3`));
        let ev=[];
        try{ ev=(await fetch(`${FK_BASE}takes/${stem}_take.json${q}`).then(x=>x.json())).events||[]; }catch(err){}
        /* 続けて喋る時は溶けて出直さない（出ている状態から始める） */
        if(m.keepAppear) ev=ev.filter(x=>x.id!=='appear');
        EV=ev; evCursor=0; EXT.on=true; EXT.t=0; EXT.stem=stem;
        EXT.base=0; EXT.at=performance.now(); EXT.have=false;   // 次の t で張り直す
        seekTo(0);
        /* ★沈めるのは「消えた状態から始まる段」だけ（2026-09-22）。
       続きの段（keepAppear＝出しっぱなしで喋り続ける）は appear が最初から1なので、
       ここで沈めると**毎回下から出直してしまい、話が繋がらない**
       （坂田「おーいいね のところとかも、下から出てきてない？繋がってない」）。 */
    if(P.enterMode && S.appear < 0.5) S.fy = -P.enterY;
        parent.postMessage({src:'flekky',evt:'ready',stem,dur},'*');
      }catch(err){ parent.postMessage({src:'flekky',evt:'error',msg:String(err)},'*'); }
    }
  });
}


/* ── ゲームから直に呼ぶための窓口（iframe を使わない場合はこちらを使う）────
   postMessage と同じことを、間に何も挟まずにやる。 */
const FlekkyRT = {
  get state(){ return S; },
  get canvas(){ return FK_cv; },
  ready(){ return !!FK_cv && !!gl; },
  /* 台本ひと続きを読み込んで口パクを焼く。終わったら {stem, dur} を返す */
  async load(stem, keepAppear){
    stem = String(stem).replace(/[^\w-]/g, '');
    const V = (FK_get('vv','') || '');
    const q = V ? ('?v=' + encodeURIComponent(V)) : '';
    const r = await fetch(`${FK_BASE}voice/out/${stem}.mp3${q}`);
    await loadAudio(new File([await r.blob()], `${stem}.mp3`));
    let ev = [];
    try{ ev = (await fetch(`${FK_BASE}takes/${stem}_take.json${q}`).then(x=>x.json())).events || []; }catch(err){}
    if(keepAppear) ev = ev.filter(x => x.id !== 'appear');
    EV = ev; evCursor = 0; EXT.on = true; EXT.t = 0; EXT.stem = stem;
    EXT.base = 0; EXT.at = performance.now(); EXT.have = false;
    seekTo(0);
    /* ★沈めるのは「消えた状態から始まる段」だけ（2026-09-22）。
       続きの段（keepAppear＝出しっぱなしで喋り続ける）は appear が最初から1なので、
       ここで沈めると**毎回下から出直してしまい、話が繋がらない**
       （坂田「おーいいね のところとかも、下から出てきてない？繋がってない」）。 */
    if(P.enterMode && S.appear < 0.5) S.fy = -P.enterY;
    return { stem, dur };
  },
  /* いまの時刻を教える。**毎コマ呼ばなくていい**（こちらは自分の時計で回る） */
  setTime(t){
    t = +t || 0; EXT.t = t;
    if(!EXT.have || Math.abs(t - extNow()) > 0.25){ EXT.base = t; EXT.at = performance.now(); EXT.have = true; }
    else { const d = t - extNow(); EXT.base += Math.max(-0.0025, Math.min(0.0025, d)); }
  },
  subs(on){ subOn = !!on; subShown = null; },
  hide(){ S.appearT = 0; EV = EV.filter(x => x.id !== 'appear' || x.t < S.t); },
  sleep(){ EXT.sleep = true; },
  wake(){  EXT.sleep = false; },
  /* 隠れたまま一度だけ本気で描く（初めて見えるコマで固まらせないため） */
  warm(){
    try{
      const a0 = S.appear, t0 = S.appearT;
      S.appear = 1; S.appearT = 1;
      for(let i=0;i<3;i++) render();
      gl.finish && gl.finish();
      S.appear = a0; S.appearT = t0; render();
    }catch(e){}
  },
  lineMix(v){ P.lineMix = Math.max(0, Math.min(1, +v || 0)); },
  resize(){ resize(); },
  /* ★起動。もとは editor.html の末尾にあった `resize(); frame(); loadModel()`。
     ゲームからも同じ手順で立ち上げる必要があるので、こちらへ移した。 */
  boot(){
    if(this._booted) return this._booting;
    this._booted = true;
    resize(); FK_frame();
    this._booting = loadModel()
      .then(()=>{ this.modelReady = true; return true; })
      .catch(e=>{ FK_say('モデルを読めない: ' + e); console.error(e); return false; });
    return this._booting;
  },
  _booted:false, _booting:null, modelReady:false
};
try{ window.FlekkyRT = FlekkyRT; }catch(e){}
