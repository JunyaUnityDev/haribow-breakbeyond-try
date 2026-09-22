"""元絵から立体化の素材を作る。
  flekky_tex.png    … 元絵（口だけ消してある。口は動かすので3D側で描く）
  flekky_height.png … シルエットを膨らませた高さマップ（グレースケール）
  flekky_meta.json  … 寸法と口の位置
プリミティブで似せようとすると再現度が出ない。元絵そのものを貼るのが正解。
"""
import json, sys, numpy as np
from collections import deque
from PIL import Image, ImageDraw, ImageFilter

def boxblur(a,r,times=1):
    """分離型の箱ぼかしを繰り返してガウシアン相当にする（積分画像で O(n)）"""
    for _ in range(times):
        for axis in (0,1):
            a=np.swapaxes(a,0,axis)
            pad=np.pad(a,((r+1,r),(0,0)),mode='edge')
            c=np.cumsum(pad,axis=0)
            a=(c[2*r+1:]-c[:-(2*r+1)])/(2*r+1)
            a=np.swapaxes(a,0,axis)
    return a

SRC='ref/元絵_flekky.png'; OUT='model'; N=1024
im=Image.open(SRC).convert('RGBA')
bb=im.getbbox()                                  # 不透明部分だけに詰める
c=im.crop(bb)
side=max(c.size)
sq=Image.new('RGBA',(side,side),(0,0,0,0))
sq.paste(c,((side-c.width)//2,(side-c.height)//2),c)
sq=sq.resize((N,N),Image.LANCZOS)
a=np.array(sq)

# ---- 口を消す（3D側で作り直すため）----
MOUTH=dict(cx=0.498,cy=0.795,rx=0.175,ry=0.088)   # 実測: 歯4つが x0.385-0.611 / y0.758-0.828
skin=np.array([252,199,149,255],np.uint8)
mask=Image.new('L',(N,N),0)
d=ImageDraw.Draw(mask)
d.ellipse([ (MOUTH['cx']-MOUTH['rx'])*N,(MOUTH['cy']-MOUTH['ry'])*N,
            (MOUTH['cx']+MOUTH['rx'])*N,(MOUTH['cy']+MOUTH['ry'])*N ],fill=255)
mask=mask.filter(ImageFilter.GaussianBlur(6))
m=(np.array(mask)/255.0)[...,None]
tex=(a*(1-m)+skin[None,None,:]*m).astype(np.uint8)
tex[...,3]=a[...,3]                               # アルファは元のまま

Image.fromarray(tex).save(f'{OUT}/_before_brim.png')

# ---- つばを塗る ----
# 元絵のつばは「黒で塗り潰した面」。黒背景では消え、紗幕でも黒は投影できない。
# キャップ本体より暗い水色（＝影になった面）にすると、両方で見える。
# 元絵そのものは触らない。ここで作る派生テクスチャだけを変える。
Image.fromarray(tex).save(f'{OUT}/_tmp.png') if False else None
# つばの芯線: 実測で (0.00,0.198) → (0.27,0.292) の細い帯
P0=np.array([0.000,0.198]); P1=np.array([0.270,0.292]); BAND=0.028
yy,xx=np.mgrid[0:N,0:N]; pt=np.stack([xx/N,yy/N],-1)
d=P1-P0; t_=np.clip(((pt-P0)@d)/(d@d),0,1)
proj=P0+t_[...,None]*d
band=np.linalg.norm(pt-proj,axis=-1)<BAND

t=tex.astype(int); lum=t[...,:3].max(2)
brim=band & (t[...,3]>128) & (lum<95)
# 黒い縁は残して中だけ塗る（縁が無いとただの棒に見える）
core=brim.copy()
for _ in range(3):
    sh=lambda m,dy,dx: np.roll(np.roll(m,dy,0),dx,1)
    core=core & sh(core,1,0) & sh(core,-1,0) & sh(core,0,1) & sh(core,0,-1)
t[core]=[70,168,178,255]                          # キャップ(116,254,255)の影の色
tex=t.astype(np.uint8)
print(f'  つばを塗った: 帯{brim.sum()}px 中{core.sum()}px')

# ---- 瞳を切り離す ----
# 瞳は「白目の中の点」ではなく、上まぶたの黒帯からぶら下がった楔。
# 帯は残したまま瞳だけ抜き、白目で埋める。抜いた瞳は別テクスチャにして3D側で左右にスライドさせる。
t=tex.astype(int); lum=t[...,:3].max(2)
opq=t[...,3]>128
whiteM=opq&(t[...,0]>215)&(t[...,1]>215)&(t[...,2]>215)
darkM =opq&(lum<95)

EYES=[dict(x0=.360,x1=.512,y0=.440,y1=.556),      # 左目（実測の白目bbox＋余白）
      dict(x0=.536,x1=.693,y0=.456,y1=.580)]      # 右目
# 帯と瞳は元絵で一体なので、切り分けようとすると必ずどちらかが欠ける（実際に欠けた）。
# 代わりに：顔からは「帯の下端より下」だけを消す（帯は無傷で残る）。
# スプライト側には帯を数行ぶん含める。帯は水平なので、水平にスライドしても帯の中を滑るだけで見えない。
LID_KEEP=12                      # スプライトに含める帯の行数
pupil=np.zeros(t.shape[:2],bool)   # 顔から消す方
sprite=np.zeros(t.shape[:2],bool)  # 動かす方
softDark=opq&(lum<205)             # 縁のアンチエイリアスまで拾う。白目は255なので巻き込まない
for e in EYES:
    X0,X1=int(e['x0']*N),int(e['x1']*N); Y0,Y1=int(e['y0']*N),int(e['y1']*N)
    # 列ごとの「白目の上端」。瞳を通る列は白の始まりが下にずれる。
    # ずれていない列の値＝上まぶたの黒帯の下端
    tops=[]
    for x in range(X0,X1):
        ys=np.nonzero(whiteM[Y0:Y1,x])[0]
        tops.append(Y0+ys.min() if len(ys) else -1)
    valid=[v for v in tops if v>0]
    if not valid: continue
    lid=int(np.percentile(valid,12))
    # 瞳の横幅を先に測る。行ごとに「白目の左端〜右端の間の黒」＝瞳（目の角の輪郭は入らない）
    px0,px1=None,None
    for x in range(X0,X1):
        pass
    for y in range(lid,Y1):
        xs=np.nonzero(whiteM[y,X0:X1])[0]
        if len(xs)<2: continue
        l_,r_=X0+xs.min(), X0+xs.max()
        seg=np.nonzero(softDark[y,l_:r_])[0]
        if len(seg)==0: continue
        a_,b_=l_+seg.min(), l_+seg.max()
        px0=a_ if px0 is None else min(px0,a_)
        px1=b_ if px1 is None else max(px1,b_)
    if px0 is None: continue
    px0=max(X0,px0-2); px1=min(X1,px1+3)          # 瞳の横幅だけに限定する
    # 帯は傾いているので、水平に切ると片側で帯を削る（実際に削れた）。
    # 瞳の左右の外側（瞳が無い列）の白目上端＝帯の下端 を測り、その間を補間する
    def top_white(x):
        ys=np.nonzero(whiteM[Y0:Y1,x])[0]
        return Y0+ys.min() if len(ys) else lid
    lidL=top_white(max(X0,px0-3)); lidR=top_white(min(X1-1,px1+2))
    for x in range(px0,px1):
        ys=np.nonzero(whiteM[Y0:Y1,x])[0]
        if len(ys)==0: continue
        bot=Y0+ys.max()
        u=(x-px0)/max(1,px1-1-px0)
        lx=int(round(lidL*(1-u)+lidR*u))          # その列の帯の下端
        # 帯の下端の柔らかい縁は残す（消すと帯の下に白い切れ目が出る）
        pupil[lx+4:bot, x] |= softDark[lx+4:bot, x]
        sprite[max(0,lx-LID_KEEP):bot, x] |= softDark[max(0,lx-LID_KEEP):bot, x]

# 瞳の中のハイライト（白い四角）だけを取り込む。
# 「行の左端〜右端を埋める」だと瞳の左右の白目まで巻き込み、
# ずらした時にその白が黒帯の上に乗って切れ目に見える（実際にそうなった）。
# 囲まれた穴だけを埋める。
def fill_holes(mask, box):
    X0,X1,Y0,Y1 = box
    sub = mask[Y0:Y1, X0:X1]
    h,w = sub.shape
    outside = np.zeros((h,w), bool)
    q = deque()
    for x in range(w):
        for y in (0,h-1):
            if not sub[y,x] and not outside[y,x]: outside[y,x]=True; q.append((y,x))
    for y in range(h):
        for x in (0,w-1):
            if not sub[y,x] and not outside[y,x]: outside[y,x]=True; q.append((y,x))
    while q:
        cy,cx=q.popleft()
        for dy,dx in((1,0),(-1,0),(0,1),(0,-1)):
            ny,nx=cy+dy,cx+dx
            if 0<=ny<h and 0<=nx<w and not sub[ny,nx] and not outside[ny,nx]:
                outside[ny,nx]=True; q.append((ny,nx))
    mask[Y0:Y1, X0:X1] = sub | (~sub & ~outside)

for m in (pupil, sprite):
    for e in EYES:
        fill_holes(m, (int(e['x0']*N),int(e['x1']*N),int(e['y0']*N),int(e['y1']*N)))

pup=np.zeros_like(t); pup[sprite]=t[sprite]         # 動かす方（帯を少し含む）
Image.fromarray(pup.astype(np.uint8)).save(f'{OUT}/flekky_pupils.png')
t[pupil]=[255,255,255,255]                          # 元の位置は白目で埋める
tex=t.astype(np.uint8)
print(f'  瞳: 顔から消す{pupil.sum()}px / 動かす{sprite.sum()}px')
Image.fromarray(tex).save(f'{OUT}/flekky_tex.png')

# ---- シルエットを膨らませる（距離変換→丸い断面）----
# 高さマップは口の位置に依存しないので、既にあれば作り直さない（距離変換が重い）
import os
if os.path.exists(f'{OUT}/flekky_height.png') and '--force' not in sys.argv:
    print('高さマップは既存を使う'); json.dump(dict(size=N,bbox=list(bb),src_side=side,mouth=MOUTH,eyes=EYES),open(f'{OUT}/flekky_meta.json','w'),indent=1); raise SystemExit
op=(a[...,3]>128)
INF=1e9
dist=np.where(op,INF,0.0)
# チャンファー距離（2パス）
for _ in range(2):
    for y in range(N):                            # 前向き
        row=dist[y]; prev=dist[y-1] if y>0 else None
        for x in range(N):
            if not op[y,x]: continue
            v=row[x]
            if x>0: v=min(v,row[x-1]+1)
            if prev is not None:
                v=min(v,prev[x]+1)
                if x>0: v=min(v,prev[x-1]+1.414)
                if x<N-1: v=min(v,prev[x+1]+1.414)
            row[x]=v
    for y in range(N-1,-1,-1):                    # 後ろ向き
        row=dist[y]; nxt=dist[y+1] if y<N-1 else None
        for x in range(N-1,-1,-1):
            if not op[y,x]: continue
            v=row[x]
            if x<N-1: v=min(v,row[x+1]+1)
            if nxt is not None:
                v=min(v,nxt[x]+1)
                if x>0: v=min(v,nxt[x-1]+1.414)
                if x<N-1: v=min(v,nxt[x+1]+1.414)
            row[x]=v
dist[~op]=0
# 距離場そのものを均す。ここを怠ると法線に縞が出る（実際に出た）
dist=boxblur(dist,9,3)      # PILのGaussianBlurはL/RGBしか受けないので自前
dist[~op]=0
dmax=float(dist.max())
# 縁で急に丸まり、中央はドーム。r0 を大きくすると全体が丸くなる
r0=dmax*0.85
t=np.clip(dist/r0,0,1)
h=np.sqrt(np.clip(1-(1-t)**2,0,1))                # 円の断面
h=np.where(op,h,0)
hi=Image.fromarray((h*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(6.0))
hi.save(f'{OUT}/flekky_height.png')

json.dump(dict(size=N, bbox=list(bb), src_side=side, dmax=dmax,
               mouth=MOUTH, eyes=EYES, aspect=1.0), open(f'{OUT}/flekky_meta.json','w'), indent=1)
print(f'出力OK  N={N}  距離最大={dmax:.1f}px  口={MOUTH}')
