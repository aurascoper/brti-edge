# Stage B Arming Runbook — the last page before real money

**Status:** Pre-written per the W2 void declaration (§4 note) while audit F4's divergence
list is fresh. **Not on the W2′ critical path** — Stage B only exists after a wrapper-read
GO — but this page is what stands between five printed PASSes and a live order, which is
precisely the gap audit F2 lived in.
**References:** prereg §11 (envelope, VOID (plumbing) triggers, §12 sizing amendment),
audit F4 (`analysis/feynman-audit-20260805.md`).

## 0. Preconditions (all four, no exceptions)

1. `w2_close_check.py` (never the bare scorer) printed **GO** on the W2′ span.
2. Fee provenance archived (annex §1) — Stage B pays the real schedule.
3. Settlement rulebook excerpt archived (annex §7).
4. The dedup fix in §2 below is committed — without it the first opposite-side re-fire
   is a declared sim/live divergence (§11), i.e. an instant VOID (plumbing).

## 1. The exact env vector (audit F4 — every default is wrong for Stage B)

| Variable | Code default | **Stage B value** | Why |
|---|---|---|---|
| `KALSHI_ALLOW_ORDERS` | 0 | 1 | the deliberate flip |
| `AUTO_SUBMIT` / `DUST_ENABLED` | 0 | 1 | per §11 envelope |
| series scope | all 9 `executionAllowed: true` (`packages/kalshi-client/src/series.ts:21–29`) | **BTC only** — set `KALSHI_EXEC_SERIES=KXBTC15M` (or flip the other 8 flags off) | §3: S1 is the only promotable stratum; a SOL fire is VOID (plumbing) |
| `KALSHI_DUST_MANUAL_CONFIRM_FIRST_N` | 3 | **5** | §11 confirmed value; default under-gates |
| `KALSHI_DUST_BACKOFF_STREAK` | 3 (auto-resume) | **2 + PAUSE** — set streak 2 and `KALSHI_DUST_BACKOFF_RESUME=manual` | §11: 2-loss PAUSE-verify-resume, not auto-resuming backoff |
| `KALSHI_DUST_MAX_AGGREGATE_USD` | 3 (concurrent in-flight) | **25 cumulative-at-risk + 48h timer** | §11 cap is cumulative with a clock, not concurrent |
| evidence stop | −$2 (env default) | **−$12.50** | §11's declared malfunction floor at 1-contract sizing |
| sizing | — | **1 contract/order** | §12 amendment — exact §5 sim replica |

If any listed env var name does not exist in `dustExecutor.ts` at arming time, the gap is
itself a finding: the vector above is the spec, the executor conforms to it, not vice versa.

## 2. Code change required before arming (sim/live parity)

`dustExecutor.ts:759` dedups per `ticker|side`; the §5 sim is **first-fire-per-ticker**
(`w2_replay_scorer.py` breaks after the first YES/NO row per ticker). A live opposite-side
re-fire after a no-fill is §11's declared divergence. Change the dedup key to bare
`ticker` before arming. One line; test: a NO candidate on a ticker that already fired YES
must be dropped with a logged `refire_suppressed`.

## 3. VOID (plumbing) triggers — declared in advance (§11 + F4)

Any of the following during Stage B voids the round (stop, diagnose, restart Stage B from
scratch; never patch mid-round):

- an order on any series other than KXBTC15M;
- an opposite-side re-fire on an already-fired ticker;
- fill size ≠ 1 contract, or aggregate at-risk exceeding $25 before the 48h timer;
- backoff auto-resume observed (PAUSE not honored);
- evidence stop breached (−$12.50) — this is a malfunction floor, not a P&L judgment;
- live fill rate **below** the sim's 59% (§5 note: live latency ~1s vs 15s proxy horizon —
  live should fill MORE; fewer fills means the plumbing, not the market);
- any staleness-guard SKIP (`spotFeed` F8 guard) coinciding with a submitted order.

## 4. Arming sequence

1. Freeze check: `w2_close_check.py --tag <w2prime-tag>` still clean at arm time.
2. Set the §1 vector in the launchd plist env block; `launchctl bootout` + `bootstrap`.
3. Confirm startup log line shows the vector (scan interval, gates, caps).
4. First 5 orders manual-confirm (`FIRST_N=5`); reconcile each against the §5 sim row
   for the same signal before releasing the next.
5. After 40 trades or 48h (whichever first): stand down, run the wrapper over the Stage B
   span, reconcile fills/fees/settlements against exchange records, and only then decide
   continuation. The checker is never the committer.
