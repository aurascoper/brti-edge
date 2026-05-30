#!/usr/bin/env bash
# =============================================================================
# v2 PROMOTION GATE (Stage A) — mechanical GO / NO-GO against §13
# =============================================================================
# Turns "did v2 pass the holdout?" into a single exit code by cross-referencing
# every artifact the §13 gates require. A single btcMakerV2 report CANNOT
# self-certify: it defers Gate 1 (eligibility), Gate 4 (Capped), Gate 7
# (front/back queue) and Gate 9 (commit) to external checks. This script runs
# those checks and refuses to emit GO unless ALL nine gates are affirmatively ✓.
#
# Hard rule: any gate that is FAIL, ABSENT, or UNVERIFIED ⇒ NO-GO. Nothing
# default-passes — that is exactly how the 2026-05-30 void run would have
# slipped through (it FAILED on ineligible data; an absent gate must be treated
# the same as a failed one).
#
# GO here means only that v2 cleared §13 on a clean holdout. It does NOT
# authorize live trading — that is Stage B (a separate R7 live preregistration
# the v2 prereg explicitly leaves CLOSED).
#
# Usage:
#   bash scripts/promotion-gate-check.sh \
#     --primary=<conservative holdout report.md> \
#     --capped=<btcMakerV2Capped report.md> \
#     --front=<--queue=front report.md> \
#     --back=<--queue=back report.md> \
#     --since=2026-06-02T00:00:00Z --until=2026-06-12T00:00:00Z \
#     [--policy-commit=1a5d741] [--catastrophic=-0.01]
# =============================================================================
set -uo pipefail
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PRIMARY="" CAPPED="" FRONT="" BACK="" SINCE="" UNTIL=""
POLICY_COMMIT="1a5d741"          # btcMakerV2.ts implementation commit (Gate 9)
CATASTROPHIC="-0.01"             # $/posted floor (prereg §catastrophic)
POLICY_FILES="apps/data-collector/src/replay/btcMakerV2.ts apps/data-collector/src/replay/btcMakerV2Capped.ts"

for a in "$@"; do
  case "$a" in
    --primary=*)      PRIMARY="${a#*=}" ;;
    --capped=*)       CAPPED="${a#*=}" ;;
    --front=*)        FRONT="${a#*=}" ;;
    --back=*)         BACK="${a#*=}" ;;
    --since=*)        SINCE="${a#*=}" ;;
    --until=*)        UNTIL="${a#*=}" ;;
    --policy-commit=*) POLICY_COMMIT="${a#*=}" ;;
    --catastrophic=*) CATASTROPHIC="${a#*=}" ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

if [ -z "$PRIMARY" ] || [ ! -f "$PRIMARY" ]; then
  echo "ERROR: --primary=<holdout report.md> is required and must exist" >&2
  exit 2
fi

NOGO=0
declare_reasons=""   # newline-joined "Gate N — why"
row() { printf "  %-9s %-11s %s\n" "$1" "$2" "$3"; }
flag() { NOGO=1; declare_reasons="${declare_reasons}\n  - $1"; }

# Parse a "Gate N..." line's ✓/✗ from a report. echoes PASS|FAIL|DEFERRED|ABSENT
gate_mark() {
  local f="$1" pat="$2" line
  [ -f "$f" ] || { echo ABSENT; return; }
  line="$(grep -E "^$pat" "$f" 2>/dev/null | head -1)"
  [ -z "$line" ] && { echo ABSENT; return; }
  case "$line" in
    *✗*) echo FAIL ;;
    *✓*) echo PASS ;;
    *)   echo DEFERRED ;;
  esac
}

# Extract "settlement EV per posted" dollar value from a report. echoes number or "".
ev_posted() {
  local f="$1"
  [ -f "$f" ] || { echo ""; return; }
  grep 'settlement EV per posted' "$f" 2>/dev/null | head -1 \
    | grep -oE '\$-?[0-9]+\.[0-9]+' | head -1 | tr -d '$'
}

# numeric a > b ?  (floats)
gt() { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a>b)}'; }

echo "=============================================================="
echo " v2 PROMOTION GATE (Stage A) — §13 GO / NO-GO"
echo "=============================================================="
echo " primary : $PRIMARY"
echo " capped  : ${CAPPED:-<not provided>}"
echo " front   : ${FRONT:-<not provided>}    back: ${BACK:-<not provided>}"
echo " window  : ${SINCE:-?} → ${UNTIL:-?}"
echo "--------------------------------------------------------------"

# ---- preflight: the primary report must be a real HOLDOUT run ----------------
if grep -qi 'IMPLEMENTATION SANITY CHECK' "$PRIMARY"; then
  row "preflight" "NO-GO" "primary is a SANITY-CHECK run — gates not computed"
  flag "preflight — primary report is non-holdout (sanity-check); §13 not scored"
elif grep -qi 'HOLDOUT VALIDATION RUN' "$PRIMARY"; then
  row "preflight" "ok" "primary is a HOLDOUT validation run"
else
  row "preflight" "NO-GO" "cannot confirm primary is a holdout run"
  flag "preflight — primary report missing the HOLDOUT VALIDATION banner"
fi

echo "  ---- §13 gates ----"

# ---- Gate 1: holdout eligibility (EXTERNAL via adequacy/readiness) -----------
if [ -n "$SINCE" ] && [ -n "$UNTIL" ] && [ -x "$SCRIPT_DIR/collector-readiness-check.sh" ]; then
  if bash "$SCRIPT_DIR/collector-readiness-check.sh" "$SINCE" "$UNTIL" >/tmp/_gate1.out 2>&1; then
    row "Gate 1" "PASS" "continuous_holdout_eligible=true ($SINCE→$UNTIL)"
  else
    row "Gate 1" "FAIL" "holdout window NOT eligible (see /tmp/_gate1.out)"
    flag "Gate 1 — holdout window is not continuity-eligible (a pass on it is VOID)"
  fi
else
  row "Gate 1" "UNVERIFIED" "pass --since/--until to run the eligibility check"
  flag "Gate 1 — eligibility not checked (no window given)"
fi

# ---- Gate 2: sample size (primary report) -----------------------------------
g2="$(gate_mark "$PRIMARY" 'Gate 2 ')"
row "Gate 2" "$g2" "sample size: posted≥500 filled≥200 distinct≥20"
[ "$g2" = "PASS" ] || flag "Gate 2 — sample size ($g2)"

# ---- Gate 3: settlement EV (3a EV/posted>0, 3b EV/filled>1¢) -----------------
g3a="$(gate_mark "$PRIMARY" 'Gate 3a ')"; g3b="$(gate_mark "$PRIMARY" 'Gate 3b ')"
if [ "$g3a" = "PASS" ] && [ "$g3b" = "PASS" ]; then
  row "Gate 3" "PASS" "EV/posted>0 and EV/filled>+1¢"
else
  row "Gate 3" "FAIL" "3a=$g3a 3b=$g3b"
  flag "Gate 3 — settlement EV (3a=$g3a, 3b=$g3b)"
fi

# ---- Gate 4: drawdown ≤ $5 / 20% (CAPPED report) ----------------------------
g4="$(gate_mark "$CAPPED" 'Gate 4 ')"
row "Gate 4" "$g4" "drawdown ≤ \$5 / 20% (from btcMakerV2Capped)"
[ "$g4" = "PASS" ] || flag "Gate 4 — drawdown ($g4; provide --capped=<Capped report>)"

# ---- Gate 5: concentration (5a/5b/5c, primary report) -----------------------
g5a="$(gate_mark "$PRIMARY" 'Gate 5a ')"; g5b="$(gate_mark "$PRIMARY" 'Gate 5b ')"; g5c="$(gate_mark "$PRIMARY" 'Gate 5c ')"
if [ "$g5a" = "PASS" ] && [ "$g5b" = "PASS" ] && [ "$g5c" = "PASS" ]; then
  row "Gate 5" "PASS" "top-1 market≤25%, 2h≤40%, hour≤40%"
else
  row "Gate 5" "FAIL" "5a=$g5a 5b=$g5b 5c=$g5c"
  flag "Gate 5 — concentration (5a=$g5a 5b=$g5b 5c=$g5c)"
fi

# ---- Gate 6: one-sided justification (primary; structural ✓, AD-3 assumed) ---
g6="$(gate_mark "$PRIMARY" 'Gate 6 ')"
if [ "$g6" = "PASS" ]; then
  row "Gate 6" "PASS*" "one-sided branch (structural; verify AD-3 honored)"
else
  row "Gate 6" "$g6" "one-sided justification"
  flag "Gate 6 — one-sided justification ($g6)"
fi

# ---- Gate 7: queue robustness (front AND back present; back not catastrophic) -
if [ -n "$FRONT" ] && [ -f "$FRONT" ] && [ -n "$BACK" ] && [ -f "$BACK" ]; then
  evb="$(ev_posted "$BACK")"
  if [ -n "$evb" ] && gt "$evb" "$CATASTROPHIC"; then
    row "Gate 7" "PASS" "front+back present; back EV/posted=\$$evb > \$$CATASTROPHIC"
  else
    row "Gate 7" "FAIL" "back-of-queue EV/posted=\$${evb:-?} ≤ catastrophic \$$CATASTROPHIC"
    flag "Gate 7 — queue robustness: back-of-queue is catastrophic (EV/posted=\$${evb:-?})"
  fi
else
  row "Gate 7" "UNVERIFIED" "need both --front and --back queue reports"
  flag "Gate 7 — queue robustness (front/back reports not provided)"
fi

# ---- Gate 8: no ghost fills (primary report) --------------------------------
g8="$(gate_mark "$PRIMARY" 'Gate 8 ')"
row "Gate 8" "$g8" "no ghost fills"
[ "$g8" = "PASS" ] || flag "Gate 8 — ghost fills ($g8)"

# ---- Gate 9: no post-hoc tuning (policy code frozen since lock) — git --------
if command -v git >/dev/null 2>&1 && git -C "$APP_DIR" rev-parse >/dev/null 2>&1; then
  if git -C "$(git -C "$APP_DIR" rev-parse --show-toplevel)" diff --quiet "$POLICY_COMMIT" HEAD -- $POLICY_FILES 2>/dev/null; then
    row "Gate 9" "PASS" "policy files unchanged since $POLICY_COMMIT"
  else
    row "Gate 9" "FAIL" "btcMakerV2*.ts changed since $POLICY_COMMIT (post-hoc tuning)"
    flag "Gate 9 — policy code changed since the locked commit $POLICY_COMMIT"
  fi
else
  row "Gate 9" "UNVERIFIED" "not a git repo / git unavailable"
  flag "Gate 9 — commit-freeze not verified"
fi

# ---- catastrophic check on the PRIMARY (conservative) scenario too ----------
evp="$(ev_posted "$PRIMARY")"
if [ -n "$evp" ] && ! gt "$evp" "$CATASTROPHIC"; then
  row "catastrophe" "NO-GO" "primary EV/posted=\$$evp ≤ \$$CATASTROPHIC"
  flag "catastrophic — primary EV/posted=\$$evp breaches \$$CATASTROPHIC"
fi

echo "--------------------------------------------------------------"
if [ "$NOGO" -eq 0 ]; then
  echo " VERDICT: ✅ GO — all §13 gates affirmatively passed."
  echo "          (Stage A only. This does NOT authorize live trading;"
  echo "           Stage B / R7 live preregistration is still required.)"
  echo "=============================================================="
  exit 0
else
  echo " VERDICT: ⛔ NO-GO"
  printf "%b\n" "$declare_reasons"
  echo "=============================================================="
  exit 1
fi
