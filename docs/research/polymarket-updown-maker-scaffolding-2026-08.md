# Design scaffold: Polymarket crypto up/down maker research program

**Status:** **DESIGN SCAFFOLD — NOT A PREREGISTRATION**
**Created:** 2026-08-15
**Repository:** `aurascoper/brti-edge`
**Author/operator:** `aurascoper`
**Supersedes:** nothing — this document opens a research line; it locks nothing.

> **This document does not authorize any live Polymarket orders.** A locked
> preregistration modeled on `kxbtc15m-v2-preregistration.md` (§13-style gate
> battery, §14 rejection rules) is a *prerequisite* for arming or authorizing
> any canary; this scaffold is not itself a license, and nothing in it may be
> cited as one. Canary parameters named in §9 are illustrative pending that
> preregistration.

---

## 1. Purpose and scope

This scaffold defines an execution-side research program for Polymarket's short-horizon crypto up/down binary markets (BTC, ETH, SOL; 5-minute, 15-minute, and hourly variants), built on the maker-replay and preregistration machinery this repo already carries for Kalshi. The honest framing is a maker spread-capture research program. It is not the bot described in the marketing video that prompted this work, because three of that bot's five legs fail scrutiny — two falsified by published evidence together with this repo's own run history, and a third shown to be a feed artifact — as §5 lays out. What survives scrutiny is narrower: a cross-venue information lag measured in hundreds of milliseconds, a book that sits one tick wide most of the time, and the open question of whether passive quotes in that book earn their spread after adverse selection and fees. That question is answerable with the discipline already built here, and with nothing riskier than shadow logs until a preregistration says otherwise.

The wall between design and validation applies from day one. Everything in this document, every tape collected while it circulates, and every replay run against that tape is design-side. Validation happens once, against a holdout window named in a locked preregistration that does not exist yet.

## 2. Provenance and prior results

The proximate trigger is a 28-second phone screen recording of a "Polymarket Maker Terminal" dashboard claiming roughly $94k of all-time PnL from a five-step loop: monitor BTC/ETH/SOL continuously, compute an independent fair probability, enter when Up plus Down costs under $1, manage the unhedged remainder, and lean directionally when the model sees an edge. The video is a social-media artifact. Its PnL counter, its "avg set cost $0.9779," and its "complete sets network" are unverifiable and carry no evidential weight here. What carries weight is the record below.

```text
Local prior results (this machine, this operator):
- brti-edge R1–R6 live taker rounds (Kalshi 15m, closed 2026-05-17):
    285 fills, net −$32.99. Live trading paused since.
- W2″ ordered peek (2026-08, prereg-governed):
    S1 −7.57¢ z=−2.99; Brier-vs-mid z=−3.81 NEGATIVE; all 7 series negative
    → NO-GO (mechanism)-shaped.
- Layer-1 calibration program: best walk-forward skill vs climatology
    (Brier 0.250) = 0.93%, against a 5% gate. FAILED.
    Reliability: p∈[0.70,0.80) bucket mean_p 0.740 vs realized 0.474.
- W2′ scoring window: closes 2026-08-20T10:00Z (close record 10:05Z);
    declared §4-ineligible 2026-08-13 → mechanical NO-GO (data) at close.
    Its §6 freeze binds all scoring-path files until close.
- MobilePolymarkets (separate repo, Polymarket US venue): engineering
    complete, 296/296 tests, readiness verdict "GO (Engineering) / NOT YET
    VALIDATED (Strategy)". NEVER traded: all 393 commits since 2026-07-11
    are logger-bot GitHub Actions (388 snapshots + 5 weekly reports);
    dry_run=True hard default; account balance $46.27, zero positions.
- live_trading/obi-execution-engine: closed read-only EV sandbox
    (2026-06-16, "no order path"); its own README rejects its taker scalp
    as friction-bound. OBI computation: live_trading/strategy/signals.py:804
    (its gate-not-signal role is discussed in §7.2).
```

```text
Published results directly on point:
- OpenMarket (arXiv 2607.26245): Rust pipeline trading Polymarket BTC
    15-min binaries against Binance flow, 54 observed days 2026-02..05.
    NULL result: walk-forward logistic over 43 microstructure features,
    pooled OOS AUC 0.8377 vs 0.8405 for the naive Polymarket mid.
    Simulated trading −0.116 normalized units per
    attempted trade under 1% fee + 0.5% slippage. Surviving facts:
    Polymarket quotes respond to ≥5bps Binance moves after median 347 ms;
    top-of-book spread is one tick (0.01) 91.9% of the time. Corpus
    public: HF gregyoung14/openmarket-btc-polymarket, frozen v0.5.2.
- Executable Arbitrage (arXiv 2608.00666): same-condition YES/NO books
    are complementary views of ONE unified book (7-day WS replication:
    exact mirrors except ~20 API sync artifacts). Genuine complete-set
    edges live in NegRisk multi-outcome events; CLOB violation episodes
    median 16.15s (YES side) / 7.99s (NO side); converter-enabled arb =
    97% of the $1.12M measured ($1.086M converter, $32k settlement);
    median converter profit ≈ $0.08/trade by early 2026.
- Probabilistic Forest (arXiv 2508.03474): $39.6M realized prediction-
    market arb Apr 2024–Apr 2025 (§7.4), concentrated in Politics NegRisk
    rebalancing and Sports single-condition markets, with heavy bot-like
    activity at the top: largest account $2.01M over 4,049 fills; top-10
    accounts ≈ $8.2M combined (Table 1).
- Stanford 2026 Kalshi adverse-selection result (cited in the v2 prereg
    §2.1): one-sided order flow predicts maker losses in single-name
    markets; the maker premium rests on a behavioral surplus that a
    one-sided strategy cannot assume.
```

## 3. Design principles

These are distilled from three repos that have already paid tuition, and each names the artifact that embodies it. They are constraints on this program, not aspirations.

**3.1 Staged risk ladder.** Read-only data collection precedes decision logic, decision logic precedes paper, paper precedes live, and replay validation precedes trusting any policy with money. MobilePolymarkets built its entire stack in this order and has still never armed; that is the ladder working, not failing. This program starts at the bottom rung (a tape archiver) on purpose.

**3.2 Preregistration gates with typed NO-GO.** Thresholds are declared before the data that will be judged by them exists, and a failure is reported by quadrant — data, execution, mechanism, economics — "so a mixed outcome cannot become an argument" (W2 prereg §8). The mechanical enforcement pattern is `promotion-gate-check.sh`: any gate that is FAIL, ABSENT, or UNVERIFIED is a NO-GO; nothing default-passes.

**3.3 Shadow-first, with load-bearing pins.** Order gates default to 0 and are pinned both in the supervisor wrapper after `.env` load and in the launchd plist, so no config edit can arm a worker by accident. The pins are not ceremony: `apps/market-worker/src/kalshi/dustExecutor.ts:120` defaults dust-execution to enabled when the env var is absent, so an unpinned environment is an armed one. The running Kalshi worker carries all three pins today.

**3.4 Immutable logs, ID-based joins.** Decision logs record only what was knowable when the decision fired; downstream stages enrich by joining on immutable IDs (`decision_id`, `condition_id`) and never mutate upstream rows. `docs/run-ledgers/kalshi-r1-r6-ledger.jsonl` is append-only; reconciliation happens by adding rows, not editing them.

**3.5 Kill-switch-first operations.** The live_trading launchd triad encodes the asymmetry: the watchdog runs with `KeepAlive=true` and guards even an empty book, while the engine runs with `KeepAlive=false` so a deliberate halt is never auto-resurrected — "a breaker trip is a terminal pass/fail call, NOT an auto-restart." The engine wrapper refuses to trade unguarded, polling for the watchdog before start.

**3.6 Honest-proxy naming.** obi-execution-engine's README names its momentum proxy honestly instead of calling it OBI, and closes its own book on a failed parameter set. Every proxy, assumption, and unmodelable term in this program gets named the same way, in writing, before results exist.

**3.7 Defer empirical decisions as configuration.** Open questions with no evidence yet (queue-position assumption, quote duration, cancel triggers) become config surfaces with declared defaults, not baked-in choices. Building an object whose fields have no real content yet is a shell, not a feature.

## 4. Venue mechanics: Polymarket crypto up/down

**4.1 The unified book.** For a single binary market, Up and Down are two views of one order book: a bid on Up is an ask on Down at one-minus-price. The durable evidence is structural (one book cannot cross itself) plus 2608.00666's seven-day WebSocket replication, which found the two views to be exact mirrors apart from roughly twenty API synchronization artifacts. A live pull of 2026-08-15 against current BTC and ETH up/down markets corroborates it on this desk: at identical timestamps the two books mirrored with zero full-depth mismatches, and the sum of best asks read 1.01 in every snapshot of that pull. Sequential (non-atomic) fetches of the two sides reproduce the skewed sums that screenshots present as arbitrage. The 5-minute series shares the same market schema and was not separately book-pulled; the §11 mirror-consistency report on our own tape carries the durability check across all variants. The consequence stands: "Up + Down < $1" inside one of these markets is a feed artifact, and §8 prohibits trading it as edge.

**4.2 The NegRisk distinction.** Real complete-set arbitrage exists only across NegRisk multi-outcome events, is enforced by converter bots within seconds, and paid a median of roughly $0.08 per trade by early 2026. That is a competed infrastructure business, not a research edge, and it is out of scope here.

**4.3 Fees.** Captured live 2026-08-15 from the market metadata of current up/down markets:

```text
fee model:            crypto_fees_v2 (taker-only)
rate:                 0.07
rebateRate:           0.2
makerRebatesFeeShareBps: 10000
orderPriceMinTickSize: 0.01
orderMinSize:          5
```

The parameters above are a live metadata capture, not an interpretation, and per §3.6 the interpretation must be named as an assumption: *if* `rate 0.07` is a taker fee applied per fill on these markets, then a transient one-tick-inside quote is not capturable net of fees by crossing; and *if* `rebateRate 0.2` denotes a per-fill maker rebate rather than a pooled or periodic maker-rewards share (which `makerRebatesFeeShareBps 10000` could equally suggest), then the fee structure favors the maker side directly. Neither conditional is resolved by the raw fields. Resolving them — the exact crypto_fees_v2 formula, who is credited, per-fill versus pooled, and the base the rate applies to — is an explicit Phase 0 exit criterion: the dated four-source fee/rulebook archive under `docs/research/`, following the `kalshi-fee-assumption-kxbtc15m.md` pattern. §4.4's framing is gated on that archive. The Polymarket US fee model (Θ·C·p·(1−p), taker Θ=0.05, maker rebate −0.0125) belongs to a different venue — MobilePolymarkets' — and must not be transferred here.

**4.4 The surviving channel.** Two published facts define where edge could live: Polymarket quotes respond to large Binance moves after a median 347 ms, and the top of book sits one tick wide 91.9% of the time. A taker cannot eat a one-tick spread plus taker fees on a 347 ms information edge. A maker resting at the touch collects the spread (and the rebate, under the §4.3 assumption), and pays for it in adverse selection when the 347 ms flow runs it over. Whether spread plus rebate exceeds adverse selection plus non-fill opportunity cost is precisely the quantity the replay stack's decomposition measures. That is the research question, and the first one; the second, inherited from the Stanford single-name result in §2, is whether any measured edge rests on non-stationary behavioral flow — regime fragility that a replay window cannot rule out and that the Phase-3 gates must address separately.

## 5. The five-step bot, leg by leg

The video's architecture, judged against the record in §2. Monitoring multiple markets continuously is solved locally three ways over — the Kalshi collector, the shadow workers, and MobilePolymarkets' hourly logger — and carries no edge by itself. Computing an independent fair probability and beating the book with it has now failed twice independently: OpenMarket's 43-feature model lost out-of-sample to the Polymarket mid it was trying to beat, and this repo's own calibration program topped out at 0.93% skill against a 5% gate before W2 fired a mechanism-shaped NO-GO. Entering when Up plus Down costs under $1 is, for these single-binary markets, a feed artifact per §4.1; the real version of that trade is the competed NegRisk converter business per §4.2. Managing the unhedged remainder is the one leg with real content — it maps onto inventory controls, the dust-executor gate stack, and the adverse-selection decomposition, and it survives into this program as maker inventory management. Leaning directionally when the model sees an edge is exactly the R1–R6 and W2 hypothesis that lost money here, and §8 prohibits re-opening it outside a new preregistration.

One clarification the video elides: on a unified book there are no separate "Up book" and "Down book" to be long against. A maker quoting both sides of one of these markets is quoting the bid and the ask of a single instrument. The five-step loop's mental model of two markets whose sum drifts below a dollar does not describe the venue.

## 6. Falsified directions (do not revisit without new evidence)

Drawn from README §7 and extended by this program's survey; each line is direction → evidence → verdict.

```text
Student-t / fat-tailed CDF ......... walk-forward gain < 1%, best ν
                                     effectively Gaussian → FALSIFIED
                                     (miscalibration is not tail-fatness)
Isotonic/logistic recalibration .... non-monotonic between universes,
                                     filled-trade Brier +11% → FALSIFIED
Taker fair-value flow (crypto
  short-horizon binaries) .......... R1–R6 net −$32.99; W2″ all 7 series
                                     negative; OpenMarket null on
                                     Polymarket itself → FALSIFIED
Single-binary "complete set"
  entry (Up+Down < $1) ............. unified book: 2608.00666 7-day
                                     replication + corroborated by a
                                     live pull here → FEED ARTIFACT
Mid-round Kelly bumps .............. R4: −$28 in 21 trades per README §7;
                                     −$29.82 per CLAUDE.md (sources
                                     disagree; both negative) → FALSIFIED
"13:55–17:05 UTC" time gate ........ empirically the LOSING window
                                     (R5, 33% win rate) → FALSIFIED
Pure time-of-day gating ............ R6 +$2.67 INCONCLUSIVE → not
                                     sufficient alone
NegRisk converter competition ...... not falsified but FORECLOSED:
                                     latency/gas race, ~$0.08 medians
                                     to incumbents; out of scope absent
                                     its own preregistration
```

## 7. Cross-repo reuse map

**7.1 From brti-edge, reused directly.** `packages/polymarket-client`: gamma discovery including `resolveBtcMarkets.ts` (whose two-batch up-or-down pagination works around ~95 stale-but-active expired markets), CLOB reads (`fetchBook`, `fetchMidpoint`, `fetchPrice`, `fetchPriceHistory`), the public market WebSocket (`connectWs.ts` + `market-state`'s `applyPriceChanges`), Data-API positions/trades/value, L1→L2 auth including the sigType-3 POLY_1271 workaround in `createApiCreds.ts` (the SDK binds the L2 key to the wrong address for deposit wallets; the workaround builds L1 headers against the funder), and the order write path (`buildOrder.ts` → `signOrder.ts` → `submitOrder.ts`, GTC/FAK). From `apps/data-collector`: `persistence.ts` (GzipRotator's never-append-into-an-existing-hour rule, 5 s flush), the supervisor wrapper pattern with stall watchdog, `adequacyReport.ts` holdout-eligibility semantics, `promotion-gate-check.sh`, and above all the replay stack — `bookReconstructor.ts`, the FIFO `queueModel.ts` with α ∈ {0, ½, 1} queue assumptions, `passiveQuoteSimulator.ts`, and `adverseSelectionScorer.ts`, whose three-way decomposition (spread captured + adverse selection + residual drift, identity verified to 1.4e−14¢ on 5,058 quotes) is the measurement instrument this whole program exists to point at Polymarket. From `docs/research`: the v2 preregistration as structural template.

**7.2 From live_trading, patterns.** The launchd asymmetry and five-gate engine wrapper (`svc_book_a_engine.sh`: HALT sentinel → duplicate guard → pinned account and caps → preflight → watchdog wait), the circuit-breaker/risk-path separation and its change discipline, and OBI-as-gate rather than OBI-as-signal (`strategy/signals.py:804`).

**7.3 From MobilePolymarkets, architecture.** Fixed-order risk gates (kill switch → max notional → daily loss → open exposure) with a presence-based kill switch; journal the order as SUBMITTING before the API call; fail-closed reconciliation at startup; dedup by both `decision_id` and `(condition_id, outcome)`; tick rounding learned from a real rejection; the data-model-before-metrics PR discipline.

**7.4 What must actually be built (verified 2026-08-15 against the SDK).** The gap list is smaller than a first reading of the wrapper suggests. Cancel (`cancelOrder`/`cancelOrders`/`cancelAll`), open-order listing (`getOpenOrders`), and tick-size/neg-risk lookup (`getTickSize`/`getNegRisk`) already exist on the SDK `ClobClient` that `buildAuthenticatedClient` returns — those are one-call wrappers. The real builds are three: an authenticated user-channel WebSocket for fills and order status, which is absent from both the wrapper and the SDK (the SDK is REST-only); headless credential handling, done by calling `deriveTradingSession` at process start and holding creds in memory — `storage.ts` silently no-ops outside a browser, and no file-backed store should exist; and a `PolymarketAdapter implements VenueAdapter`, of which only the Kalshi implementation exists today. Two flags found on the way: `buildOrder.ts` hardcodes 1e-4 price rounding and must consult the tick-size lookup on the quoting side, and `createApiCreds.ts` logs L1 auth headers to console and must be stripped before any headless run. The fourth prerequisite is not code but data: no Polymarket tape exists, so none of the replay machinery has anything to run on. The archiver is the program's first deliverable, not the bot.

## 8. Hard prohibitions

```text
This research line may not, under this scaffold or any successor short of a
new locked preregistration that names them:
1. Run taker fair-value flow against crypto up/down binaries (any venue).
2. Open new signal-side research on crypto up/down direction (Layer-1/
   Layer-2 style feature or calibration search).
3. Enter single-binary "complete set" positions on the premise that
   Up+Down < $1 is edge.
4. Compete in NegRisk converter arbitrage.
5. Re-arm any live order flag outside a preregistered gate battery
   ("never just flipping order flags").
6. Relax, reinterpret, or average away a failed gate post hoc.
7. Touch the Kalshi W2′ scoring path before 2026-08-20T10:05Z.
```

## 9. Phased build plan

Phase 0, now: the tape archiver in `apps/data-collector` (new `src/polymarket/` entry, spot feed, discovery; gzip channels `pm-book`, `pm-price-change`, `pm-tick-size`, `pm-last-trade`, `pm-markets`, `spot-trades`, `meta`; supervisor, plist, mirror-consistency check, readiness check, OpenMarket-corpus converter marked bootstrap-only). Phase 0 is additive-only while the W2′ freeze holds: new files under `src/polymarket/` and `scripts/`, with the sole permitted edit to an existing file being the `package.json` script entry; `persistence.ts` and `adequacyReport.ts` are imported or copied, never modified in place, before 2026-08-20T10:05Z. Exit: 24 hours of gap-free tape across all channels and all three assets, mirror-consistency pass, one full market lifecycle on tape, and the dated fee/rulebook archive including resolved rebate semantics per §4.3. Phase 1, additive and freeze-safe: the client extensions of §7.4 plus thin SDK wrappers, `POLYMARKET_ALLOW_ORDERS=0` pinned in the Kalshi manner. Phase 2, offline: port the passive-quote simulator and adverse-selection scorer to the Polymarket tape (`replay/pm/`), reusing `queueModel.ts` unmodified via an integer-price-compatible book shape; dry-run on the converted OpenMarket corpus while local tape accumulates to fourteen days across three assets; no GO/NO-GO is read from Phase 2 — its output is a results report and locked-threshold candidates. Phase 3, after the W2′ close: a preregistration (`pm-updown-maker-v1-preregistration.md`) clause-for-clause on the v2 template, its own gate-check script, and a canary built in a new sibling app (`apps/pm-maker/`) with the five-gate wrapper, `KeepAlive=false`, order flag pinned to 0 in wrapper and plist, and caps of $3 per order, $10 open, $5 daily loss. The canary is built by this program; arming it is a separate, explicit operator decision that no document in this repo can make.

## 10. Gate philosophy

Thresholds are locked only in the Phase-3 preregistration, before its scoring window opens. The battery inherits the v2 structure: data eligibility and design/validation separation; volume floors; EV per posted and per filled quote; drawdown ceilings; concentration limits across markets, time-to-expiry buckets, and clock hours; side decomposition; queue robustness, failing any policy that passes only under the front-of-queue assumption; non-fill and cancel integrity with zero ghost fills; and commit-hash identity between policy code and preregistration. Economics gates are computed net of the archived crypto_fees_v2 schedule and relayer/gas assumptions. Failures are typed:

```text
NO-GO (data)       → collection defect: fix the archiver, not the policy.
NO-GO (execution)  → fills/cancels/queue don't behave as modeled.
NO-GO (mechanism)  → spread+rebate does not cover adverse selection.
NO-GO (economics)  → positive gross, dead after fees/gas/opportunity cost.
```

Permanent rejection inherits v2 §14: three distinct preregistered variants failing closes the line. The seeded prior art already counts against it — OpenMarket's null, this repo's W2, and the Stanford single-name adverse-selection result are on the record, and the preregistration must cite all three as the evidence bar any GO has to clear, adopting v2 §2.1's conclusion that a one-sided single-name maker strategy faces a higher bar, not a lower one.

## 11. Required outputs regardless of pass or fail

```text
1. Tape adequacy + holdout-eligibility report (Polymarket channels).
2. Mirror-consistency report (unified-book verification on our own tape).
3. Queue-model validation vs pm-last-trade markouts.
4. Passive-policy replay + capped-bankroll variant.
5. Side + adverse-selection decomposition by TTE/hour/moneyness buckets.
6. Concentration + drawdown accounting.
7. Fee/rulebook archive with retrieval dates.
8. Final gate memo, quadrant-typed, published on GO and on NO-GO alike.
```

## 12. References

Cited in text: arXiv 2607.26245 (OpenMarket); arXiv 2608.00666 (Executable Arbitrage and Market Efficiency in Prediction Markets); arXiv 2508.03474 (Unravelling the Probabilistic Forest); the Stanford 2026 Kalshi adverse-selection working paper as cited in `kxbtc15m-v2-preregistration.md` §2.1; local: `kxbtc15m-v2-preregistration.md`, `kx15m-w2-btc-stratified-shadow-preregistration.md`, `analysis/feynman-audit-20260805.md`, `README.md` §§7–8, `docs/run-ledgers/kalshi-r1-r6-ledger.jsonl`.

Background survey (read during scoping, not load-bearing above): arXiv 2607.17991 (Optimal Market Making in Prediction Markets); arXiv 2604.24366 (Anatomy of a Decentralized Prediction Market); arXiv 2606.16852 (Ghosts of Polymarket — off-chain match / on-chain revert risk); arXiv 2606.01477 (Avellaneda-Stoikov/Cartea-Jaimungal forced uniqueness); arXiv 2507.22712 (Order-Flow Filtration).

## Appendix A. Claim provenance

```text
347 ms median quote-response lag ......... 2607.26245 §10 (collector clock)
91.9% one-tick top-of-book spread ........ 2607.26245 Table 3
Model OOS AUC 0.8377 vs mid 0.8405 ....... 2607.26245 Table 2 (pooled OOS)
−0.116 units/attempted trade ............. 2607.26245 §6 (1% fee, 0.5% slip)
Unified-book mirror (7-day replication) .. 2608.00666 Appendix A
YES/NO episode medians 16.15 s / 7.99 s .. 2608.00666 §5.2
$1.12M = $1.086M converter + $32k basket . 2608.00666 §5.3
~$0.08 median converter profit (2026) .... 2608.00666 §5/App. F
$39.6M realized arb 2024–25; top-10
  ≈ $8.2M; largest $2.01M/4,049 fills .... 2508.03474 §7.4 + Table 1
Local unified-book live pull ............. this repo, 2026-08-15 (verifier
                                            run: BTC+ETH books, zero full-
                                            depth mismatches, ask sums 1.01
                                            in every snapshot of that pull)
crypto_fees_v2 parameters ................ live market metadata, 2026-08-15
R1–R6: 285 fills, −$32.99 ................ docs/run-ledgers/kalshi-r1-r6-
                                            ledger.jsonl; CLAUDE.md
W2″ peek: −7.57¢ z=−2.99, z=−3.81 ........ W2″ pre-commit + operator memory
0.93% vs 5% skill gate; 0.740 vs 0.474 ... README §4; CLAUDE.md
AS identity to 1.4e−14¢ / 5,058 quotes ... adverseSelectionScorer.ts docs
src/kalshi/dustExecutor.ts:120
  default-on pin (kalshi variant) ........ verifier read, 2026-08-15
MobilePolymarkets status ................. repo survey via gh, 2026-08-15
W2′ close 2026-08-20T10:00Z (rec. 10:05Z) . W2′ lock record + close wrapper
```
