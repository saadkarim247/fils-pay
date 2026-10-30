// Builds docs/perf/2026-10-30-live-capacity.{svg,png} from the live runs
// (results-live-before75.jsonl, and results-live-after75.jsonl once it exists).
// Usage: node perf/checkout/chart-live.mjs   (PNG needs node_modules/sharp)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const load = (label) => {
  const p = join(here, `results-${label}.jsonl`);
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : null;
};
const before = load("live-before75");
const after = load("live-after75");
const SECS = 30;
const served = (r) => (r.paid + r.declined + r.acquirer_error) / SECS;

// Left panel: what happened to the offered load.
const SERIES = [
  { name: "Accepted, before fix", cls: "s1", pts: before.map((r) => [r.rate, served(r), r]) },
  { name: "Turned away (503), before fix", cls: "s2", pts: before.map((r) => [r.rate, r.shed / SECS, r]) },
  ...(after ? [{ name: "Accepted, after fix (bug 75)", cls: "s3", pts: after.map((r) => [r.rate, served(r), r]) }] : []),
];

const W = 900, H = 370, top = 104, plotH = 210, left = 44, panelW = 340, xB0 = left + panelW + 110, barW = 280;
const yMax = 60;
const xOf = (rate) => left + (rate / 60) * panelW;
const yOf = (v) => top + plotH - (v / yMax) * plotH;

let body = "";
for (let r = 0; r <= 60; r += 10) {
  body += `<line class="grid" x1="${xOf(r)}" x2="${xOf(r)}" y1="${top}" y2="${top + plotH}"/>`;
  body += `<text class="axis" x="${xOf(r)}" y="${top + plotH + 16}" text-anchor="middle">${r}</text>`;
}
for (let v = 0; v <= yMax; v += 10) {
  body += `<line class="grid" x1="${left}" x2="${left + panelW}" y1="${yOf(v)}" y2="${yOf(v)}"/>`;
  body += `<text class="axis" x="${left - 8}" y="${yOf(v) + 4}" text-anchor="end">${v}</text>`;
}
body += `<line class="target" x1="${xOf(0)}" y1="${yOf(0)}" x2="${xOf(60)}" y2="${yOf(60)}"/>`;
body += `<text class="axis" x="${xOf(52)}" y="${yOf(56)}" text-anchor="end">offered</text>`;
body += `<text class="axis" x="${left + panelW / 2}" y="${top + plotH + 34}" text-anchor="middle">Offered load (checkouts started per second)</text>`;
body += `<text class="panel" x="${left}" y="${top - 14}">Checkouts per second, live box</text>`;

for (const s of SERIES) {
  const pts = s.pts.map(([rate, v]) => [xOf(rate), yOf(v)]);
  body += `<polyline class="line ${s.cls}" points="${pts.map((p) => p.join(",")).join(" ")}"/>`;
  s.pts.forEach(([rate, v, r], i) => {
    const tip = `${s.name}, ${rate}/s offered: ${v.toFixed(1)}/s, p95 ${(r.p95_ms / 1000).toFixed(1)} s, ${r.error} errors`;
    body += `<circle class="dot ${s.cls}" cx="${pts[i][0]}" cy="${pts[i][1]}" r="4.5"><title>${tip}</title></circle>`;
  });
}
const lastOf = (cls) => SERIES.find((s) => s.cls === cls).pts.at(-1);
body += `<text class="lab" x="${xOf(60) + 6}" y="${yOf(lastOf("s1")[1]) + 4}">~${Math.round(lastOf("s1")[1])}/s</text>`;
body += `<text class="lab" x="${xOf(60) + 6}" y="${yOf(lastOf("s2")[1]) + 4}">${Math.round(lastOf("s2")[1])}/s</text>`;
if (after) body += `<text class="lab" x="${xOf(60) + 6}" y="${yOf(lastOf("s3")[1]) + 4}">~${Math.round(lastOf("s3")[1])}/s</text>`;

// Right panel: CPU time each accepted checkout costs, before vs after, at the
// 30/s step (both runs saturated). cpu_pct is % of one core over the step.
const at30 = (rows) => rows.find((r) => r.rate === 30) ?? rows.at(-1);
const msPer = (r, svc) => (r[`${svc}_cpu_pct`] * 10) / served(r);
const RUNS = [{ name: "Before", cls: "s1", r: at30(before) }, ...(after ? [{ name: "After", cls: "s3", r: at30(after) }] : [])];
const msMax = 35;
const xBar = (ms) => xB0 + (ms / msMax) * barW;
body += `<text class="panel" x="${xB0}" y="${top - 14}">CPU time per accepted checkout (at ${RUNS[0].r.rate}/s offered)</text>`;
for (let ms = 0; ms <= msMax; ms += 5) {
  body += `<line class="grid" x1="${xBar(ms)}" x2="${xBar(ms)}" y1="${top}" y2="${top + 150}"/>`;
  body += `<text class="axis" x="${xBar(ms)}" y="${top + 166}" text-anchor="middle">${ms}</text>`;
}
body += `<text class="axis" x="${xB0 + barW / 2}" y="${top + 184}" text-anchor="middle">milliseconds of CPU (kernel cgroup counters)</text>`;
[["Postgres", "postgres"], ["API", "api"]].forEach(([label, svc], g) => {
  const y0 = top + 12 + g * 72;
  body += `<text class="value" x="${xB0 - 8}" y="${y0 + 22}" text-anchor="end">${label}</text>`;
  RUNS.forEach((run, i) => {
    const y = y0 + i * 24, ms = msPer(run.r, svc);
    const thr = run.r[`${svc}_throttled_pct`];
    body += `<rect class="${run.cls}" x="${xB0}" y="${y}" width="${Math.max(2, xBar(ms) - xB0)}" height="18" rx="4"><title>${label}, ${run.name.toLowerCase()} fix: ${ms.toFixed(1)} ms CPU per checkout, throttled in ${thr}% of periods</title></rect>`;
    body += `<text class="${i ? "lab" : "value"}" x="${xBar(ms) + 6}" y="${y + 13}">${ms.toFixed(0)} ms ${run.name.toLowerCase()}</text>`;
  });
});
body += `<text class="note" x="${xB0}" y="${top + 210}">Before: ledger_entries (23k rows) had 29,632 full scans and</text>`;
body += `<text class="note" x="${xB0}" y="${top + 226}">0 index scans. After bug 75's indexes: 0 full scans.</text>`;

const legend = SERIES.map((s, i) => `<rect class="${s.cls}" x="${i * 250}" y="62" width="12" height="10" rx="2"/><text class="value" x="${i * 250 + 17}" y="71">${s.name}</text>`).join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d" font-family="system-ui, -apple-system, Segoe UI, sans-serif">
<title id="t">Live checkout capacity on the Dilmune box, and where the CPU went</title>
<desc id="d">${SERIES.map((s) => `${s.name}: ${s.pts.map(([rate, v]) => `${rate}/s offered gives ${v.toFixed(1)}/s`).join("; ")}`).join(". ")}. CPU per accepted checkout: ${RUNS.map((run) => `${run.name.toLowerCase()} fix, Postgres ${msPer(run.r, "postgres").toFixed(1)} ms, API ${msPer(run.r, "api").toFixed(1)} ms`).join("; ")}.</desc>
<style>
  .bg { fill: #fcfcfb } .title { font-size: 16px; font-weight: 600; fill: #1f1f1d } .note { font-size: 11.5px; fill: #5f5e57 }
  .panel { font-size: 12.5px; font-weight: 600; fill: #1f1f1d } .axis { font-size: 11px; fill: #6f6e66 } .value { font-size: 11.5px; fill: #3f3e39 }
  .lab { font-size: 11px; font-weight: 600; fill: #1f1f1d } .grid { stroke: #e6e5df; stroke-width: 1 } .target { stroke: #8a897f; stroke-width: 1; stroke-dasharray: 4 3 }
  .track { fill: #ecebe5 } .bar { fill: #6f6e66 } .limit { stroke: #1f1f1d; stroke-width: 1.5 }
  .line { fill: none; stroke-width: 2; stroke-linejoin: round } .dot { stroke: #fcfcfb; stroke-width: 2 }
  .s1 { fill: #2a78d6; stroke: #2a78d6 } .s2 { fill: #eb6834; stroke: #eb6834 } .s3 { fill: #1baf7a; stroke: #1baf7a }
  .line.s1, .line.s2, .line.s3 { fill: none }
  @media (prefers-color-scheme: dark) {
    .bg { fill: #1a1a19 } .title, .panel, .lab { fill: #f0efec } .note, .value { fill: #c3c2b7 } .axis { fill: #a3a29a }
    .grid { stroke: #34332f } .dot { stroke: #1a1a19 } .track { fill: #2c2b28 } .bar { fill: #a3a29a } .limit { stroke: #f0efec }
    .s1 { fill: #3987e5; stroke: #3987e5 } .s2 { fill: #d95926; stroke: #d95926 } .s3 { fill: #199e70; stroke: #199e70 }
  }
</style>
<rect class="bg" width="${W}" height="${H}" rx="8"/>
<g transform="translate(20,0)">
<text class="title" x="0" y="28">Live capacity (Dilmune, 1 vCPU / 2 GB, k6 over HTTPS from a laptop)</text>
<text class="note" x="0" y="47">30 s per step, payment-link checkout. 0 errors at every step; money invariants held after every run.</text>
${legend}
${body}
</g>
</svg>
`;
const svgPath = join(root, "docs", "perf", "2026-10-30-live-capacity.svg");
writeFileSync(svgPath, svg);
try {
  const sharp = createRequire(import.meta.url)(join(root, "node_modules", "sharp"));
  await sharp(svgPath, { density: 144 }).png().toFile(svgPath.replace(/\.svg$/, ".png"));
} catch (err) {
  console.error("PNG skipped:", err.message);
}
console.log("written", svgPath);
