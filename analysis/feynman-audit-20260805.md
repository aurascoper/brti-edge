# Feynman Audit — brti-edge

**Date:** 2026-08-05 · **HEAD:** `7a71347` (locked W2 prereg, tag `w2-scorer-final-20260803` = `9bbf7c0`)
**Method:** 75 spec claims bound to code; five independent producers (explain:engineer, explain:skeptic, trace:nominal, trace:adversarial, constants, spec:undocumented) emitted gap cards, each independently re-verified in a closure pass. Findings below are the survivors: spec **DIVERGENCE** items, **UNBOUND** claims, and gap cards still **OPEN**. Every `file:line` citation in this report was re-grep-verified at HEAD before publication.

---

## Methods-integrity note

**No FABRICATED_CITATION items were produced by any agent.** All 75 claim bindings and all closure evidence cite lines that exist verbatim at HEAD. Two *asserted-but-absent artifacts* deserve flagging under methods integrity, though they are findings rather than fabrications (the prereg asserts results, not fake file paths): the **operating-characteristics Monte Carlo** ("20k trials/row", P(GO|0)=3.4%) and the **W1 leak audit** ("13 of 71 fills") exist only as prose in the prereg — neither script nor output is anywhere in the tree or git history (F10, F11).

---

## Headline

The audit's most consequential composite result, logged independently by **three producers** (explain:engineer, explain:skeptic, trace:adversarial): **the currently-running W2 window appears already ineligible under its own §4 rule.** A machine-wide outage ~2026-08-04T18Z→2026-08-05T01Z left both the collector's hour files and the worker's shadow log with a ~7–8h hole (zero shadow rows; 34 of 224 BTC quarter-hour settlement slots missing since window start; 71 vs ~96 settlements captured on Aug 4). Per the locked text —

> `docs/research/kx15m-w2-btc-stratified-shadow-preregistration.md:51` — "- **Eligibility:** the existing holdout policy applied to the W2 span — worst-channel coverage ≥ 99%, no channel with a continuous gap > 1h, per `isContinuousHoldoutEligible()`. An ineligible window is scored as **NO-GO (data)**, not retried silently; the next clean 14-day span becomes W2′ under this same document."

— this is NO-GO (data) / W2′ territory. Yet **no mechanical check would catch it** (F2): the scorer computes neither G4 nor G5, and its `--interim` mode would still print a bare `GO` if z cleared 2.8. The operator decision this report should force: declare W2′ now rather than burn the remaining days.

---

## OPEN findings (ranked by what changes if closed)

### Tier 1 — Money and correctness

**F1. Settlement-capture loss is invisible to every tripwire, and the current window already contains it.**
*Agreement: engineer GAP-2, skeptic GAP-04/GAP-05, adversarial GAP-4/GAP-5 — three independent producers; highest-stability finding of the audit.*
The scorer's universe is whatever reached `kalshi-settlement-validation.jsonl`. The validator is process-memory only and tracks only currently-open markets, with no backfill:

- `apps/market-worker/src/kalshi/settlementValidator.ts:147` — "  private readonly markets: Map<string, TrackedMarket> = new Map();"
- `apps/market-worker/src/kalshi/worker.ts:352` — "    markets = await adapter.listAllCrypto15mOpen(3);"

Markets that close during worker downtime are never finalized and are silently excluded at `apps/market-worker/scripts/w2_replay_scorer.py:123` — "        if ticker not in settle:". The §4 tripwire's denominator *shrinks* under the same degradation (`w2_replay_scorer.py:159` — "    uq_rate = len(unquoted) / max(1, len(settle))"), so it can improve as data is lost. Sub-1h worker-only outages (measured: Aug 3, 21:15–21:45Z) are caught by nothing — G4 watches collector channels only. **Consequence if closed:** establishes whether missing settlements cluster in volatile regimes; either voids the window correctly or certifies n, G1/G2/G6, and G3 on an unbiased sample before a live-money unlock.

**F2. The tagged instrument computes five of seven gates; the interim GO ignores eligibility entirely.** *(DIVERGENCE W2-S8-11, W2-S9-02; UNBOUND W2-S8-05, W2-S8-10, W2-S4-05; engineer GAP-3; skeptic GAP-06 — three producers.)*
§9 promises "the full G1–G7 battery," but the gates dict holds only {G1,G2,G3,G6,G7}; G4 exists only as a print-suppressed warning and G5 (tag/env integrity) is absent from the codebase entirely. The only aggregated verdict anywhere is:

- `apps/market-worker/scripts/w2_replay_scorer.py:227` — "        print(\"GO\" if gates and all(gates.values()) else \"CONTINUE\")"

In `--interim` mode all diagnostics are swallowed (`w2_replay_scorer.py:104` — "    out = (lambda *a, **k: None) if args.interim else print"), so a day-7 early GO can be minted on a window that is *already* §4-ineligible, boolean-only, with the operator seeing no tripwire. The doc's §4 wording ("all other gates passing at interim") and §8a's four-gate enumeration conflict inside the locked text itself. No NO-GO quadrant naming exists in code; the repo's only mechanical GO/NO-GO harness belongs to the separate maker track (`apps/data-collector/scripts/promotion-gate-check.sh:36` — "POLICY_COMMIT=\"1a5d741\"          # btcMakerV2.ts implementation commit (Gate 9)"). **Consequence:** removes the path where a human sees five PASSes and declares GO with eligibility and freeze unchecked — the last line before real money.

**F3. The gate-authoritative fee constant is unprovenanced and contradicted inside the repo's only fee document.** *(DIVERGENCE FEE-S4-01, FEE-S2-02; engineer GAP-6; constants ×3 — three producers.)*

- `apps/market-worker/scripts/w2_replay_scorer.py:76` — "    return math.ceil(round(0.07 * p * (1 - p) * 100, 9)) / 100" (peak 1.75¢ raw, 2¢ after ceil, at P=0.50)
- `docs/research/kalshi-fee-assumption-kxbtc15m.md:91` — "  to a peak of ~1.5625¢/contract at $0.50" (implies coefficient 0.0625, ~12% lower at peak)
- yet the same doc's line 16 — "taker_fee_rate_kxbtc15m = variable   # 0.07%–7% sliding by contract price; NOT used in v2" — is arithmetically consistent only with 0.07.

The evidentiary anchor both preregs depend on was never created: `docs/research/kalshi-fee-assumption-kxbtc15m.md:41` — "kalshi-fee-schedule-2025-07-01.pdf  SHA-256 = <fill at archive time>" is unfilled, the §7 checkbox at line 141 — "[ ] kalshi-fee-schedule-2025-07-01.<ext> attached alongside this file" — is unchecked, no schedule file exists repo-wide, and **the v2 prereg was locked anyway** (`docs/research/kxbtc15m-v2-preregistration.md:3` — "**Status:** **LOCKED**"), violating its own lock-validity condition. The R1–R6 ledger has zero per-trade fee fields to reconcile against. **Consequence:** the fee sits at the same scale as the +2.5¢ G1 margin; a wrong constant mechanically flips G1/G6 and therefore GO/NO-GO in either direction.

**F4. Stage B's live execution path diverges from the §5 sim in at least five pre-armed ways — each a declared VOID (plumbing) trigger.** *(DIVERGENCE W2-S11-01/02/04/05/07; constants:defensibility — two producers.)*

- Scope: all nine series are order-enabled, not BTC-only — `packages/kalshi-client/src/series.ts:22` — "  { series: \"KXETH15M\", underlying: \"ETH-USD\", cadenceSec: 900, cexSpotSymbol: \"ETHUSDT\", executionAllowed: true }," (same flag lines 21–29).
- Manual gate: default 3, not the confirmed 5, and never enforced on the Kalshi auto-submit path — `apps/market-worker/src/kalshi/dustExecutor.ts:123` — "    manualConfirmFirstN: num(\"KALSHI_DUST_MANUAL_CONFIRM_FIRST_N\", 3),".
- Plumbing trip: 3-loss auto-resuming backoff, not the 2-loss PAUSE-verify-resume — `dustExecutor.ts:384` — "    const streakLen = numEnv(\"KALSHI_DUST_BACKOFF_STREAK\", 3);".
- Aggregate cap: concurrent in-flight notional defaulting $3, not $25 cumulative-at-risk; no 48h timer — `dustExecutor.ts:347` — "    const aggregateCap = numEnv(\"KALSHI_DUST_MAX_AGGREGATE_USD\", 3);".
- Re-fire parity: live dedup is per ticker+side while the sim is first-fire-per-ticker — `dustExecutor.ts:759` — "  return `${c.ticker}|${c.side}`;" vs the sim's break at `w2_replay_scorer.py:152`; an opposite-side live fire is exactly §11's declared sim/live divergence.
- Plus: the live path applies a defensibility filter tuned on n≤15 (`dustExecutor.ts:169` — "  const edgeMin = numEnv(\"KALSHI_DEF_EDGE_MIN\", 0.02);") that the §5 sim never applies, and the §11 evidence stop (−$12.50) exists only as an env value to be supplied at arming (code default −$2).

**Consequence:** a GO followed by Stage B as-configured voids its own round on first contact. A one-page arming runbook (env vector + dedup fix) closes all of it before any order is placed.

**F5. The §4 unquoted tripwire — the prereg's only in-scorer data-quality guard — is structurally dead.** *(nominal H3, skeptic GAP-04; adversarial GAP-4 hits the same denominator — three producers.)*
A shadow row can only carry side YES/NO after the strategy's null-book gate, so the fired-side ask is non-null by construction and derived asks (1 − bid) always lie in (0,1); the guard at `w2_replay_scorer.py:132` — "            if a is None or not (0 < a < 1):" — can essentially never fire (W1: 0/840; W2 to date: 0/1,334). Real degradation manifests as SKIP `no_book` rows or missing rows, both invisible to it. **Consequence:** a degraded window reads "0.00% unquoted" and passes as clean; replacing the counter with fire-coverage (settled tickers with zero shadow rows) makes NO-GO (data) actually reachable by the failure it was designed for.

**F6. Crash-truncated gzip hours are silently unreadable past the cut, while hour-file-existence coverage still certifies eligibility.** *(nominal H1 — empirically confirmed with synthesized files; adversarial GAP-1/GAP-2; undoc G09/G12 — three producers.)*

- `apps/data-collector/src/persistence.ts:85` — "    const file = createWriteStream(path, { flags: \"a\" });" (post-crash relaunch appends a second gzip member into the same hour file, contradicting the module's own contract)
- `apps/data-collector/src/adequacyReport.ts:79` — "    if (err.code !== \"Z_BUF_ERROR\" && err.code !== \"ERR_STREAM_PREMATURE_CLOSE\") {" (readers tolerate only truncation-at-EOF; the appended post-restart member is silently lost)
- `apps/data-collector/src/adequacyReport.ts:321` — "// partial-hour file at either edge counts as \"present\" — file existence is" (a 1-minute file scores the hour 100% present; `adequacyReport.ts:426` — "    coverage.worstChannelCoveragePct >= MIN_WORST_CHANNEL_COVERAGE_PCT &&" then certifies holdout eligibility)

**Consequence:** G4 — the one gate meant to protect data integrity — can pass over an hour whose contents are largely unreadable; every crash-restart mid-hour poisons the raw W2 archive with no signal.

**F7. A live mutation channel into fair_yes sits outside the §6 freeze language — currently inert only by accident.** *(engineer GAP-5 OPEN; severity reduced by two closures proving bias ≡ 0 all window.)*
The frozen worker spawns a calibration recompute every 5 minutes whose read *and* write paths dangle into the dead pre-rename checkout — `apps/market-worker/scripts/compute_calibration.py:14` — "STATE = Path('/Users/aurascoper/Developer/polyterminal/apps/market-worker/logs/kalshi-dust-state.json')" — so `logs/calibration.json` is absent and the applied bias is provably zero (skeptic GAP-10 / undoc G01 closures). But §6 freezes only "code or env"; anyone dropping a calibration.json into `apps/market-worker/logs/` would be hot-loaded into `apps/market-worker/src/kalshi/strategy.ts:125` — "  const fair_yes = Math.max(0.05, Math.min(0.95, fair_yes_raw + CALIBRATION_ALPHA * bias));" — within 5 minutes, undetectably. **Consequence:** one §12-style line ("calibration.json must remain absent through W2") converts an accident into a guarantee.

**F8. The fallback spot feed serves stale prices forever; its σ can be estimated from ~30s of ticks.** *(undoc G02; constants:spotfeed — two producers.)*
`apps/market-worker/src/kalshi/spotFeed.ts:98` — "      // network blip — keep last good value" — with no age check anywhere on the spot input to `fairValueArbStrike` (the perp feed, by contrast, enforces 10s staleness). σ floor: `spotFeed.ts:60` — "    if (this.tape.length < 10) return null;" vs the BRTI path's deliberate ≥60s warmup. BCH/ADA always ride this path; every symbol does during BRTI warmup/outage. **Consequence:** during a feed outage the scanner manufactures phantom edges against a frozen price — logged into the W2 record now, traded with real money under Stage B.

**F9. Voided/scratched markets never finalize and are silently excluded — no void path exists in validator, scorer, or prereg quadrants.** *(engineer GAP-8.)*
`apps/market-worker/src/kalshi/worker.ts:654` — "      if (result === \"yes\" || result === \"no\") {" — is the only consumer of an untyped `result?: string`. Any other terminal value leaves the ticker tracked-forever, off the settled list, off the tripwire denominator. Voids plausibly cluster in disorderly regimes — exactly where the model is most exposed.

**F10. Legacy orderbook fallback lacks a cents→dollars conversion — a silent 100× unit poison one API change away.** *(nominal H2.)*
`packages/kalshi-client/src/client.ts:176` — "  const yesAsc = raw.orderbook_fp?.yes_dollars ?? raw.orderbook?.yes ?? [];" — the legacy field (integer cents per the adapter's own comment) is parsed with plain `Number(p)`, no `/100`, no range validation anywhere in `parseOrderbook`. If Kalshi ever drops `orderbook_fp`, every derived ask goes negative and the frozen window's shadow data corrupts without erroring.

### Tier 2 — Reproducibility

**F11. The α-calibration that licenses G2's thresholds is unreproducible.** *(skeptic GAP-07; constants:g2-z-bounds — two producers.)*
`w2_replay_scorer.py:46` — "G2_Z_FINAL = 1.70         # one-sided, α-adjusted for the §8a interim look" — and the 2.80 interim bound rest on a "Monte Carlo, 20k trials/row" whose code is absent from the tree and all of git history (the "13 of 71"/OC numbers enter the repo only via docs commit `9922abd`). The claimed P(GO|0)=3.4% cannot be checked or re-derived.

**F12. The W1 leak audit that justified the fill rule and the whole 14-day spend is unreproducible.** *(engineer GAP-10.)*
Asserted only at `docs/research/kx15m-w2-btc-stratified-shadow-preregistration.md:72` — "**W1 leak audit of this rule** (targeted book replay, ±15s around each S1 fill): 13 of 71 fills (18%) showed the ask ticking above *A* within 2s of signal…" — no replay script or output exists anywhere; `analysis/w2/` is empty. The +2.2¢–+3.83¢ bracket around G1 is untestable.

**F13. §6's promised env-at-lock record was never made; G5 is unverifiable from committed artifacts.** *(UNBOUND W2-S6-01, W2-HDR-01; engineer GAP-4; partially mitigated by skeptic GAP-11's runtime attestation.)*
`docs/research/kx15m-w2-btc-stratified-shadow-preregistration.md:78` — "…The lock records the code tag and the worker's effective env (`KALSHI_SCAN_INTERVAL_MS` etc.)…" — but both lock commits touch only the doc; the value exists solely as the code default `apps/market-worker/src/kalshi/worker.ts:53` — "const SCAN_INTERVAL_MS = numEnv(\"KALSHI_SCAN_INTERVAL_MS\", 15_000);". Runtime inspection (ps/launchctl/136 startup log lines) attests defaults were in force — but that is observation, not a committed lock record, and the launcher loads uncommitted `.env` files the frozen tree cannot reproduce. Strategy env knobs (SIGMA_MULTIPLIER, MIN_Z_DISTANCE, CALIBRATION_ALPHA) share the gap.

**F14. Settlement-methodology provenance: the 60s-BRTI-mean window, ties-to-YES boundary, and result-lag figures are unsourced; thin-side rows contaminate the 89.4% statistic's inputs.** *(engineer GAP-7; constants ×2; undoc G03 — two-plus producers.)*
`apps/market-worker/src/kalshi/settlementValidator.ts:31` — "export const SETTLEMENT_WINDOW_MS = 60_000;" — cites "Kalshi's documented settlement window" with no archived rulebook anywhere. Rejection uses AND-semantics — `settlementValidator.ts:212` — "    if (stats.brti_n < MIN_SAMPLES_PER_WINDOW && stats.binance_n < MIN_SAMPLES_PER_WINDOW) {" — so a 3-sample BRTI mean still emits an implied result; whether the load-bearing 89.4% BRTI-authority stat excluded such rows is unanswerable in-repo. Also self-contradicting: `worker.ts:645` — "  const FINALIZE_GRACE_MS = 30_000;" — is half the lower bound of the 60–120s lag its own comment claims to cover.

**F15. G7 benchmarks against a vig-contaminated spread midpoint although microprice inputs are already logged.** *(skeptic GAP-12.)*
`w2_replay_scorer.py:149` — "                \"mid\": (byb + bya) / 2 if byb is not None and bya is not None else None," — on wide books (where this scanner fires) the paired Brier test's bias direction favors the model; no mid-vs-microprice comparison exists anywhere. A G7 PASS cannot currently distinguish exceedance skill from a wide-quote artifact — and G7 is the mechanism gate NO-GO quadrants pivot on.

**F16. The dormant maker-track gate harness can self-certify.** *(skeptic GAP-08/GAP-09.)*
Gate 9's freeze diff covers only two policy files — `apps/data-collector/scripts/promotion-gate-check.sh:38` — "POLICY_FILES=\"apps/data-collector/src/replay/btcMakerV2.ts apps/data-collector/src/replay/btcMakerV2Capped.ts\"" — excluding the entire replay/scoring harness that produces every scraped number; gates 2/3/4/5/6/8 are read by grepping the report's own printed marks (`promotion-gate-check.sh:68` — "  line=\"$(grep -E \"^$pat\" \"$f\" 2>/dev/null | head -1)\""). Weight: dormant track, not the live W2 verdict.

**F17. Measurement-layer blind spots in the collector/replay stack.** *(adversarial GAP-6/7/8 + undoc G05/G08/G10/G11; nominal H4 — multiple two-producer overlaps.)*

- Cadence sampler permanently freezes after one ≥10-min gap — `apps/data-collector/src/adequacyReport.ts:246` — "            if (dt > 0 && dt < 600_000) {" — censoring exactly the post-incident tail (also undoc G10).
- Discovery caps: worker 3 vs collector 10 per series with no pagination or warning — `apps/data-collector/src/index.ts:165` — "      const r = await client.listMarkets({ status: \"open\", series_ticker: cfg.series, limit: 10 });" — an 11th concurrent market is actively unsubscribed; a >3-strike ladder silently exits the W2 universe (also constants; worker's 3 is rate-budget-derived but the superset relationship is undocumented).
- Strikeless markets vanish from every log with warm feeds — `worker.ts:412` — "    if (!m.strike) continue;" (undoc G05); orderbook-fetch failures leave no row and no counter — `worker.ts:418` — "      state.lastError = `getOrderbook(${m.ticker}): ${(err as Error).message}`;" (nominal H4; note: two closures found the prereg pre-commits the stretched-horizon *direction* as harsher — what remains open is only that the failure rate is unmeasured).
- Worker JSONL appends are best-effort, console-only — `worker.ts:810` — "    console.warn(`[kalshi-worker] append failed (${path}):`, err);" (undoc G11) — G5 attests code, never the measurement files.
- Maker replay: split null-imputation across adjacent columns of one table — `apps/data-collector/src/replay/passiveQuoteSimulator.ts:372` — "    const mos = within.map((r) => r.markouts.ms_30000).filter((x): x is number => x !== null);" vs `:375` — "    const sumMoCents = within.reduce((acc, r) => acc + (r.markouts.ms_30000 ?? 0), 0);" — plus a 120s staleness null at `apps/data-collector/src/replay/queueModel.ts:315` — "  if (targetTs - ts > 120_000) return null;" and FIFO queue position carried unflagged through post-outage snapshot reseats at `queueModel.ts:434` — "    if (ev.type === \"snapshot\") applySnapshot(state, ev);".

### Tier 3 — Documentation

**F18. Load-bearing policy constants are stated, not derived.** *(constants ×7.)* `w2_replay_scorer.py:44` — "GATE_PNL_CENTS = 2.5      # G1 / G6 threshold, ¢/contract" (W1's truth bracket straddles it); `strategy.ts:18` — "const SAFETY_BUFFER = 0.005; // 50 bps cushion above market spread"; `strategy.ts:19` — "const EDGE_FLOOR = 0.0075; // 75 bps minimum net edge after spread + safety"; the [0.05, 0.95] clamp; 6h G6 blocks (removing ~2% of fills — possibly too lenient a "robustness" test); the 2% tripwire boundary; the 10-tick σ floor. None has a recorded rationale; a NO-GO (economics) cannot be routed to threshold-research vs model-research without knowing which numbers model real costs.

**F19. The locked prereg contradicts itself on power.** *(constants.)* `kx15m-w2-btc-stratified-shadow-preregistration.md:113` — "Power note: at W1's observed per-trade dispersion … preliminary ≈ 11–13¢ sd), n ≈ 250 filled gives se ≈ 0.8¢ …" — uses the sd its own §4/§12 corrected to ~48¢ (true se ≈ 3.0¢, ~4× larger). Needs a dated erratum in a companion file to prevent a NO-GO being over-read as evidence of no edge.

**F20. Procedural-freeze cluster (UNBOUND, by design but unstated).** W2-HDR-01/HDR-04, S1-01, S4-01/S4-02, S11-08: no code computes the window start ("first UTC hour boundary after lock"), the 14-day duration, the score-once discipline, or the live-vs-sim fill-rate reading rule — the scorer takes operator-supplied `--since/--until` and is freely re-runnable. Acceptable for a procedural prereg, but the close checklist should say so explicitly, because F2 removes any mechanical backstop.

---

## Appendix A — Closed/resolved items (evidence the process ran)

| Item | Status | One-line disposition |
|---|---|---|
| explain:engineer:GAP-1 | CLOSED | Worker outage does not void W2 under the locked text — G4 is collector-only; outage effect lands in F1 instead |
| explain:engineer:GAP-9 | RESOLVED | §7 explicitly declares peeking "procedurally meaningless" — honor-system is a locked design decision, not a hole |
| explain:engineer:GAP-11 | CLOSED | Loaded plists byte-identical to repo; launchctl shows supervised launcher, gates 0/0/0 in active env |
| explain:engineer:GAP-12 | CLOSED | σ = 1h of 1-min returns, MIN_MINUTE_SAMPLES=10, ×√525,600 verified; worker.ts:5/:883 comments confirmed stale |
| explain:skeptic:GAP-01 | RESOLVED | "3 concurrent BTC markets" misread an API limit; measured: exactly 1 open KXBTC15M per tick × 9,693 ticks |
| explain:skeptic:GAP-02 | CLOSED | Persistence horizon measured: median 15.0s, zero sub-2s interleaving, 136/136 starts at 15000ms |
| explain:skeptic:GAP-03 | CLOSED | No-fill three-way split measured: 590 true-fade / 0 feed-null / 0 no-next-row — contamination zero to date |
| explain:skeptic:GAP-10 | CLOSED | Calibration bias provably ≡ 0 all window (dangling paths, file absent, loop inert) — residual freeze-language risk moved to F7 |
| explain:skeptic:GAP-11 | CLOSED | Full env vector attested at runtime: all four load-bearing params at code defaults, no mid-window plist edit |
| trace:nominal:MP1–MP10 | CLOSED | Ten wrong/unverifiable trace predictions all resolved by direct read or live-log decode |
| trace:nominal:D1, D2 | CLOSED | Doc-drift confirmed (5s-vs-15s scan header; local-vs-UTC hour comment); one-line comment fixes, out of scope read-only |
| trace:adversarial:GAP-3 | CLOSED | Stretched next-scan gaps are pre-committed in the locked §5 as strictly harsher — defined, not undefined |
| spec:undoc:G01 | CLOSED | Clamp/α/5-min loop documented in README §; loop provably inert (see F7) |
| spec:undoc:G04 | CLOSED | Ties-to-YES boundary documented in kalshi-orderbook-semantics.md; validator mirrors it |
| spec:undoc:G06 | RESOLVED | Per-ticker fetch-failure horizon stretch is an instance of §5's documented cause-agnostic rule |
| spec:undoc:G07 | RESOLVED | Mixed spot/σ sources documented in README's canonical row example; rate computable from logs |

---

## Five questions a skeptical reviewer would ask that the repo cannot answer

1. **How many KXBTC15M markets actually settled on the exchange during the W2 span, and are the ~34 missing from `kalshi-settlement-validation.jsonl` missing at random or clustered in volatile regimes?** No reconciliation against Kalshi's settled listing exists (F1).
2. **What is Kalshi's actual taker fee formula for KX*15M — coefficient 0.07 or 0.0625 — as of the lock date?** The repo's only fee document supports both on different lines and its mandatory schedule archive was never attached (F3).
3. **Does P(GO|zero edge) = 3.4% actually hold for the G2 1.70/2.80 threshold pair?** The 20k-trial Monte Carlo exists nowhere (F11).
4. **Do 13 of 71 W1 fills really fade within 2s — does the leak audit reproduce from the collector's book archive?** The script and output were never committed (F12).
5. **Where does Kalshi's rulebook specify that 15M binaries settle on a 60-second BRTI mean with ties to YES?** The window shape underpinning the 89.4% BRTI-authority statistic is asserted only in code comments (F14).

## The explanation this audit is least confident in

**That the scorer's 0.07 fee coefficient is wrong (F3's "~12% overstated at peak" reading).** The contradicting evidence is a single prose line in the *maker-track* fee archive ("~1.5625¢ peak"), while line 16 of the same document ("0.07%–7% sliding") is arithmetically consistent only with 0.07, and 0.07·P·(1−P) matches Kalshi's widely-cited general formula. The 1.5625¢ figure may simply be sloppy arithmetic in a document about a fee the maker strategy never pays. The audit can confidently say the constant is *unprovenanced* (no archived schedule, no ledger reconciliation); it cannot confidently say it is *incorrect* — and the two claims have opposite remediation urgency.

## The one-page doc that would close the most OPEN items

**`docs/research/w2-evidence-annex-and-close-protocol.md`** — a single committed page containing:

1. **Fee provenance:** archived Kalshi taker-fee schedule excerpt + SHA-256, reconciling 0.07 vs 0.0625 and retro-satisfying the fee doc's §7 checklist → closes F3 (and the strongest half of F18).
2. **Settlement provenance:** archived KX*15M rulebook excerpt (60s BRTI mean, tie rule, result-lag, void/scratch semantics) → closes F14, most of F9.
3. **Env-at-lock attestation:** the effective worker env vector (scan interval, σ multiplier, calibration α, min-z, gates), dated, with the launchctl/ps evidence transcribed → closes F13; plus one sentence freezing `calibration.json` as must-remain-absent → closes F7.
4. **Mechanical close checklist (G4+G5 wrapper):** run adequacy over the W2 span **and** a shadow-log/settlement-reconciliation continuity check, git-diff the frozen paths against both tags, and only then accept the scorer's gate line (interim included); name the quadrant from the printed gates → closes F2, arms F1's detection, and formalizes F20.
5. **Reproducibility commitments:** commit the OC Monte Carlo and the W1 fade-audit script with outputs at the scorer-tag lineage → closes F11, F12.
6. **Erratum:** corrected power arithmetic (se ≈ 48¢/√n) → closes F19.
7. **W2′ declaration:** the Aug 4–5 outage record and the NO-GO (data)/W2′ restart decision, logged per §4's own rule — converting the headline finding from an audit assertion into an operator act.

By count, that one page closes or decisively arms 7 of the 10 highest-ranked findings; everything remaining (F4's Stage-B runbook, F5/F6/F8/F10's code guards, F15's microprice study) requires code or analysis, not documentation.

---

## Addendum B — CLAUDE.md as spec surface (added 2026-08-05, post-publication)

The main run treated `docs/research/` as the spec corpus. `CLAUDE.md` is also a spec surface — it is the first document every agent session loads — and applying the same claims-vs-repo discipline to it yields three findings, cross-checked against Anthropic's Claude-5 context-engineering guidance (claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models):

**B1. Stale phase claim (DIVERGENCE-class).** CLAUDE.md described the repo as "shadow + Layer-1/Layer-2 bakeoff mode as of 2026-05-17" with no mention of the locked W2 prereg (`dbbe3e1`/`7a71347`), the tags `stage-a-holdout-20260801` / `w2-scorer-final-20260803`, or the §6 freeze semantics that govern what may change while a window is open. A session briefed only by CLAUDE.md could edit frozen paths without knowing a lock exists — the same failure mode as F13, but at the instruction layer.

**B2. Internal contradiction (rule-5 violation).** The Layout section omitted `apps/data-collector` entirely, while the Holdout-eligibility convention in the same file cites `apps/data-collector/src/adequacyReport.ts`. One of the two sections was authoritative; a reader could not tell which.

**B3. Derivable content crowding out signal.** The Stack section (tool versions) and most Layout one-liners restate `package.json` and `ls` — per the context-engineering guidance, CLAUDE.md should carry gotchas and non-derivable patterns, with detail progressive-disclosed to the files that own it.

**Resolution (2026-08-05):** CLAUDE.md rewritten — phase claim updated to name the locked prereg and freeze; `apps/data-collector` added to Layout; derivable content removed; the holdout policy compressed to its "policy, not tunables" warning plus pointers to `adequacyReport.ts`; and audit findings F1, F2, F7, F10 promoted into the Gotchas section with a pointer to this report. The Karpathy-style generic behavioral scaffolding (multica-ai/andrej-karpathy-skills) was evaluated and deliberately **not** imported: its rules duplicate harness defaults, and the same guidance's conflicting-instructions rule scores wholesale import as negative-value.