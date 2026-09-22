"""フリッキーの「演技」をイベントJSONとして書き出す（エディタは触らない）。

字幕の秒数（subs/<音源名>.json）を読んで、12ブロックそれぞれに演出を割り当てる。
音源を替えても同じ設計で作り直せる。

  python3 takes/make_take.py voice/out/announce_daniel.mp3
  → takes/announce_daniel_take.json  （エディタの「読み込む」で読む）

出現・消滅は入れない。冒頭に「消えている」1件だけ置くので、
**出したい瞬間に ⏎ を押す**のは JUNYA が決める。
"""
import json, math, os, sys

STEP = 1/60
LOOK_EVERY  = 0.30      # 首の向きを打つ間隔。細かく打つほど「ふんわり」動く
SCALE_EVERY = 0.50

# 12ブロックの演出。focus 0=客席を見渡す / 1=正面に固定
#   scale 1.0=既定 大きいほど寄る
DIRECTION = [
 # focus scale  仕草(ブロック内の位置0-1, 種類)      狙い
 (0.30, 1.06, [(0.05,'tilt')],            "マイクを確かめる。近い"),
 (0.85, 0.98, [],                          "客席に向き直る。少し引く"),
 (0.20, 0.96, [],                          "会場全体を見渡しながら話す"),
 (0.60, 1.00, [(0.35,'nod')],              "自分で頷く"),
 (0.25, 1.02, [],                          "進化の話。視線が動く"),
 (0.95, 1.14, [],                          "「スピードって知ってる？」内緒話。寄る"),
 (0.90, 1.10, [],                          "数字。正面のまま動かない"),
 (0.40, 0.95, [(0.30,'shake')],            "分からない、と首を振る。引く"),
 (0.90, 1.06, [],                          "今夜の話。正面"),
 (0.70, 1.09, [(0.10,'tilt')],             "言わない→やっぱ言う。寄る"),
 (0.50, 0.90, [],                          "公園から世界へ。最も引く"),
 (0.85, 1.00, [(0.80,'nod')],              "深く座って。最後に小さく頷く"),
]
GLOW = [(6, 0.55), (9, 0.72)]   # (ブロック番号0起点, ブロック内の位置) に発光を一瞬

def free_yaw(t):   return 0.30*math.sin(2*math.pi*t/11.0 + 0.7) + 0.15*math.sin(2*math.pi*t/6.3 + 2.1)
def free_pitch(t): return 0.07*math.sin(2*math.pi*t/8.5 + 1.3) + 0.035*math.sin(2*math.pi*t/5.1 + 4.0)
def smoothstep(a,b,x):
    if b<=a: return 1.0
    u=max(0.0,min(1.0,(x-a)/(b-a))); return u*u*(3-2*u)
def snap(t): return round(round(t/STEP)*STEP, 4)

def build(subs, dur):
    lines = subs["lines"]
    n = min(len(lines), len(DIRECTION))
    ev = [{"t":0.0,"id":"appear","v":0}]          # 出す瞬間は人が決める

    def block_at(t):
        for i,l in enumerate(lines[:n]):
            if t < l["t1"] or i == n-1: return i
        return n-1
    def blend(t, idx):
        """ブロック境目で値が飛ばないよう、前後を混ぜる"""
        l = lines[idx]
        if idx > 0 and t < l["t0"]:
            prev = lines[idx-1]
            u = smoothstep(prev["t1"], l["t0"], t)
            return idx-1, idx, u
        span = max(0.4, (l["t1"]-l["t0"])*0.25)
        u = smoothstep(l["t0"], l["t0"]+span, t)
        return max(0,idx-1), idx, u

    t = 0.0
    while t <= dur:
        i = block_at(t); a,b,u = blend(t,i)
        focus = DIRECTION[a][0]*(1-u) + DIRECTION[b][0]*u
        y = free_yaw(t)*(1-focus)
        p = free_pitch(t)*(1-focus)
        ev.append({"t":snap(t),"id":"look","x":round(y,4),"y":round(p,4)})
        t += LOOK_EVERY

    t = 0.0
    while t <= dur:
        i = block_at(t); a,b,u = blend(t,i)
        s = DIRECTION[a][1]*(1-u) + DIRECTION[b][1]*u
        ev.append({"t":snap(t),"id":"scale","v":round(s,4)})
        t += SCALE_EVERY

    for i,l in enumerate(lines[:n]):
        for rel,kind in DIRECTION[i][2]:
            ev.append({"t":snap(l["t0"]+(l["t1"]-l["t0"])*rel),"id":"gest","v":kind})
    for i,rel in GLOW:
        if i < n:
            l = lines[i]; t0 = l["t0"]+(l["t1"]-l["t0"])*rel
            ev.append({"t":snap(t0),      "id":"glow","v":1})
            ev.append({"t":snap(t0+0.28), "id":"glow","v":0})

    ev.sort(key=lambda e: e["t"])
    return ev

if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv)>1 else "voice/out/announce_daniel.mp3"
    stem = os.path.splitext(os.path.basename(src))[0]
    subs = json.load(open(f"subs/{stem}.json"))
    dur = max(l["t1"] for l in subs["lines"]) + 0.5
    ev = build(subs, dur)
    out = {"format":"haribow-flekky-sampler/1","audio":os.path.basename(src),
           "duration":round(dur,2),"events":ev}
    os.makedirs("takes", exist_ok=True)
    dst = f"takes/{stem}_take.json"
    json.dump(out, open(dst,"w"), ensure_ascii=False, indent=1)
    kinds = {}
    for e in ev: kinds[e["id"]] = kinds.get(e["id"],0)+1
    print(f"{dst}  {len(ev)}件  { {k:v for k,v in sorted(kinds.items())} }")
    print(f"  尺 {dur:.1f}秒 / ブロック {len(subs['lines'])}")
