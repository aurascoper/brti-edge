# polyterminal (brti-edge)

Systematic trading research for **Kalshi 15-minute crypto binary markets** (KXBTC15M, KXETH15M, KXSOL15M, KXBNB15M, KXDOGE15M, KXXRP15M, KXHYPE15M, KXBCH15M, KXADA15M). pnpm + Turborepo TypeScript monorepo with a Next.js web app, a Node worker that runs the scan loop, and Python offline analysis. **Live trading is paused** as of 2026-05-17 — repo is in shadow + Layer-1/Layer-2 bakeoff mode after 6 rounds and 285 filled trades ended in a small loss.

## Stack
- pnpm 9 + Turborepo 2; TypeScript 5.6; Node ≥20
- Web: Next.js 14 (`apps/web`), Tailwind, Reown/WalletConnect (Polymarket flow); React providers
- Worker: pure TS (`apps/market-worker`) — Kalshi RSA-PSS auth, BRTI aggregation (Coinbase + Kraken + Bitstamp), Binance.US fallback, Kraken Futures perp basis feed
- Shared packages: `kalshi-client`, `polymarket-client`, `market-state`, `signals`, `types`, `ui`
- Offline analysis: Python (Brier-score bakeoff scripts under `analysis/brier/`)

## Run / test / build
```sh
pnpm install
pnpm dev                                # turbo run dev --parallel — worker + web
pnpm build
pnpm lint
pnpm typecheck

# Worker only
cd apps/market-worker && pnpm dev

# Web only
cd apps/web && pnpm dev

# Offline Brier bakeoff (Python)
python scripts/brier_bakeoff.py         # joins validator + Layer-2 + filled state for prospective scoring
```

## Layout
- `apps/web/` — Next.js 14 dashboard for live markets, Polymarket wallet integration, BRTI vs Binance display
- `apps/market-worker/` — TS scan loop. `src/` is split into `brti/`, `execution/`, `history/`, `kalshi/`, `state/`, `strategy/` + `index.ts` entry
- `packages/kalshi-client/` — Kalshi API client (RSA-PSS auth)
- `packages/polymarket-client/` — Polymarket CLOB client (handles Safe-proxy `sigType=2` and deposit-wallet `sigType=3` flows)
- `packages/market-state/` — in-memory market state machine
- `packages/signals/` — fairValueArb, OFI, basis features
- `packages/types/` — shared TS types
- `packages/ui/` — shared React components
- `analysis/brier/` — outputs of `scripts/brier_bakeoff.py`
- `docs/run-ledgers/kalshi-r1-r6-ledger.jsonl` — canonical ledger of every R1–R6 trade (285 fills)
- `.env.example` — exhaustively commented; read top-to-bottom before configuring

## Conventions
- **Shadow-first.** `KALSHI_ALLOW_ORDERS=0`, `AUTO_SUBMIT=0`, `DUST_ENABLED=0` are the safe defaults. Live trading requires deliberately flipping these.
- **Layer 1 / Layer 2 split:** Layer 1 = `fair_yes = Φ(z)` calibration variants (Gaussian, clip, logistic, Student-t). Layer 2 = candidate features (spot-perp basis, OFI, basis-change, …) scored prospectively before any live retest.
- **5%-skill gate.** A model variant must beat climatology Brier 0.250 by ≥5% on walk-forward filled trades before consideration for live. Best Layer-1 result so far was 0.93% — failed gate.
- **BRTI is settlement-authoritative.** Out of 188 disagreements between BRTI and Binance windowed means, BRTI matched Kalshi 168 times (89.4%, binomial p = 1.27e-30). Don't switch to Binance as the primary signal.
- Polymarket has two parallel flows on Polygon — see `.env.example` for `sigType=2` (Safe proxy, USDC.e) vs `sigType=3` (deposit wallet, pUSD) contract addresses. Default config is `sigType=2`.

## Gotchas
- **Live trading paused.** Don't restart R7 without (1) Layer-2 features clearing the gate, (2) tight bankroll envelope.
- **R3's profit was lucky, not edge.** Fisher exact R3 vs R6: p = 0.37 — the two profitable rounds are not statistically distinguishable. True edge is much smaller than R3's +$9.48 sample suggested.
- **Kelly was overbet in R4** ($50→$250 mid-round) → −$29.82 and hard-stop hit. Don't bump Kelly mid-round.
- **σ ceiling matters.** Adding `KALSHI_DEF_SIGMA_MAX=0.40` (R2) hurt; tightening to `KALSHI_DEF_YES_MIN_EDGE=0.15` (R3) helped. These thresholds are load-bearing.
- **Selector vs shadow thresholds are different env vars.** `POLYTERMINAL_YES_MIN/MAX` gate live selection; `POLYTERMINAL_SHADOW_YES_MIN/MAX` widen sampling for the shadow logger only.
- **RSA-PSS auth is finicky.** Kalshi clock skew kills signatures — check NTP if you see 401s.
- **`.env.example` documents the two Polymarket flows in detail** — don't override contract addresses without reading the comments first.
- **Canonical ledger lives at `docs/run-ledgers/kalshi-r1-r6-ledger.jsonl`** — append-only, immutable historical record. Don't edit prior rows; reconcile via new ones.
- Despite the repo name `polyterminal`, the active product is the Kalshi side (BRTI-edge); the Polymarket integration is secondary.
