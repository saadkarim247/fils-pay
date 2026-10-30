// Builds docs/perf/2026-10-30-checkout-capacity.{svg,png} from the three runs'
// results. Usage: node perf/checkout/chart.mjs   (PNG needs node_modules/sharp)
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const load = (label) =>
  readFileSync(join(here, `results-${label}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const SERIES = [
  { label: "baseline", name: "Before (no shedding, pool 5)", cls: "s1" },
  { label: "shed5", name: "Shedding, pool 5", cls: "s2" },
  { label: "pool20", name: "Shedding, pool 20", cls: "s3" },
];
const data = SERIES.map((s) => ({
  ...s,
  points: load(s.label).map((r) => ({
    rate: r.rate,
    served: (r.paid + r.declined + r.acquirer_error) / 30,
    p95: r.p95_ms,
    errors: r.error,
    shed: r.shed,
  })),
}));

const W = 860, H = 380, top = 96, plotH = 220, panelW = 330, gap = 90, left = 60;
const xA0 = left, xB0 = left + panelW + gap;
const xOf = (x0, rate) => x0 + (rate / 60) * panelW;
const yServed = (v) => top + plotH - (v / 25) * plotH;
const yP95 = (ms) => top + plotH - (Math.log10(ms / 500) / Math.log10(60)) * plotH; // 0.5 s .. 30 s

let body = "";
// Axes and grid.
for (const x0 of [xA0, xB0]) {
  for (let r = 0; r <= 60; r += 10) {
    body += `<line class="grid" x1="${xOf(x0, r)}" x2="${xOf(x0, r)}" y1="${top}" y2="${top + plotH}"/>`;
    body += `<text class="axis" x="${xOf(x0, r)}" y="${top + plotH + 16}" text-anchor="middle">${r}</text>`;
  }
  body += `<text class="axis" x="${x0 + panelW / 2}" y="${top + plotH + 34}" text-anchor="middle">Offered load (checkouts started per second)</text>`;
}
for (let v = 0; v <= 25; v += 5) {
  body += `<line class="grid" x1="${xA0}" x2="${xA0 + panelW}" y1="${yServed(v)}" y2="${yServed(v)}"/>`;
  body += `<text class="axis" x="${xA0 - 8}" y="${yServed(v) + 4}" text-anchor="end">${v}</text>`;
}
for (const ms of [500, 1000, 2000, 5000, 10000, 30000]) {
  body += `<line class="grid" x1="${xB0}" x2="${xB0 + panelW}" y1="${yP95(ms)}" y2="${yP95(ms)}"/>`;
  body += `<text class="axis" x="${xB0 - 8}" y="${yP95(ms) + 4}" text-anchor="end">${ms >= 1000 ? ms / 1000 + " s" : "0.5 s"}</text>`;
}
body += `<line class="target" x1="${xB0}" x2="${xB0 + panelW}" y1="${yP95(1500)}" y2="${yP95(1500)}"/>`;
body += `<text class="axis" x="${xB0 + panelW}" y="${yP95(1500) - 5}" text-anchor="end">target p95 1.5 s</text>`;
body += `<text class="panel" x="${xA0}" y="${top - 14}">Checkouts served per second</text>`;
body += `<text class="panel" x="${xB0}" y="${top - 14}">p95 checkout time (log scale)</text>`;

// Lines, markers, direct labels.
const labelY = { s1: [0, 0], s2: [0, 0], s3: [0, 0] };
for (const s of data) {
  const ptsA = s.points.map((p) => [xOf(xA0, p.rate), yServed(p.served)]);
  const ptsB = s.points.map((p) => [xOf(xB0, p.rate), yP95(p.p95)]);
  for (const [pts, metric] of [[ptsA, "served"], [ptsB, "p95"]]) {
    body += `<polyline class="line ${s.cls}" points="${pts.map((p) => p.join(",")).join(" ")}"/>`;
    s.points.forEach((p, i) => {
      const tip = `${s.name}, ${p.rate}/s offered: ${p.served.toFixed(1)}/s served, p95 ${(p.p95 / 1000).toFixed(1)} s, ${p.errors} errors, ${p.shed} shed`;
      const err = p.errors > 0 ? " err" : "";
      body += `<circle class="dot ${s.cls}${err}" cx="${pts[i][0]}" cy="${pts[i][1]}" r="4.5"><title>${tip}</title></circle>`;
    });
    const last = pts[pts.length - 1];
    labelY[s.cls] = last;
  }
}
// Direct labels (served panel), nudged to avoid overlap.
const lastServed = (cls) => data.find((d) => d.cls === cls).points.at(-1);
body += `<text class="lab" x="${xOf(xA0, 40) + 6}" y="${yServed(lastServed("s1").served) + 16}">Before: ${lastServed("s1").served.toFixed(0)}/s, 410 errors</text>`;
body += `<text class="lab" x="${xOf(xA0, 40) + 6}" y="${yServed(lastServed("s2").served) + 16}">Shed, pool 5: ${lastServed("s2").served.toFixed(0)}/s</text>`;
body += `<text class="lab" x="${xOf(xA0, 30)}" y="${yServed(23.7) - 10}" text-anchor="middle">Shed, pool 20: ~22/s</text>`;
body += `<text class="lab" x="${xOf(xB0, 30) + 6}" y="${yP95(28820) + 22}">Before: 28.8 s, errors</text>`;
body += `<text class="lab" x="${xOf(xB0, 60) - 2}" y="${yP95(2299) - 9}" text-anchor="end">pool 20: 2.3 s</text>`;
body += `<text class="lab" x="${xOf(xB0, 40) + 4}" y="${yP95(1174) + 15}">pool 5: 1.2 s</text>`;

const legend = SERIES.map((s, i) => `<rect class="${s.cls}" x="${i * 205}" y="57" width="12" height="10" rx="2"/><text class="value" x="${i * 205 + 17}" y="66">${s.name}</text>`).join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d" font-family="system-ui, -apple-system, Segoe UI, sans-serif">
<title id="t">Checkout capacity: before vs after load shedding and pool sizing</title>
<desc id="d">${data.map((s) => `${s.name}: ${s.points.map((p) => `${p.rate}/s offered gives ${p.served.toFixed(1)}/s served, p95 ${p.p95} ms, ${p.errors} errors`).join("; ")}`).join(". ")}.</desc>
<style>
  .bg { fill: #fcfcfb } .title { font-size: 16px; font-weight: 600; fill: #1f1f1d } .note { font-size: 11.5px; fill: #5f5e57 }
  .panel { font-size: 12.5px; font-weight: 600; fill: #1f1f1d } .axis { font-size: 11px; fill: #6f6e66 } .value { font-size: 11.5px; fill: #3f3e39 }
  .lab { font-size: 11px; font-weight: 600; fill: #1f1f1d } .grid { stroke: #e6e5df; stroke-width: 1 } .target { stroke: #8a897f; stroke-width: 1; stroke-dasharray: 4 3 }
  .line { fill: none; stroke-width: 2; stroke-linejoin: round } .dot { stroke: #fcfcfb; stroke-width: 2 }
  .s1 { fill: #2a78d6; stroke: #2a78d6 } .s2 { fill: #eb6834; stroke: #eb6834 } .s3 { fill: #1baf7a; stroke: #1baf7a }
  .line.s1, .line.s2, .line.s3 { fill: none } .dot.err { stroke: #1f1f1d; stroke-width: 2 }
  @media (prefers-color-scheme: dark) {
    .bg { fill: #1a1a19 } .title, .panel, .lab { fill: #f0efec } .note, .value { fill: #c3c2b7 } .axis { fill: #a3a29a }
    .grid { stroke: #34332f } .dot { stroke: #1a1a19 } .s1 { fill: #3987e5; stroke: #3987e5 } .s2 { fill: #d95926; stroke: #d95926 } .s3 { fill: #199e70; stroke: #199e70 }
  }
</style>
<rect class="bg" width="${W}" height="${H}" rx="8"/>
<g transform="translate(20,0)">
<text class="title" x="0" y="28">Checkout capacity under the production limits (API 0.5 vCPU / 512 MB, whole stack 1 vCPU)</text>
<text class="note" x="0" y="47">30 s per load step, payment-link checkout (open page + pay). Outlined dots = steps with errors. Same laptop; re-measure on the live box.</text>
${legend}
${body}
</g>
</svg>
`;
const svgPath = join(root, "docs", "perf", "2026-10-30-checkout-capacity.svg");
writeFileSync(svgPath, svg);
try {
  const sharp = createRequire(import.meta.url)(join(root, "node_modules", "sharp"));
  await sharp(svgPath, { density: 144 }).png().toFile(svgPath.replace(/\.svg$/, ".png"));
} catch (err) {
  console.error("PNG skipped:", err.message);
}
console.log("written", svgPath);
