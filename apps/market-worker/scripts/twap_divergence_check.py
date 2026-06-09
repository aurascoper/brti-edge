#!/usr/bin/env python3
"""Asian-settlement (TWAP-vs-point) mispricing magnitude check — 2026-06-09.

Ceiling question: is the divergence |p_twap - p_gaussian| at tradeable
moneyness/TTE comfortably north of round-trip cost? If not, dead on arrival.

p_twap: z_twap = z * sqrt(tau / (tau - 2*delta/3)), delta=60s (same transform
as brier_bakeoff.py::p_twap_asian, derivation moment-matches the 60s arithmetic
TWAP to lognormal with tau_eff = tau - 40s).
"""
import json, math, statistics as st
from collections import defaultdict

LOG = "/Users/aurascoper/Developer/polyterminal/apps/market-worker/logs/"
DELTA = 60.0

def ndtr(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))

def ndtri(p):
    # Acklam inverse normal CDF approximation
    a=[-3.969683028665376e+01,2.209460984245205e+02,-2.759285104469687e+02,1.383577518672690e+02,-3.066479806614716e+01,2.506628277459239e+00]
    b=[-5.447609879822406e+01,1.615858368580409e+02,-1.556989798598866e+02,6.680131188771972e+01,-1.328068155288572e+01]
    c=[-7.784894002430293e-03,-3.223964580411365e-01,-2.400758277161838e+00,-2.549732539343734e+00,4.374664141464968e+00,2.938163982698783e+00]
    d=[7.784695709041462e-03,3.224671290700398e-01,2.445134137142996e+00,3.754408661907416e+00]
    plow=0.02425; phigh=1-plow
    if p < plow:
        q = math.sqrt(-2*math.log(p))
        return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    if p > phigh:
        q = math.sqrt(-2*math.log(1-p))
        return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    q = p-0.5; r = q*q
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)

def p_twap(p_g, tau):
    if tau < DELTA or p_g <= 0 or p_g >= 1:
        return p_g
    tau_eff = tau - (2.0/3.0)*DELTA
    if tau_eff <= 0:
        return p_g
    z = ndtri(min(max(p_g, 1e-9), 1-1e-9))
    return ndtr(z * math.sqrt(tau / tau_eff))

# ---- load shadow decisions ----
rows = []
with open(LOG + "kalshi-model-bakeoff-shadow.jsonl") as f:
    for line in f:
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if r.get("p_gaussian") is None or r.get("secs_to_close") is None:
            continue
        rows.append(r)

# ---- settlement labels (validator) ----
labels = {}
with open(LOG + "kalshi-settlement-validation.jsonl") as f:
    for line in f:
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if r.get("kalshi_result") in ("yes", "no"):
            labels[r["ticker"]] = 1.0 if r["kalshi_result"] == "yes" else 0.0

def tte_bucket(t):
    if t < 90: return "<90s"
    if t < 180: return "90-180s"
    if t < 300: return "180-300s"
    if t < 600: return "300-600s"
    return "600s+"

def p_bucket(p):
    if p < 0.10 or p > 0.90: return "deep(<0.10|>0.90)"
    if p < 0.20 or p > 0.80: return "0.10-0.20|0.80-0.90"
    if p < 0.35 or p > 0.65: return "0.20-0.35|0.65-0.80"
    return "0.35-0.65"

div = defaultdict(list)          # (tte_b, p_b) -> divergence cents
spreads = defaultdict(list)      # tte_b -> book spread cents
book_align = defaultdict(list)   # tte_b -> (book_mid - p_g) vs (p_t - p_g) when |D|>=0.25c
briers = defaultdict(lambda: [0.0, 0.0, 0])  # subset -> [brier_g, brier_t, n]

n_total = 0
for r in rows:
    p_g = float(r["p_gaussian"]); tau = float(r["secs_to_close"])
    p_t = p_twap(p_g, tau)
    D = (p_t - p_g) * 100.0
    tb, pb = tte_bucket(tau), p_bucket(p_g)
    div[(tb, pb)].append(abs(D))
    n_total += 1
    yb, ya = r.get("best_yes_bid"), r.get("best_yes_ask")
    if yb is not None and ya is not None and ya > yb:
        spreads[tb].append((ya - yb) * 100.0)
        if abs(D) >= 0.25:
            mid = (yb + ya) / 2.0
            book_align[tb].append(((mid - p_g) * 100.0, D))
    y = labels.get(r["ticker"])
    if y is not None:
        for key, cond in (("ALL", True),
                          ("|D|>=0.5c", abs(D) >= 0.5),
                          ("|D|>=1c", abs(D) >= 1.0)):
            if cond:
                b = briers[key]
                b[0] += (p_g - y) ** 2; b[1] += (p_t - y) ** 2; b[2] += 1

def q(xs, p):
    xs = sorted(xs); i = (len(xs)-1) * p
    lo = int(i); return xs[lo] + (xs[min(lo+1, len(xs)-1)] - xs[lo]) * (i - lo)

print(f"shadow decision rows: {n_total}   settled-label joins: {sum(b[2] for k,b in briers.items() if k=='ALL')}")
print()
print("A. |p_twap - p_gaussian| divergence (cents) by TTE x moneyness")
print(f"{'TTE':10s} {'moneyness':22s} {'n':>6s} {'median':>7s} {'p90':>7s} {'max':>7s}")
for tb in ("<90s","90-180s","180-300s","300-600s","600s+"):
    for pb in ("deep(<0.10|>0.90)","0.10-0.20|0.80-0.90","0.20-0.35|0.65-0.80","0.35-0.65"):
        xs = div.get((tb,pb))
        if not xs: continue
        print(f"{tb:10s} {pb:22s} {len(xs):6d} {q(xs,0.5):7.3f} {q(xs,0.9):7.3f} {max(xs):7.3f}")
print()
print("B. Book spread (cents) by TTE — the round-trip cost floor for a taker")
for tb in ("<90s","90-180s","180-300s","300-600s","600s+"):
    xs = spreads.get(tb)
    if xs: print(f"  {tb:10s} n={len(xs):6d} median={q(xs,0.5):5.1f}c  p10={q(xs,0.1):5.1f}c")
print()
print("C. Does the book already lean toward the TWAP price? (rows with |D|>=0.25c)")
for tb in ("<90s","90-180s","180-300s","300-600s","600s+"):
    xs = book_align.get(tb)
    if not xs: continue
    same = sum(1 for m, d in xs if m * d > 0)
    print(f"  {tb:10s} n={len(xs):5d}  book-mid offset same sign as TWAP correction: {same}/{len(xs)} = {same/len(xs)*100:.0f}%")
print()
print("D. Brier, point vs TWAP, on settled-labeled rows")
for k in ("ALL", "|D|>=0.5c", "|D|>=1c"):
    bg, bt, n = briers[k]
    if n: print(f"  {k:10s} n={n:5d}  brier_gauss={bg/n:.5f}  brier_twap={bt/n:.5f}  delta={(bt-bg)/n:+.6f}")

print()
print("E. Residual after the book's own adjustment: |mid - p| in cents")
res = defaultdict(lambda: [[], [], 0, 0, 0])
for r in rows:
    p_g = float(r["p_gaussian"]); tau = float(r["secs_to_close"])
    yb, ya = r.get("best_yes_bid"), r.get("best_yes_ask")
    if yb is None or ya is None or ya <= yb: continue
    p_t = p_twap(p_g, tau)
    if abs(p_t - p_g) < 0.0025: continue   # only where the correction matters
    mid = (yb + ya) / 2.0
    e = res[tte_bucket(tau)]
    e[0].append(abs(mid - p_g) * 100); e[1].append(abs(mid - p_t) * 100)
    e[2] += 1 if yb <= p_t <= ya else 0
    e[3] += 1 if yb <= p_g <= ya else 0
    e[4] += 1
for tb in ("<90s","90-180s","180-300s","300-600s","600s+"):
    if tb not in res: continue
    g, t, int_t, int_g, n = res[tb]
    print(f"  {tb:10s} n={n:5d}  med|mid-p_gauss|={q(g,0.5):5.2f}c  med|mid-p_twap|={q(t,0.5):5.2f}c   p_twap inside bid/ask: {int_t/n*100:4.0f}%  p_gauss inside: {int_g/n*100:4.0f}%"
)
