---
description: Checkout load test against the live server, with per-container CPU
argument-hint: "<label> \"<rates per second>\" [duration]"
---

Load-test checkout on the live server: $ARGUMENTS

**Ask before anything touches the live box.** This creates payment links in
the live database over ssh and sends real HTTPS traffic to the public URL.
State the label, rates and duration, and wait for a clear yes.

Then run:

```bash
perf/checkout/run-live.sh <label> "<rates>" [duration]
```

- k6 runs locally in Docker; links and the invariant checks run in the
  server's database over ssh. `perf/checkout/cgroup-cpu.sh` is piped to the
  server for each step and reads each container's CPU, throttling and peak
  memory from the kernel's cgroup counters (`docker stats` misses a
  throttled container).
- Host, user, key and URL come from `DEPLOY_HOST` / `DEPLOY_USER` /
  `DEPLOY_KEY` / `PUBLIC_URL` or the script's defaults. Never print or read
  the key or the server's `ops/.env`.
- Results go to `perf/checkout/results-<label>.jsonl`; chart them with
  `node perf/checkout/chart-live.mjs`.

Report per rate: achieved rate, p95 latency, error rate, and CPU/throttling
for api, postgres and proxy. Then the invariants output: any row there means
money is wrong, which matters more than latency. For local runs, use
`perf/checkout/run.sh` instead (no ssh).
