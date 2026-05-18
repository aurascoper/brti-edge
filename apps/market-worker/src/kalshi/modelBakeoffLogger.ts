// Layer-2 shadow bakeoff logger.
//
// Records, for every market evaluation, the Gaussian/BRTI baseline prediction
// PLUS new candidate-feature scalars (spot-perp basis is the first one) so we
// can fit prospective models that have NOT seen settlement labels at decision
// time. Joined with kalshi-settlement-validation.jsonl by ticker after close.
//
// Schema v1 — intentionally flat / scalar-only / forward-extensible. New
// features (OFI levels, order-book depth, etc.) get added as new optional
// fields in v2+ without breaking the analysis script.
//
// This logger does NOT take any action on the market. It runs unconditionally
// whenever a candidate is scored, regardless of KALSHI_DUST_ENABLED state, so
// shadow-mode runs produce clean prospective data without dust mutations.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const MODEL_BAKEOFF_SCHEMA_VERSION = 1;

export interface ModelBakeoffRow {
  schema_version: number;
  ts: string;
  ticker: string;
  series: string;
  asset: string;            // "BTC", "ETH", ... (BRTI-style underlying)
  strike: number;
  close_time: string;
  secs_to_close: number | null;

  // Baseline model (Gaussian/BRTI fair_yes) + side-decision context
  side_gaussian: string;    // YES / NO / SKIP
  p_gaussian: number | null;
  edge_gaussian: number | null;
  // Book quotes captured at decision time
  best_yes_bid: number | null;
  best_yes_ask: number | null;
  best_no_bid: number | null;
  best_no_ask: number | null;

  // Spot + sigma inputs (already in shadow log, but re-included so this file
  // is self-contained for the bakeoff script — single-table join with settlement)
  spot: number | null;
  spot_source: string | null;
  sigma_annual: number | null;
  sigma_source: string | null;

  // === Feature #1: spot-perp basis ===
  perp_mark: number | null;
  perp_index: number | null;
  perp_age_ms: number | null;
  basis_mid: number | null;
  basis_bps: number | null;
  funding_rate: number | null;

  // Eventual settlement is joined out-of-band via ticker → result mapping
  // from kalshi-settlement-validation.jsonl.  We do NOT write it here.
}

export interface ModelBakeoffLoggerOpts {
  outputPath: string;
}

export class ModelBakeoffLogger {
  private readonly outputPath: string;
  private dirReady = false;

  constructor(opts: ModelBakeoffLoggerOpts) {
    this.outputPath = opts.outputPath;
  }

  log(row: Omit<ModelBakeoffRow, "schema_version">): void {
    try {
      if (!this.dirReady) {
        if (!existsSync(dirname(this.outputPath))) {
          mkdirSync(dirname(this.outputPath), { recursive: true });
        }
        this.dirReady = true;
      }
      const full: ModelBakeoffRow = {
        schema_version: MODEL_BAKEOFF_SCHEMA_VERSION,
        ...row,
      };
      appendFileSync(this.outputPath, JSON.stringify(full) + "\n");
    } catch (err) {
      // Logger MUST never throw back into the scan loop.
      console.warn(`[model-bakeoff-logger] append failed:`, err);
    }
  }
}
