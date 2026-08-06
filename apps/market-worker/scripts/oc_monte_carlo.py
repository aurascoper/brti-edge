#!/usr/bin/env python3
"""Operating-characteristics Monte Carlo for the W2/W2′ gate battery (audit F11).

Reproduces the §4 OC table of kx15m-w2-btc-stratified-shadow-preregistration.md:
20k trials/row, all P&L gates jointly — G1 (mean >= +2.5¢), G2 (one-sided
z >= 1.70 final / z >= 2.8 at the single day-7 interim, with the other gates
passing at interim), G3 (n >= 200), G6 (leave-one-6h-block-out mean >= +2.5¢) —
at per-trade sd 48¢, 96 signals/day, 59% fill rate, 14 days.

The prereg's claimed row: true edge 0 -> P(GO) = 3.4%, P(early GO) = 0.3%.
This script makes that claim checkable; its committed output is the evidence
artifact the audit found missing. Deterministic under --seed (default 20260806).

Usage: python3 scripts/oc_monte_carlo.py [--trials 20000] [--seed 20260806]
"""
from __future__ import annotations

import argparse
import math
import random

DAYS = 14
SIGNALS_PER_DAY = 96
FILL_RATE = 0.59
SD = 0.48            # dollars per contract
G1 = 0.025           # dollars
G3_MIN_N = 200
Z_FINAL = 1.70
Z_INTERIM = 2.80
BLOCK_HOURS = 6
BLOCKS = DAYS * 24 // BLOCK_HOURS
INTERIM_DAY = 7


def one_trial(rng: random.Random, edge: float) -> tuple[bool, bool]:
    """Returns (go, early_go)."""
    # Fill times uniform over the window (signal flow is ~uniform per day).
    n_signals = DAYS * SIGNALS_PER_DAY
    fills = []  # (day_frac, pnl)
    for _ in range(n_signals):
        if rng.random() < FILL_RATE:
            t = rng.random() * DAYS
            fills.append((t, edge + rng.gauss(0.0, SD)))
    if not fills:
        return False, False

    def battery(sub, z_bound) -> bool:
        n = len(sub)
        if n < G3_MIN_N:
            return False
        xs = [p for _, p in sub]
        m = sum(xs) / n
        var = sum((x - m) ** 2 for x in xs) / (n - 1)
        se = math.sqrt(var / n)
        if m < G1 or se <= 0 or m / se < z_bound:
            return False
        blocks: dict[int, list[float]] = {}
        for t, p in sub:
            blocks.setdefault(int(t * 24 // BLOCK_HOURS), []).append(p)
        if len(blocks) > 1:
            best = max(blocks, key=lambda b: sum(blocks[b]))
            rest = [x for b, v in blocks.items() if b != best for x in v]
            if not rest or sum(rest) / len(rest) < G1:
                return False
        return True

    early = battery([f for f in fills if f[0] <= INTERIM_DAY], Z_INTERIM)
    final = battery(fills, Z_FINAL)
    return early or final, early


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=20_000)
    ap.add_argument("--seed", type=int, default=20260806)
    args = ap.parse_args()

    print(f"# OC Monte Carlo — trials/row={args.trials} seed={args.seed}")
    print(f"# sd={SD * 100:.0f}¢  {SIGNALS_PER_DAY} signals/day × {DAYS}d × "
          f"{FILL_RATE:.0%} fill  G1>={G1 * 100}¢  G3>={G3_MIN_N}  "
          f"z_final>={Z_FINAL}  z_interim>={Z_INTERIM}")
    print(f"{'true edge':>10} | {'P(GO)':>7} | {'P(early GO)':>11} | prereg claim")
    claims = {0.0: ("3.4%", "0.3%"), 0.025: ("36.3%", "3.7%"),
              0.0383: ("65.9%", "10.9%"), 0.07: ("98.8%", "54.7%")}
    for edge in (0.0, 0.025, 0.0383, 0.07):
        rng = random.Random(args.seed + int(edge * 10_000))
        go = early = 0
        for _ in range(args.trials):
            g, e = one_trial(rng, edge)
            go += g
            early += e
        c = claims.get(edge, ("—", "—"))
        print(f"{edge * 100:>9.2f}¢ | {go / args.trials:>6.1%} | "
              f"{early / args.trials:>10.1%} | P(GO) {c[0]}, early {c[1]}")


if __name__ == "__main__":
    main()
