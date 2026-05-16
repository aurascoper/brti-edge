# Kalshi orderbook semantics (verified 2026-05-14)

## Source format

`GET /markets/{ticker}/orderbook` returns:

```json
{
  "orderbook_fp": {
    "yes_dollars": [["0.0010", "1502.00"], ["0.0020", "1326.00"], ...],
    "no_dollars":  [["0.0010", "1502.00"], ["0.0020", "1326.00"], ...]
  }
}
```

Each entry is `[price_dollars_string, size_string]`. Prices are 4-decimal dollar values; size is contract count.

## Critical interpretation rules

1. **Arrays contain BIDS ONLY** — there are no explicit asks in the response
2. **Sort order is ASCENDING by price** — the highest price (best bid) is at the **last** index, not the first
3. **No-arb relationship across sides**: buying YES at $P is equivalent to selling NO at $(1−P). Therefore:
   - `best_yes_ask = 1 − best_no_bid`
   - `best_no_ask = 1 − best_yes_bid`
4. The two sides may have very different depths. A market deep in-the-money for one outcome will have a long bid stack on the favored side and a short one on the other.

## Worked example

Market `KXBTC15M-26MAY142200-00` (strike $81,383.72, ~15min to settlement, BTC at ~$80.5k):

```
yes_dollars (8 levels): [..., [0.0080, 22], [0.0110, 100]]
no_dollars (192 levels): [..., [0.9870, 1731], [0.9880, 390]]
```

Derivation:

```
best_yes_bid = 0.0110         (max yes_dollars)
best_no_bid  = 0.9880         (max no_dollars)
best_yes_ask = 1 - 0.9880 = 0.0120
best_no_ask  = 1 - 0.0110 = 0.9890
mid_yes      = (0.0110 + 0.0120) / 2 = 0.0115
spread       = 0.0120 - 0.0110 = 0.0010
bids_sum     = 0.0110 + 0.9880 = 0.9990    (sanity: ≤ 1, ✓ no-arb)
asks_sum     = 0.0120 + 0.9890 = 1.0010    (sanity: ≥ 1, ✓ no-arb)
```

## Degenerate state handling

When one side has zero bids (deep in/out of the money near settlement):

```
yes_dollars: []
no_dollars:  [..., [0.9990, 5000]]
```

```
best_yes_bid = null
best_no_bid  = 0.9990
best_yes_ask = 1 - 0.9990 = 0.0010      (derivable)
best_no_ask  = null                      (no yes_bid to derive from)
mid_yes      = null                      (both ends needed)
spread       = null
```

Code must handle null on every field except via no-arb derivation. Don't compute mid when either side is empty.

## Contract semantics for KXBTC15M

Each market in the `KXBTC15M` series is a **strike-based digital**, NOT a "BTC up from window-start" market:

- `floor_strike` is the threshold price
- `strike_type = "greater_or_equal"` means YES resolves if BTC ≥ floor_strike at close
- New 15-minute windows open continuously; the strike is set when the market is created (close to the spot at open time)
- Multiple strike rows per close time are possible (suffix `-00`, `-15`, etc. distinguish them) — though in practice we usually see just one near-the-money strike per cadence

## fairValueArb formula port (vs Polymarket)

Polymarket's `btc-updown-5m` had no strike — YES was "BTC up from S_ref at window start", so:
```
fair_YES = Φ(ln(S_t / S_ref) / (σ √Δt))
```

Kalshi's `KXBTC15M` has an explicit strike, so:
```
fair_YES = Φ(ln(S_t / K) / (σ √Δt))
```

Same formula shape, K (strike) replaces S_ref. Strategy logic stays. The σ√Δt at 15m is √3× the 5m equivalent, giving the model √3× more variance to disagree with the book — bigger edge surface.

## Implementation: `parseOrderbook()` in `packages/kalshi-client/src/client.ts`

The function reverses the source arrays so consumers see top-of-book at index 0 (descending price), and computes top-of-book + derived asks + mid + spread eagerly. The `VenueOrderbook` type at `@polyterminal/types/venue.ts` formalizes this shape.
