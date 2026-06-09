# Asian-settlement (TWAP-vs-point) mispricing — magnitude check (2026-06-09)

**Status: CLOSED — thesis falsified on mechanism, not magnitude. No v3 prereg warranted.**

This was the last untested structural thread after the passive-maker program
closed (see `kxbtc15m-passive-maker-negative-result-2026-06-09.md`). The thesis:
Kalshi settles KX\*15M on a ~60 s arithmetic mean of BRTI, our deployed model
prices a *point* digital `Φ(z)`, and if the *book* also prices a point digital,
the gap is a structural, mechanical edge. Decision rule, fixed before running:
compute the divergence distribution on the existing settled corpus; if the
median at tradeable moneyness isn't comfortably north of round-trip cost, dead
on arrival; if it is, a v3 preregistration on fresh data.

**The check returned the third possibility: the divergence is real and clears
cost — and the book already prices it. The mispriced party was our model, not
the market.**

## Method

- Transform: `p_twap = Φ(z·√(τ/(τ−2δ/3)))`, δ = 60 s — identical to
  `brier_bakeoff.py::p_twap_asian` (moment-matched lognormal, τ_eff = τ−40 s;
  τ<60 s falls back to `p_gaussian` since case-2 inside-window pricing needs the
  unlogged realized prefix).
- Corpus: 25,517 shadow decision rows (`kalshi-model-bakeoff-shadow.jsonl`,
  455 distinct markets, all 7 series) with `p_gaussian`, `secs_to_close`, and
  the live book (`best_yes_bid/ask`) at decision time; 25,047 rows joined to
  real Kalshi settlement labels via `kalshi-settlement-validation.jsonl`.
- Script: one-shot analysis (reproduced in appendix); no repo code changed.

## Results

**A. Magnitude — the divergence is NOT small.** Median |p_twap − p_gaussian| at
tradeable moneyness (0.10–0.90): **3.4–3.9¢ at 90–180 s TTE** (p90 ≈ 5–5.7¢),
1.8–2.1¢ at 180–300 s, ~1¢ at 300–600 s, <0.8¢ beyond 600 s. Against median
book spreads of 1.0¢ (90–180 s) / 2.0¢ (180–300 s) and a $0 maker fee, the
naive ceiling *clears* round-trip cost inside ~300 s. The DOA-on-magnitude
branch of the decision rule did **not** fire.

**B. Mechanism — the book already prices Asian settlement.** Where the
correction matters (|D| ≥ 0.25¢), the book-mid's offset from our point model
has the *same sign* as the TWAP correction:

| TTE | n rows | sign agreement |
|---|---:|---:|
| <90 s | 748 | **91%** |
| 90–180 s | 2,440 | **90%** |
| 180–300 s | 3,341 | 83% |
| 300–600 s | 7,457 | 67% |
| 600 s+ | 4,535 | 51% (coin flip — nothing to price) |

That gradient — coin-flip far from expiry, 90%+ where the Asian/point gap is
large — is the signature of a market converging to the *correct* settlement
model as expiry approaches.

**C. Residual — there is nothing left to harvest.** Median distance from book
mid: at <90 s TTE the mid sits **1.18¢ from p_twap vs 4.91¢ from p_gaussian**;
at 90–180 s, 2.74¢ vs 4.85¢. The 2–4¢ "divergence" of panel A was *our model's
error against the book*, already known in another guise (the 2026-06-08
deep-OTM phantom-edge finding: Φ(z) overstates dispersion near expiry;
latest-entry longshots went 0/112).

**D. Label check.** On 25,047 settled rows, `p_twap` improves Brier over
`p_gaussian` by −0.0007 overall and −0.0020 on the |D|≥1¢ subset (~2%
relative) — TWAP is the *correct mark*, consistent with the walk-forward
bakeoff where `p_twap` ≡ `p_gaussian` to 16 digits on pooled folds (the
correction lives entirely in the near-expiry tail).

## Verdict

The structural claim is **true** (point-digital is the wrong model; the
divergence is 2–4¢ at the moneyness shoulder inside 300 s) and the edge is
**absent** (the counterparty prices settlement correctly; we did not). What
remains after adopting the correct mark is the ordinary "out-forecast the
book's residual" problem — the signal lane closed by the 2026-05-25 lockdown,
made worse here because σ is least reliable exactly where the correction is
large (R6 σ-explosion; rough-vol literature).

Caveat for completeness: panels B/C compare the book against *our* TWAP price,
which uses *our* σ — so "book ≈ TWAP" conflates "book prices Asian settlement"
with "TWAP-corrected model is closer to truth." Either reading kills the
mechanism: in both, the book is not making the error the thesis required.

**With this, the residual space is closed.** Layer-1 calibration: falsified.
Layer-2 features: closed (lockdown). Execution-side maker: closed (4-way
negative + OOS side-inversion). Asian-settlement structure: priced by the
market. The correct standing conclusion: **the 15-minute crypto binary on
Kalshi is a structurally hostile instrument with no edge accessible to this
toolkit** — and that conclusion is now earned, not premature. Any future
attempt is a new venue or a new settlement structure, not a new cut of this
tape.

## Appendix — reproduction

```sh
python3 apps/market-worker/scripts/twap_divergence_check.py
```

The script loads `kalshi-model-bakeoff-shadow.jsonl`, applies the §Method
transform per row, buckets |p_twap − p_gaussian|·100 by TTE × p_gaussian
moneyness (panel A), compares against book spread (B), sign-tests
(mid − p_gaussian) vs (p_twap − p_gaussian) on |D| ≥ 0.25¢ rows (C), Briers
both models against `kalshi_result` joined by ticker (D), and measures
|mid − p| residuals (E).
