# Runs ON the server (piped over ssh by run-live.sh): `bash -s snap` saves each
# container's cgroup CPU counters; `bash -s diff` prints, as JSON fields, the
# share of a core each used since the snapshot, how often the kernel throttled
# it at its CPU limit, and its peak memory since it started.
set -euo pipefail
C="api postgres proxy"
stat() { echo /sys/fs/cgroup/system.slice/docker-$(docker inspect -f '{{.Id}}' filspay-$1-1).scope/$2; }
case $1 in
  snap) for c in $C; do { date +%s.%N; cat "$(stat $c cpu.stat)"; } > /tmp/filspay-cpu0.$c; done ;;
  diff)
    out=""
    for c in $C; do
      now=$(date +%s.%N)
      out+=$(awk -v c=$c -v now=$now -v mem=$(cat "$(stat $c memory.peak)") '
        NR==FNR { if (FNR==1) t0=$1; else a[$1]=$2; next } { b[$1]=$2 }
        END { s = now - t0; p = b["nr_periods"] - a["nr_periods"]
          printf "\"%s_cpu_pct\":%.1f,\"%s_throttled_pct\":%.0f,\"%s_mem_peak_mib\":%.0f,",
            c, (b["usage_usec"] - a["usage_usec"]) / (s * 1e4),
            c, p ? 100 * (b["nr_throttled"] - a["nr_throttled"]) / p : 0, c, mem / 1048576 }' \
        /tmp/filspay-cpu0.$c "$(stat $c cpu.stat)")
    done
    echo "${out%,}" ;;
esac
