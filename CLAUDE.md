# polyterminal (brti-edge)

Systematic trading research for **Kalshi 15-minute crypto binary markets** (KXBTC15M, KXETH15M, KXSOL15M, KXBNB15M, KXDOGE15M, KXXRP15M, KXHYPE15M, KXBCH15M, KXADA15M). pnpm + Turborepo TypeScript monorepo: Next.js web app, Node workers (scan loop + data collector), Python offline analysis. Despite the repo name `polyterminal`, the active product is the Kalshi side (BRTI-edge); the Polymarket integration is secondary.

**Live trading is paused** (since 2026-05-17, after R1–R6: 285 fills, small net loss). The current phase is governed by a **locked preregistration**: `docs/research/kx15m-w2-btc-stratified-shadow-preregistration.md` (`KX15M_FV_TAKER_BTC_W2`, lock commits `dbbe3e1`/`7a71347`, tag `w2-scorer-final-20260803`). Its §6 **freeze** restricts what may change while a scoring window is open — check it before editing anything under `apps/market-worker/` or the scorer. Re-arming live requires the prereg's gate battery, never just flipping order flags.

## Run / test / build
```sh
pnpm install
pnpm dev                                # turbo run dev --parallel — worker + web
pnpm build
pnpm lint
pnpm typecheck

# Worker only — TWO separate workers live in apps/market-worker (one Node package, two entry points):
cd apps/market-worker && pnpm dev          # Polymarket-side: src/index.ts (BTC up/down, gamma-api, Polymarket WS)
cd apps/market-worker && pnpm kalshi-dev   # Kalshi-side: src/kalshi/worker.ts (15M crypto markets, BRTI, RSA-PSS, dust executor)
# The repo-root `pnpm dev` runs BOTH via turbo's parallel fan-out. App-level `pnpm dev` is Polymarket ONLY.
# Maker order/cancel dry-run = `pnpm kalshi-dev` with KALSHI_ALLOW_ORDERS=0 (HTTP /dust/submit returns 403).
# In production the Kalshi worker + data collector run as launchd agents (com.polyterminal.kalshi-*),
# supervised by scripts under apps/*/scripts/ — don't also start them by hand.
```

## Layout (annotated — only the non-obvious)
- `apps/market-worker/` — TS scan loop; `src/` split into `brti/`, `execution/`, `history/`, `kalshi/`, `state/`, `strategy/`. The W2 scorer is `scripts/w2_replay_scorer.py`.
- `apps/data-collector/` — tick archive, adequacy/holdout-eligibility reporting (`src/adequacyReport.ts`), and the maker-track replay/scoring stack (`src/replay/`, `scripts/promotion-gate-check.sh`).
- `packages/kalshi-client/` — Kalshi API client (RSA-PSS auth; clock skew kills signatures).
- `packages/polymarket-client/` — Polymarket CLOB client; two parallel Polygon flows, `sigType=2` (Safe proxy, USDC.e, default) vs `sigType=3` (deposit wallet, pUSD) — `.env.example` documents both; don't override contract addresses without reading it.
- `docs/run-ledgers/kalshi-r1-r6-ledger.jsonl` — canonical append-only ledger (285 fills). Never edit prior rows; reconcile via new ones.
- `docs/research/` — preregistrations and methodology docs, including the locked W2 prereg and the fee/orderbook-semantics references.
- `analysis/feynman-audit-20260805.md` — full spec-vs-code audit at HEAD `7a71347`; read it before trusting any gate output.
- `.env.example` — exhaustively commented; read top-to-bottom before configuring.

## Conventions
- **Shadow-first.** `KALSHI_ALLOW_ORDERS=0`, `AUTO_SUBMIT=0`, `DUST_ENABLED=0` are the safe defaults. Live requires deliberately flipping these *and* satisfying the prereg protocol.
- **Layer 1 / Layer 2 split:** Layer 1 = `fair_yes = Φ(z)` calibration variants (Gaussian, clip, logistic, Student-t). Layer 2 = candidate features (spot-perp basis, OFI, basis-change, …) scored prospectively before any live retest.
- **5%-skill gate.** A model variant must beat climatology Brier 0.250 by ≥5% on walk-forward filled trades before consideration for live. Best Layer-1 result so far: 0.93% — failed gate.
- **Holdout eligibility constants are policy, not tunables.** The ≥30-hour / ≥99%-worst-channel / ≤1h-gap thresholds in `isContinuousHoldoutEligible()` (`apps/data-collector/src/adequacyReport.ts`) define pass/fail for every previously-scored holdout — changing them retroactively breaks that interpretation. Eligibility is independent of the structural-adequacy verdict; detail lives in the adequacy report and `docs/research/kalshi-data-collector-30h-2026-05-26.md`.
- **BRTI is settlement-authoritative.** Out of 188 BRTI-vs-Binance disagreements, BRTI matched Kalshi 168 times (89.4%, binomial p = 1.27e-30). Don't switch to Binance as the primary signal.

## Gotchas
- **R3's profit was lucky, not edge.** Fisher exact R3 vs R6: p = 0.37 — the profitable rounds are statistically indistinguishable. True edge is much smaller than R3's +$9.48 sample suggested.
- **Kelly was overbet in R4** ($50→$250 mid-round) → −$29.82 and hard-stop hit. Don't bump Kelly mid-round.
- **σ ceiling matters.** `KALSHI_DEF_SIGMA_MAX=0.40` (R2) hurt; `KALSHI_DEF_YES_MIN_EDGE=0.15` (R3) helped. These thresholds are load-bearing.
- **Selector vs shadow thresholds are different env vars.** `POLYTERMINAL_YES_MIN/MAX` gate live selection; `POLYTERMINAL_SHADOW_YES_MIN/MAX` widen sampling for the shadow logger only.
- **RSA-PSS auth is finicky.** Kalshi clock skew kills signatures — check NTP if you see 401s.
- **Settlement capture has no backfill.** `settlementValidator.ts` tracks only currently-open markets in process memory; markets that close during worker downtime silently vanish from the scorer universe, and the §4 tripwire denominator *shrinks* with them. Reconcile settlement counts before trusting any gate output (audit F1).
- **Never act on a bare scorer `GO`.** `w2_replay_scorer.py --interim` swallows all diagnostics; G4 (data eligibility) and G5 (env integrity) are computed nowhere — run the adequacy check and freeze diff first (audit F2).
- **`apps/market-worker/logs/calibration.json` must remain absent through any frozen window** — if the file appears, it hot-loads into `fair_yes` within 5 minutes, undetectably (audit F7).
- **Legacy orderbook fallback is a 100× unit trap.** `kalshi-client` parses the legacy integer-cent book without `/100`; if Kalshi drops `orderbook_fp`, shadow data corrupts silently (audit F10).
