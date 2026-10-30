// Builds docs/perf/2026-10-30-batch-n-plus-1.svg from results-before.jsonl and
// results-after.jsonl (median of the reps per scenario). Usage: node perf/batch-n-plus-1/chart.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const load = (label) =>
  readFileSync(join(here, `results-${label}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const summarize = (rows) => {
  const by = {};
  for (const r of rows) (by[r.scenario] ??= []).push(r);
  return Object.fromEntries(Object.entries(by).map(([s, rs]) => [s, { statements: rs[0].statements, ms: median(rs.map((r) => r.ms)) }]));
};
const before = summarize(load("before"));
const after = summarize(load("after"));

const SCENARIOS = [
  ["s1", "Nightly settlement run", "2,003 merchants"],
  ["s2", "One large batch", "2,000 captures"],
  ["s3", "Admin replay batch", "500 deliveries"],
  ["s4", "Recompute statuses", "2,000 transactions"],
];

const W = 845, labelW = 210, panelW = 270, gapX = 40, top = 92, rowH = 52, barH = 12, barGap = 2;
const H = top + SCENARIOS.length * rowH + 40;
const xA0 = labelW, xB0 = labelW + panelW + gapX;
const logX = (v) => xA0 + (Math.log10(Math.max(v, 1)) / 5) * panelW; // 1 .. 100,000
const maxSec = 25;
const secX = (ms) => xB0 + (ms / 1000 / maxSec) * panelW;
const fmt = (n) => n.toLocaleString("en-US");
const secFmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

// A bar anchored at x0 with a 4px rounded data end on the right.
const bar = (x0, x1, y, cls, tip) => {
  const w = Math.max(x1 - x0, 2), r = Math.min(4, w / 2, barH / 2);
  return `<path class="${cls}" d="M${x0},${y} h${w - r} a${r},${r} 0 0 1 ${r},${r} v${barH - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${w - r} z"><title>${tip}</title></path>`;
};

let body = "";
// Grid + axis labels.
for (let p = 0; p <= 5; p++) {
  const x = logX(10 ** p);
  body += `<line class="grid" x1="${x}" x2="${x}" y1="${top - 8}" y2="${H - 34}"/>`;
  body += `<text class="axis" x="${x}" y="${H - 18}" text-anchor="middle">${["1", "10", "100", "1k", "10k", "100k"][p]}</text>`;
}
for (let s = 0; s <= maxSec; s += 5) {
  const x = secX(s * 1000);
  body += `<line class="grid" x1="${x}" x2="${x}" y1="${top - 8}" y2="${H - 34}"/>`;
  body += `<text class="axis" x="${x}" y="${H - 18}" text-anchor="middle">${s} s</text>`;
}
body += `<text class="panel" x="${xA0}" y="${top - 16}">Database round trips (log scale)</text>`;
body += `<text class="panel" x="${xB0}" y="${top - 16}">Time (median of 3 runs)</text>`;

SCENARIOS.forEach(([key, name, size], i) => {
  const y = top + i * rowH;
  const b = before[key], a = after[key];
  body += `<text class="label" x="0" y="${y + 11}">${name}</text>`;
  body += `<text class="sub" x="0" y="${y + 27}">${size}</text>`;
  // Round trips.
  body += bar(xA0, logX(b.statements), y, "before", `${name}, before: ${fmt(b.statements)} statements`);
  body += `<text class="value" x="${logX(b.statements) + 6}" y="${y + 10}">${fmt(b.statements)}</text>`;
  body += bar(xA0, logX(a.statements), y + barH + barGap, "after", `${name}, after: ${fmt(a.statements)} statements`);
  body += `<text class="value strong" x="${logX(a.statements) + 6}" y="${y + barH + barGap + 10}">${fmt(a.statements)}  (${Math.round(b.statements / a.statements)}× fewer)</text>`;
  // Time.
  body += bar(xB0, secX(b.ms), y, "before", `${name}, before: ${secFmt(b.ms)}`);
  body += `<text class="value" x="${secX(b.ms) + 6}" y="${y + 10}">${secFmt(b.ms)}</text>`;
  body += bar(xB0, secX(a.ms), y + barH + barGap, "after", `${name}, after: ${secFmt(a.ms)}`);
  body += `<text class="value strong" x="${secX(a.ms) + 6}" y="${y + barH + barGap + 10}">${secFmt(a.ms)}  (${(b.ms / a.ms).toFixed(1)}× faster)</text>`;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d" font-family="system-ui, -apple-system, Segoe UI, sans-serif">
<title id="t">Batch N+1 fixes: round trips and time, before vs after</title>
<desc id="d">${SCENARIOS.map(([k, n]) => `${n}: ${fmt(before[k].statements)} to ${fmt(after[k].statements)} statements, ${secFmt(before[k].ms)} to ${secFmt(after[k].ms)}`).join("; ")}.</desc>
<style>
  .bg { fill: #fcfcfb } .title { font-size: 16px; font-weight: 600; fill: #1f1f1d } .note { font-size: 11.5px; fill: #5f5e57 }
  .panel { font-size: 12px; font-weight: 600; fill: #1f1f1d } .label { font-size: 12.5px; font-weight: 600; fill: #1f1f1d }
  .sub, .axis { font-size: 11px; fill: #6f6e66 } .value { font-size: 11px; fill: #5f5e57 } .strong { fill: #1f1f1d; font-weight: 600 }
  .grid { stroke: #e6e5df; stroke-width: 1 } .before { fill: #2a78d6 } .after { fill: #eb6834 }
  @media (prefers-color-scheme: dark) {
    .bg { fill: #1a1a19 } .title, .panel, .label, .strong { fill: #f0efec } .note, .value { fill: #c3c2b7 }
    .sub, .axis { fill: #a3a29a } .grid { stroke: #34332f } .before { fill: #3987e5 } .after { fill: #d95926 }
  }
</style>
<rect class="bg" width="${W}" height="${H}" rx="8"/>
<g transform="translate(20,0)">
<text class="title" x="0" y="28">Batch N+1 fixes: database round trips and time, before vs after</text>
<text class="note" x="0" y="47">Same fixed dataset for both; statements counted by Postgres (log_statement=all); identical business results.</text>
<rect class="before" x="0" y="57" width="12" height="10" rx="2"/><text class="value" x="17" y="66">Before</text>
<rect class="after" x="70" y="57" width="12" height="10" rx="2"/><text class="value" x="87" y="66">After</text>
${body}
</g>
</svg>
`;
writeFileSync(join(root, "docs", "perf", "2026-10-30-batch-n-plus-1.svg"), svg);
console.log(JSON.stringify({ before, after }));
