#!/usr/bin/env bash
# Read-only diagnostics; redact private network details before sharing externally.
set -u

mode=${1:-text}

if [[ $mode == "--json" ]]; then
  host_name=$(hostname -s 2>/dev/null || echo unknown)
  ntp_sync=$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo unknown)
  root_uuid=$(findmnt -n -M / -o UUID 2>/dev/null || echo "")
  root_avail=$(df -B1 --output=avail / 2>/dev/null | tail -1 | tr -d ' ' || echo "0")
  node_ver=$(node --version 2>/dev/null || echo "")
  pnpm_ver=$(pnpm --version 2>/dev/null || echo "")
  if [[ -f /etc/brti-edge/collector-cutover-approved && ! -L /etc/brti-edge/collector-cutover-approved ]]; then
    marker_present=true
  else
    marker_present=false
  fi

  quarantined_present=false
  quarantined_mounted=false
  lsblk_out=$(lsblk -r -n -o NAME,MODEL,MOUNTPOINT 2>/dev/null || true)
  if [[ -n $lsblk_out ]]; then
    while IFS= read -r row; do
      if [[ $row == *MQ04UBD200* ]]; then
        quarantined_present=true
        # Third space-delimited field non-empty indicates active mountpoint.
        mp=${row#* }
        mp=${mp#* }
        if [[ -n $mp ]]; then
          quarantined_mounted=true
        fi
      fi
    done <<< "$lsblk_out"
  fi

  non_root_mounts=()
  while IFS= read -r line; do
    [[ -n $line ]] || continue
    tgt=${line%% *}
    src=${line#* }
    if [[ $tgt != "/" && $tgt != "/boot"* && $tgt != "/snap"* && $src == /dev/* ]]; then
      non_root_mounts+=("$tgt")
    fi
  done < <(findmnt -r -n -o TARGET,SOURCE 2>/dev/null || true)

  export RFAS_HOST="$host_name"
  export RFAS_NTP="$ntp_sync"
  export RFAS_ROOT_UUID="$root_uuid"
  export RFAS_ROOT_AVAIL="$root_avail"
  export RFAS_NODE="$node_ver"
  export RFAS_PNPM="$pnpm_ver"
  export RFAS_MARKER="$marker_present"
  export RFAS_Q_PRESENT="$quarantined_present"
  export RFAS_Q_MOUNTED="$quarantined_mounted"
  export RFAS_DEDICATED_MOUNTS="${non_root_mounts[*]:-}"

  python3 - <<'PY'
import json
import os

dedicated = [m for m in os.environ.get("RFAS_DEDICATED_MOUNTS", "").split() if m]
avail_raw = os.environ.get("RFAS_ROOT_AVAIL", "0")
avail_bytes = int(avail_raw) if avail_raw.isdigit() else 0
ntp_ok = os.environ.get("RFAS_NTP", "").strip().lower() == "yes"
pnpm_ok = bool(os.environ.get("RFAS_PNPM", "").strip())
marker_ok = os.environ.get("RFAS_MARKER") == "true"
q_mounted = os.environ.get("RFAS_Q_MOUNTED") == "true"

verdict = (
    "CUTOVER_MARKER_AND_PREREQS_PRESENT"
    if (dedicated and ntp_ok and pnpm_ok and marker_ok and not q_mounted)
    else "EVIDENCE_ONLY_NOT_CUTOVER_READY"
)

payload = {
    "schema": "rfas-stage0-readiness-v1",
    "hostname": os.environ.get("RFAS_HOST", "unknown"),
    "ntp_synchronized": ntp_ok,
    "root_mount_uuid": os.environ.get("RFAS_ROOT_UUID", ""),
    "root_avail_bytes": avail_bytes,
    "dedicated_non_root_mounts": dedicated,
    "quarantined_mq04ubd200_present": os.environ.get("RFAS_Q_PRESENT") == "true",
    "quarantined_mq04ubd200_mounted": q_mounted,
    "node_version": os.environ.get("RFAS_NODE", ""),
    "pnpm_present": pnpm_ok,
    "pnpm_version": os.environ.get("RFAS_PNPM", ""),
    "stage0_cutover_approved_marker": marker_ok,
    "readiness_verdict": verdict,
    "evidence_only_note": "Do not interpret command completion as G4 authorization.",
}
print(json.dumps(payload, indent=2, sort_keys=True))
PY
  exit 0
fi

printf '\n== identity / capacity ==\n'
hostnamectl; lscpu; free -h; df -hT
printf '\n== block devices and mounts ==\n'
lsblk -o NAME,SIZE,MODEL,FSTYPE,UUID,MOUNTPOINTS
findmnt -o TARGET,SOURCE,FSTYPE
printf '\n== time and LAN ==\n'
timedatectl; ip -br addr
printf '\n== relevant services ==\n'
systemctl list-units --type=service --all | grep -Ei 'brti|kalshi|polymarket' || true
printf '\n== runtime versions ==\n'
node --version; pnpm --version
printf '\nEvidence only. Do not interpret command completion as readiness PASS.\n'
