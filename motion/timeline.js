window.TIMELINE = {
 "meta": {
  "title": "BRTI-EDGE × KALSHI",
  "subtitle": "DUST EXECUTOR — SIX ROUNDS, 285 FILLS",
  "source": "docs/run-ledgers/kalshi-r1-r6-ledger.jsonl",
  "venue": "KALSHI 15-MINUTE CRYPTO BINARIES",
  "series": [
   "KXBTC15M",
   "KXETH15M",
   "KXSOL15M",
   "KXXRP15M",
   "KXDOGE15M"
  ],
  "startBankroll": 51.28,
  "duration": 60
 },
 "curve": [
  {
   "label": "R1-R2",
   "v": 1.75
  },
  {
   "label": "R3",
   "v": 11.23
  },
  {
   "label": "R4 peak",
   "v": 14.5
  },
  {
   "label": "R4 halt",
   "v": -18.59
  },
  {
   "label": "R5",
   "v": -24.02
  },
  {
   "label": "R6",
   "v": -32.99
  },
  {
   "label": "R7",
   "v": -34.05
  }
 ],
 "scenes": [
  {
   "t0": 0,
   "t1": 6,
   "id": "intro",
   "kind": "title",
   "round": "—",
   "step": "0 / 7",
   "kill": "ARMED",
   "question": "Can a fair-value model beat 15-minute crypto binaries?",
   "config": {
    "KALSHI_DEF_YES_MIN_EDGE": 0.15,
    "KALSHI_DEF_SIGMA_MAX": 0.4,
    "KALSHI_DUST_KELLY_BANKROLL": 50,
    "KALSHI_DUST_MAX_NOTIONAL_USD": 5,
    "KALSHI_DUST_MAX_TRADES": 30,
    "KALSHI_DUST_HARD_STOP_PNL_USD": -15,
    "KALSHI_DUST_MAX_AGGREGATE_USD": 150,
    "KALSHI_DUST_BACKOFF_LOSS_USD": 8
   },
   "bankrollAt": 1.75,
   "lines": [
    "ONE STRATEGY. ONE CONFIG. ONE KILL SWITCH.",
    "BANKROLL $51.28 · KELLY $50 · HARD STOP $-15"
   ]
  },
  {
   "t0": 6,
   "t1": 15,
   "id": "r3",
   "kind": "round",
   "round": "R3",
   "step": "1 / 7",
   "kill": "ARMED",
   "question": "R3 · does the edge exist?",
   "verdict": {
    "text": "BEST ROUND TO DATE",
    "tone": "good"
   },
   "pnl": 9.48,
   "cumFrom": 1.75,
   "cumTo": 11.23,
   "winRate": 70,
   "ledger": [
    {
     "k": "trades settled",
     "v": "30 / 30",
     "ok": true
    },
    {
     "k": "record",
     "v": "21W / 9L",
     "ok": true
    },
    {
     "k": "round pnl",
     "v": "+$9.48",
     "ok": true
    },
    {
     "k": "halts tripped",
     "v": "0",
     "ok": true
    },
    {
     "k": "NO-side trades",
     "v": "30 / 30",
     "ok": true
    }
   ],
   "gates": [
    {
     "k": "yes_min_edge ≥ 0.15",
     "v": 61
    },
    {
     "k": "sigma_max ≤ 0.40",
     "v": 17
    },
    {
     "k": "backoff",
     "v": 0
    },
    {
     "k": "hard_stop −$15",
     "v": 0
    }
   ],
   "chain": [
    {
     "k": "gamma_trap_R4A",
     "v": "FALSIFIED · p=0.35",
     "tone": "dim"
    },
    {
     "k": "btc_specific_R4B",
     "v": "WEAK · btc $-3.27",
     "tone": "dim"
    },
    {
     "k": "validator A/B",
     "v": "BRTI 88.9% of 117",
     "tone": "good"
    }
   ],
   "tickers": [
    {
     "k": "KXBTC15M",
     "w": 5,
     "l": 4,
     "pnl": -3.27
    },
    {
     "k": "KXETH15M",
     "w": 3,
     "l": 2,
     "pnl": 0.66
    },
    {
     "k": "KXSOL15M",
     "w": 6,
     "l": 1,
     "pnl": 5.09
    },
    {
     "k": "KXXRP15M",
     "w": 4,
     "l": 1,
     "pnl": 2.63
    },
    {
     "k": "KXDOGE15M",
     "w": 1,
     "l": 0,
     "pnl": 2.2
    }
   ],
   "note": "“No new lever justified by data.”"
  },
  {
   "t0": 15,
   "t1": 21,
   "id": "bump",
   "kind": "event",
   "round": "R4",
   "step": "2 / 7",
   "kill": "ARMED",
   "question": "R4 · mid-round: Kelly $50 → $250",
   "verdict": {
    "text": "5× SCALE-UP ON n=30 EVIDENCE",
    "tone": "warn"
   },
   "cumFrom": 11.23,
   "cumTo": 13.7,
   "ledger": [
    {
     "k": "trigger",
     "v": "cum pnl > $11.23",
     "ok": true
    },
    {
     "k": "at trade",
     "v": "5 of 30",
     "ok": true
    },
    {
     "k": "record at bump",
     "v": "3W/1L",
     "ok": true
    },
    {
     "k": "round is now",
     "v": "MIXED-KELLY · invalid as test",
     "ok": false
    }
   ],
   "extrapolation": {
    "headline": "$4,266",
    "sub": "if R3’s 70% held at 5× size · 90 days",
    "math": "$0.32/trade × 5 × 30/day"
   },
   "note": "“R5 will need to validate $250 at full n=30.”"
  },
  {
   "t0": 21,
   "t1": 30,
   "id": "r4",
   "kind": "round",
   "round": "R4",
   "step": "3 / 7",
   "kill": "FIRED",
   "question": "R4 · 9 of the last 10 trades lose",
   "verdict": {
    "text": "CATASTROPHIC · HARD STOP TRIPPED",
    "tone": "bad"
   },
   "pnl": -29.82,
   "cumFrom": 14.5,
   "cumTo": -18.59,
   "ledger": [
    {
     "k": "trades submitted",
     "v": "21 / 30",
     "ok": false
    },
    {
     "k": "round pnl",
     "v": "−$29.82",
     "ok": false
    },
    {
     "k": "peak → trough",
     "v": "$14.5 → −$33.09",
     "ok": false
    },
    {
     "k": "emergency SIGTERM",
     "v": "EXECUTED",
     "ok": false
    },
    {
     "k": "stop overshoot",
     "v": "−$3.59 in-flight",
     "ok": false
    }
   ],
   "gates": [
    {
     "k": "yes_min_edge",
     "v": 26
    },
    {
     "k": "sigma_max",
     "v": 21
    },
    {
     "k": "backoff",
     "v": 49
    },
    {
     "k": "hard_stop −$15",
     "v": 1,
     "fired": true
    }
   ],
   "chain": [
    {
     "k": "lesson",
     "v": "Never bump Kelly more than 2x in a single step",
     "tone": "bad"
    },
    {
     "k": "lesson",
     "v": "Mid-round bump is methodologically broken — destroys round-as-validation",
     "tone": "bad"
    },
    {
     "k": "lesson",
     "v": "Hard-stop is reactive (settle-time), not predictive; high-Kelly concurrent orders can overshoot",
     "tone": "bad"
    }
   ],
   "note": "“Textbook over-betting.”"
  },
  {
   "t0": 30,
   "t1": 38,
   "id": "r5",
   "kind": "round",
   "round": "R5",
   "step": "4 / 7",
   "kill": "HALTED",
   "question": "R5 · same config as R3. Does 70% come back?",
   "verdict": {
    "text": "REGIME-DEPENDENT OR FLUKE",
    "tone": "bad"
   },
   "pnl": -5.43,
   "cumFrom": -18.59,
   "cumTo": -24.02,
   "winRate": 33,
   "ledger": [
    {
     "k": "record",
     "v": "8W / 16L (33%)",
     "ok": false
    },
    {
     "k": "vs R3",
     "v": "Fisher p ≤ 0.001",
     "ok": false
    },
    {
     "k": "halt",
     "v": "manual SIGTERM at n=25",
     "ok": false
    },
    {
     "k": "balance",
     "v": "$27.23 (−46.9%)",
     "ok": false
    }
   ],
   "gates": [
    {
     "k": "yes_min_edge",
     "v": 53
    },
    {
     "k": "sigma_max",
     "v": 32
    },
    {
     "k": "backoff",
     "v": 0
    },
    {
     "k": "hard_stop −$15",
     "v": 0
    }
   ],
   "hours": [
    {
     "k": "h1",
     "v": "2W/1L (67%)"
    },
    {
     "k": "h2",
     "v": "1W/6L (14%)"
    },
    {
     "k": "h3",
     "v": "5W/5L (50%)"
    },
    {
     "k": "h4_partial",
     "v": "0W/4L (0%)"
    }
   ],
   "note": "“Remaining 5 trades not informative.”"
  },
  {
   "t0": 38,
   "t1": 46,
   "id": "r6",
   "kind": "round",
   "round": "R6",
   "step": "5 / 7",
   "kill": "HALTED",
   "question": "R6 · regime test, back in the R3 window",
   "verdict": {
    "text": "INCONCLUSIVE · Fisher p = 0.37",
    "tone": "warn"
   },
   "pnl": 2.67,
   "cumFrom": -24.02,
   "cumTo": -32.99,
   "winRate": 60,
   "ledger": [
    {
     "k": "record",
     "v": "18W / 12L (60%)",
     "ok": true
    },
    {
     "k": "round pnl",
     "v": "+$2.67",
     "ok": true
    },
    {
     "k": "Brier score",
     "v": "0.247 vs 0.250 climatology",
     "ok": false
    },
    {
     "k": "edge/contract",
     "v": "−4.54¢ · gate needs +2.5¢",
     "ok": false
    },
    {
     "k": "halt",
     "v": "stalled at n=28 · σ explosion",
     "ok": false
    }
   ],
   "gates": [
    {
     "k": "yes_min_edge",
     "v": 87
    },
    {
     "k": "sigma_max",
     "v": 40
    },
    {
     "k": "backoff",
     "v": 0
    },
    {
     "k": "hard_stop −$15",
     "v": 0
    }
   ],
   "chain": [
    {
     "k": "R3 vs R6",
     "v": "p = 0.37 · not distinguishable",
     "tone": "warn"
    },
    {
     "k": "R5 vs R6",
     "v": "p = 0.06",
     "tone": "dim"
    },
    {
     "k": "conclusion",
     "v": "R3 was a ∼2× variance peak",
     "tone": "bad"
    }
   ],
   "note": "balance $18.26 · −64.4% from start"
  },
  {
   "t0": 46,
   "t1": 52,
   "id": "r7",
   "kind": "round",
   "round": "R7",
   "step": "6 / 7",
   "kill": "HALTED",
   "question": "R7 · micro-canary, re-funded to $74.59",
   "verdict": {
    "text": "HALTED · 2-LOSS STOP",
    "tone": "bad"
   },
   "pnl": -1.06,
   "cumFrom": -32.99,
   "cumTo": -34.05,
   "ledger": [
    {
     "k": "trades",
     "v": "2 · both XRP NO @ $0.53",
     "ok": false
    },
    {
     "k": "record",
     "v": "0W / 2L",
     "ok": false
    },
    {
     "k": "pnl",
     "v": "−$1.06",
     "ok": false
    },
    {
     "k": "stop logic",
     "v": "WORKED · halted on rule",
     "ok": true
    },
    {
     "k": "balance",
     "v": "$74.59 → $72.98",
     "ok": false
    }
   ],
   "note": "“Insufficient n for strategy conclusion.”"
  },
  {
   "t0": 52,
   "t1": 60,
   "id": "shadow",
   "kind": "title",
   "round": "—",
   "step": "7 / 7",
   "kill": "SAFE",
   "question": "Live trading paused. Shadow mode.",
   "bankrollAt": -34.05,
   "lines": [
    "R3 WAS LUCK, NOT EDGE — FISHER p = 0.37",
    "MAKER DRY-RUN: 0 ORDERS ON THE WIRE",
    "HOLDOUT COLLECTOR: 9.53h OF 30h · NOT ELIGIBLE",
    "5% SKILL GATE · BEST LAYER-1: 0.93% · FAILED"
   ]
  }
 ]
};
