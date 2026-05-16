# Playing the Odds: Agentic LLMs for Real-Time NBA Forecasting and Market Betting

**Authors**: E. Jeon, Minseong Sim, Woohyun Kim
**Venue**: Journal of Youth Impact, 2026
**Open access**: NO (paywalled — full text not available via paper-mcp)
**Semantic Scholar ID**: 89389cf003b1c112f3490b2a4f8e64d0141f7d58

## Abstract (only source we have)

> Predicting the outcomes of professional basketball games is a challenging problem due to the intrinsic stochastic uncertainty of sports competitions and the heterogeneity of relevant information sources. While existing approaches in sports analytics primarily rely on structured historical statistics, such methods often struggle to incorporate timely and unstructured information. In this paper, we propose a unified framework that leverages large language models for probabilistic forecasting and decision making for NBA games and their prediction markets. Our approach combines specialized information retrieval agents with multiple role-based LLM predictors, whose forecasts are aggregated into the final forecasting probabilities. These probabilities are then operationalized through a fractional Kelly betting strategy in binary prediction markets. We evaluate the proposed system using both Brier Scores and simulated market returns, demonstrating that LLM-based forecasting can effectively complement traditional models and translate predictive improvements into economic values.

## What we can extract

Architecture (from abstract):
1. **Information retrieval agents** — pull structured stats + unstructured news/social
2. **Multiple role-based LLM predictors** — distinct personas (likely: stats analyst, injury tracker, matchup historian, momentum reader). Similar to PolySwarm but smaller scale, NBA-specific.
3. **Aggregation** — combine forecasts to final probability (method unspecified in abstract; likely confidence-weighted or simple average)
4. **Fractional Kelly betting** — same risk-controlled sizing as PolySwarm uses
5. **Binary Polymarket markets** — explicit target

Evaluation: Brier Scores + simulated returns. Translation of forecast skill into economic value (i.e., money) — not just calibration metrics.

## Why this paper matters less than PolySwarm

- Closed-source, paywalled
- Smaller scale (architecture not specified in detail)
- NBA-only
- No open-access PDF means we can't extract implementation specifics

## Why it still matters for us

Validates the **PolySwarm pattern works in sports specifically** when adapted with domain-aware information retrieval. NBA markets are:

- High-volume on Polymarket during playoffs
- Have rich structured data (box scores, injury reports, advanced stats)
- Have rich unstructured signal (news, beat-writer reporting, social)
- Have known volatility patterns (back-to-backs, travel, rest days)
- Hard for purely-quantitative models

If we ever build an LLM-swarm subsystem, NBA is a reasonable first non-BTC market because the information surface area is well-defined.

## Action items (if any)

Not actionable until we've built the LLM-swarm scaffolding (PolySwarm steps 1-5). When we get there:
- Use this paper's pattern as the template for the NBA-specific persona pool
- Personas: stats analyst, injury/availability tracker, matchup historian, momentum reader, schedule/rest analyst
- Information retrieval: ESPN box scores, Twitter/X game-day reports, beat-writer accounts, basketball-reference advanced stats
