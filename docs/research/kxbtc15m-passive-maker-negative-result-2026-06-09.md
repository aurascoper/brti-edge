# KXBTC15M passive maker — negative result and program close-out (2026-06-09)

**Status: CONCLUDED — no edge. Program stopped and archived; tooling retained as repurposable.**

This document is the wrap-up record for the execution-side maker research program
(README §13 era `BTC_TOUCH_DEPTH50` / `BTC_YES_LATE_ASIA_v1`, then the locked
`KXBTC15M_PASSIVE_MAKER_v2` preregistration at
`docs/research/kxbtc15m-v2-preregistration.md`, lock commit `e65a36b`).
It records the verdict, the evidence, an adversarial red-team of the verdict, and
the disposition of the infrastructure.

---

## 1. The question and the verdict

**Question (v2 prereg §1):** does a passive YES-only maker on KXBTC15M produce
positive, non-concentrated settlement EV under conservative queue and drawdown
constraints?

**Verdict: NO — edge absent, not queue-eaten.** Every measurement lane explored
since 2026-05-25 converged negative, including the best-case queue assumption.
The decision was made 2026-06-09 by the operator: stop the program, archive the
tooling as explicitly repurposable for a future preregistered experiment.

## 2. Four-way negative convergence

| Lane | Data | Result |
|---|---|---|
| **Realized live** (R1–R6, 285 fills) | real fills, **real Kalshi settlements** | **−4.54¢/contract** |
| **In-sample replay** (design corpus, 30 h, 2026-05-26) | replay vs design tape | **−4.57¢/fill** |
| **Exploratory out-of-sample replay** (clean 2026-06-02→06-08 days, v2-filtered, conservative queue) | replay vs fresh tape, gates disabled (metrics-only, pre-agreed symmetric prior-update) | **−2.74¢/fill** (477 posted / 87 filled); red-team rerun **−3.37¢/fill** (440/82, §4.2) |
| **Front-of-queue stress** (best-case queue, same clean days) | adverseSelectionScorer | **+0.31¢** — below the 0.2–0.5¢ net-after-AS gate floor at the relevant n, and **non-monotonic** across queue models (front +0.31 / depth_50 −0.16 / back +0.69) = noise, not a buried signal |

The front-of-queue test was the pre-agreed disambiguator: if best-case queue had
been clearly positive while conservative was negative, the edge would be "real but
queue-eaten." It was not. **Edge absent.**

Signal-side lanes (OU mean-reversion, lag closure, basis/funding features,
Brier/fair-value tuning) were independently closed by the 2026-05-25 lockdown
(~60 variants tested / 0 passed; Bonferroni-corrected bar z≈3.34).

## 3. Why no official holdout will be scored

The locked v2 prereg specified a ≥2026-06-02 holdout. It will not be run:

1. **The window burned.** A 3 h collection gap (2026-06-04 06:00–08:00Z) made the
   2026-06-02→06-09/06-12 window `continuous_holdout_eligible: false` — permanently.
2. **Gate 2 is sample-size-unsatisfiable.** Clean days produce ~11
   conservative-model fills/day → ≈110 fills in 10 days, ≈154 in 14, vs the
   200-filled floor. Even a perfect window would be inconclusive-on-n.
3. **The harness has verified defects that would make a "PASS" untrustworthy**
   (§4.1) — fixable, but only worth fixing for a thesis that §2 already killed on
   a proxy-free leg.
4. **The thesis's own fragility clause fired.** Prereg §2.1 (Stanford 2026
   single-name finding) states YES-side deterioration OOS "constitutes a
   structural fail of v2, not a sample-size shortfall." Deterioration is what the
   exploratory data shows (§4.3).

## 4. Adversarial red-team of the "no edge" verdict

An external adversarial audit of the repo (run on a pre-conclusion snapshot) was
reconciled against the local code on 2026-06-09. All six of its high-severity
code claims were verified true. Two bore directly on the verdict and were run
down empirically.

### 4.1 Verified harness defects (recorded; matter only if the program is revived)

| # | Finding | Where | Status |
|---|---|---|---|
| 1 | Replay settlement label is a proxy: `inferSettlement` PnLs fills against late-mid/last-trade; "low"-confidence rows use a continuous value in [0.03, 0.97], never the real `kalshi_result` (collector deliberately omits private/result channels) | `btcMakerV2.ts:207-225, :570` | **Empirically moot for this corpus — see §4.2** |
| 2 | Gate 8 (ghost fills) is a tautology — `simulateQuoteV2` short-circuits `filled:false` on any pre-fill cancel, so the gate's filter is empty by construction and can never fail | `btcMakerV2.ts:305-316, :820` | open (fix before any revival) |
| 3 | Gate 7 (queue robustness) is unrunnable as written — `QUEUE_ASSUMPTION` is a hardcoded const; `parseArgs` accepts no `--queue` flag; the verdict text references a nonexistent rerun command | `btcMakerV2.ts:141, :427-439, :817` | open |
| 4 | All 14 policy constants duplicated between `btcMakerV2.ts` and `btcMakerV2Capped.ts` with no shared module — silent drift possible | both files | open |
| 5 | README documented dust hard-stop default −$15; code default is −$2 (`src/kalshi/dustExecutor.ts:124`) — code tighter than docs | README §10 | **fixed 2026-06-09** |
| 6 | README claimed "no live orders since 2026-05-17"; the ledger records the R7 micro-canary 2026-05-22 (2 XRP NO trades, −$1.06, halted by 2-loss stop) | README §9/§14, ledger row 8 | **fixed 2026-06-09** |

Also confirmed: the BRTI feed's `top5_imbalance` / `aggressor_flow_1s` are
hardcoded-0 stubs (`apps/market-worker/src/brti/aggregator.ts:187-188`; venues
poll REST `book?level=1`) — "OFI" was never an implemented feature. CLAUDE.md
corrected 2026-06-09.

### 4.2 Red-team check A — settlement-proxy contamination: **NONE**

The audit's strongest challenge: three of the four negative legs in §2 were
scored against the `inferSettlement` proxy rather than real Kalshi results. If a
material fraction of fills had been PnL'd against non-terminal "low"-confidence
mids, the exploratory EV would be untrustworthy in either direction.

**Method:** re-ran the locked `btcMakerV2.ts` per clean day (00–09Z hour-files
staged per day; conservative/primary queue; `--dump-records`) over
2026-06-02→06-08 and counted `settlementConfidence` over filled records.

**Result: 0 of 82 fills were low-confidence.** Every filled, scored record had a
high-confidence label (late-mid reached ≤0.03 or ≥0.97 — effectively settled
0/1). Pooled: 440 posted / 82 filled, **EV/posted −0.63¢, EV/filled −3.37¢**,
total −$2.76. The proxy concern is structurally valid (and #1 above stands as a
harness defect) but contaminates nothing in this corpus. Additionally, the
realized R1–R6 leg (−4.54¢) uses real fills and real settlements — the
convergence always had a proxy-free anchor.

**Number reconciliation:** the 2026-06-09 exploratory session reported 477
posted / 87 filled / −2.74¢. This rerun's staging (hour-files T00–T09 per day,
symlinked per-day dirs) yields 440 / 82 / −3.37¢. Per-day extremes replicate
exactly (−12.61¢ on 06-06; +25.33¢ at n=3 on 06-04), so the pooled difference is
chunk-boundary method noise, not a scoring discrepancy. Both are negative; the
verdict is insensitive to the choice.

Per-day (rerun): 06-02 −10.00¢ (n=12) · 06-03 −11.00¢ (n=10) · 06-04 +25.33¢
(n=3) · 06-05 +1.25¢ (n=8) · 06-06 −12.61¢ (n=18) · 06-07 +12.18¢ (n=17) ·
06-08 −8.00¢ (n=14). R3-style regime noise; no stable sign.

### 4.3 Red-team check B — did the YES-side surplus survive out-of-sample?

**No — it fully inverted.** The design-corpus Table C side decomposition
(yes-bid **+0.905¢/posted** n=731, no-bid **−0.218¢/posted** n=819) was the §7.1
microstructure justification for v2's YES-only design. Re-running the
adverseSelectionScorer per clean day (2026-06-02→06-08, primary/conservative
queue, generic both-sides quoting) and pooling Table C:

| side | n filled | EV/filled | EV/posted | design corpus |
|---|---:|---:|---:|---:|
| yes-bid | 1,436 | **−1.409¢** | **−0.602¢** | +0.905¢/posted |
| no-bid | 1,488 | **+1.012¢** | **+0.448¢** | −0.218¢/posted |

Both signs flipped. Per-day, the side asymmetry itself is unstable — yes-bid was
positive on only 2 of 7 days (06-05 +1.95¢, 06-07 +2.97¢/posted) and negative on
the other five (−1.59 to −2.72¢/posted), with no-bid mirroring it. This is the
prereg §2.1 (Stanford 2026) fragility clause firing exactly as written: the
YES-side surplus was a transient behavioral-flow regime, not structure. Per §2.1,
this deterioration "constitutes a structural fail of v2, not a sample-size
shortfall."

(Chasing the inverted asymmetry — e.g. a NO-only v3 — would repeat the identical
selection error that produced v2 from the design tape: the by-side sign is
regime noise that flips week to week and day to day. The pooled BOTH-sides EV
remains ≈0 before queue conservatism and negative after it.)

## 5. What survives — repurposable tooling inventory

The program's negative result does not touch the infrastructure, which is
venue-general and validated. Archived in git, tagged for reuse in a future
**preregistered** experiment (a venue/instrument reskin without a new prereg
re-runs the selection-bias trap):

| Asset | Where | Validation |
|---|---|---|
| Settlement-source A/B validator | `apps/market-worker/src/kalshi/` | BRTI ≫ Binance: 168/188 disagreements, p=1.27e−30 — settled science |
| Data collector + drain-safe supervisor + launchd plists + readiness gate | `apps/data-collector/` | weeks of 99%+ uptime; gzip-level-1 backpressure fix `a50f7d6` |
| Order-book reconstructor | `src/replay/bookReconstructor.ts` | 92.4–94.3% mid match vs ticker channel |
| FIFO queue model + stress scenarios | `src/replay/queueModel.ts` | sanity checks per README §13.3 |
| Per-quote PnL decomposition (spread/adv60/residual ≡ settlement, ≤1.4e−14¢) + AS scorer | `src/replay/adverseSelectionScorer.ts` | identity holds; Table C reproduced OOS (§4.3) |
| v2 replay harness + capped variant + markout tooling | `src/replay/btcMakerV2*.ts`, `v2Markout.ts`, `validateMarkouts.ts` | known defects listed in §4.1 — fix before reuse |
| Preregistration discipline artifacts | `docs/research/kxbtc15m-v2-preregistration.md`, VOID doc, promotion-gate script | the process caught its own design-corpus contamination (VOID run) — keep the pattern |

**Known harness-readiness gap** (for any future multi-day replay): the global
anchor sort OOMs on a full multi-day pass (~66M BTC deltas > 4 GB default heap);
chunk per-day or raise the heap.

## 6. Operational close-out (2026-06-09)

- All three launchd agents **unloaded** ~19:10Z: `com.polyterminal.kalshi-collector`,
  `com.polyterminal.kalshi-readiness`, `com.polyterminal.kalshi-worker`.
  Verified no residual processes. Plists remain in `~/Library/LaunchAgents/`
  (inert until re-loaded) and in `apps/data-collector/scripts/`.
- Collected data retained at `apps/data-collector/logs/data-collector/`
  (~276 hourly files per channel, 2026-05-25→06-09). Still valid for replay work;
  no window in it is holdout-eligible.
- Live trading remains paused; safe defaults (`KALSHI_ALLOW_ORDERS=0`,
  `AUTO_SUBMIT=0`, `DUST_ENABLED=0`) unchanged. Kalshi balance ~$18.
- Holdout-grade collector uptime is **no longer load-bearing**.

**Reproduction** (red-team reruns; from `apps/data-collector/`):

```sh
# stage per-day 00-09Z chunks (symlinks) under /tmp/v2-redteam/day-06DD, then:
NODE_OPTIONS=--max-old-space-size=4096 node_modules/.bin/tsx \
  src/replay/btcMakerV2.ts --log-dir=/tmp/v2-redteam/day-06DD \
  --label=redteam-lowconf-06DD --dump-records=/tmp/v2-redteam/v2rec-06DD.jsonl

NODE_OPTIONS=--max-old-space-size=6144 node_modules/.bin/tsx \
  src/replay/adverseSelectionScorer.ts --log-dir=/tmp/v2-redteam/day-06DD
```

## 7. Final statement

The one durable *finding* of the program is infrastructural: **BRTI is Kalshi's
settlement-authoritative source** (p=1.27e−30), plus a validated maker-replay
toolchain and a preregistration discipline that correctly voided its own
contaminated run. The trading thesis — in both its signal-side (Φ(z) calibration,
features) and execution-side (passive maker) forms — is concluded **negative on
converging, independently-measured evidence**, with the strongest single leg
(realized R1–R6) immune to every methodological objection raised against the
replay legs. Any future work at this venue starts as a *new* preregistered
experiment against a *new* thesis, reusing the tooling above.
