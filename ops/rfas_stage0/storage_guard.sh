#!/usr/bin/env bash
# Review candidate, invoked as dedicated service user. No mounts or writes.
set -euo pipefail
[[ $# -ge 7 ]] || exit 2
mount=$1; uuid=$2; repo=$3; app=$4; log=$5; key=$6; min_gib=$7
shift 7
fail(){ printf 'RFAS preflight blocked: %s\n' "$1" >&2; exit 1; }

[[ $(hostname -s) == ok-computer ]] || fail wrong-host
[[ -f /etc/brti-edge/collector-cutover-approved && ! -L /etc/brti-edge/collector-cutover-approved ]] || fail missing-approval
[[ $(stat -c '%u:%a' /etc/brti-edge/collector-cutover-approved) == 0:600 ]] || fail invalid-approval

mountpoint -q -- "$mount" || fail not-mounted
[[ $(findmnt -n -M "$mount" -o UUID) == "$uuid" ]] || fail uuid-mismatch
raw_source=$(findmnt -n -M "$mount" -o SOURCE)
# Strip optional btrfs/subvolume bracket suffix (e.g. /dev/nvme0n1p2[/@brti]).
source="${raw_source%%\[*}"
[[ $source == /dev/* ]] || fail nonlocal-device

# Reject known quarantined physical model even if passed as approved UUID.
# Fail on unresolved device ancestry. Operator must separately attest SMART.
ancestry=$(lsblk -s -n -o MODEL,TYPE -- "$source") || fail unresolved-device
[[ -n $ancestry ]] || fail unresolved-device
[[ $ancestry != *MQ04UBD200* ]] || fail quarantined-toshiba

for target in "$repo" "$app" "$log" "$app/ops/state"; do
  [[ -d $target && -w $target ]] || fail missing-or-unwritable-directory
  [[ $(realpath -e -- "$target") == "$target" ]] || fail symlink-or-noncanonical-path
  [[ $(findmnt -n -T "$target" -o TARGET) == "$mount" ]] || fail unexpected-filesystem
  [[ $(findmnt -n -T "$target" -o UUID) == "$uuid" ]] || fail unexpected-uuid
done

# Guard append-redirected log targets against symlink clobbering or wrong ownership.
svc_uid=$(id -u)
check_append_log() {
  local p=$1
  local parent
  parent=$(dirname -- "$p")
  [[ -d $parent && ! -L $parent ]] || fail invalid-log-parent
  [[ $(realpath -e -- "$parent") == "$parent" ]] || fail symlink-log-parent
  if [[ -e $p || -L $p ]]; then
    [[ -f $p && ! -L $p ]] || fail unsafe-log-target
    [[ $(stat -c '%u' -- "$p") == "$svc_uid" ]] || fail log-owner-mismatch
  fi
}

shopt -s nullglob
for dir in "$log" "$app/ops/state" "$app/logs"; do
  for f in "$dir"/launchd-*.log; do
    check_append_log "$f"
  done
done
shopt -u nullglob
for extra_log in "$@"; do
  check_append_log "$extra_log"
done

# Guard against launchers reading their own .env after systemd environment.
# Permit explicit '=0' disarm settings; reject routing/grace/live-env overrides
# or any non-zero/dynamic order gate value.
for f in "$repo/.env" "$app/.env"; do
  [[ -e $f ]] || continue
  [[ -r $f ]] || fail unreadable-dotenv
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?(DATA_COLLECTOR_LOG_DIR|PM_COLLECTOR_LOG_DIR|COLLECTOR_GRACE_SECONDS|PM_COLLECTOR_GRACE_SECONDS|WORKER_GRACE_SECONDS|KALSHI_LIVE_TRADING_ENV)=' "$f"; then
    fail conflicting-dotenv-routing-or-grace
  fi
  zero_re="^[\"']?0[\"']?([[:space:]]*(#.*)?)?$"
  while IFS= read -r raw_line || [[ -n $raw_line ]]; do
    line=${raw_line%$'\r'}
    if [[ $line =~ ^[[:space:]]*(export[[:space:]]+)?(KALSHI_ALLOW_ORDERS|KALSHI_AUTO_SUBMIT|KALSHI_DUST_ENABLED)=(.*)$ ]]; then
      val=${BASH_REMATCH[3]}
      if ! [[ $val =~ $zero_re ]]; then
        fail unsafe-dotenv-order-gate
      fi
    fi
  done < "$f"
done

if [[ $key != NONE ]]; then
  [[ ${!key-} == "$log" ]] || fail conflicting-systemd-env
fi
[[ -z ${KALSHI_LIVE_TRADING_ENV:-} ]] || fail cross-repo-env
for k in KALSHI_ALLOW_ORDERS KALSHI_AUTO_SUBMIT KALSHI_DUST_ENABLED; do
  [[ ${!k-} == 0 ]] || fail order-gate-not-zero
done

avail=$(df -B1 --output=avail "$mount" | tail -1 | tr -d ' ')
[[ $avail =~ ^[0-9]+$ ]] || fail free-space-unknown
(( avail >= min_gib * 1024 * 1024 * 1024 )) || fail insufficient-free-space
# This is only a start-time check; no claim of continuous storage/clock health.
