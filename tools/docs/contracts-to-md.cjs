// Builds the FilsPay code-contracts reference as Markdown from the same per-slice JSON.
// Usage: node tools/docs/contracts-to-md.cjs <contractsDir> <out.md>
"use strict";
const fs = require("fs");
const path = require("path");

const [, , dir, out] = process.argv;
const PARTS = [
  ["api", "API service", "apps/api/"], ["settlement", "Settlement service", "apps/settlement/"],
  ["reporting", "Reporting worker", "apps/reporting/"], ["web", "Merchant dashboard and hosted checkout", "apps/web/"],
  ["admin", "Admin console", "apps/admin/"], ["money", "Money package", "packages/money/"],
  ["events", "Events package", "packages/events/"], ["migrations", "Database: migrations, runner and seed", "db/"],
  ["scripts", "Operational scripts", "scripts/"], ["ops", "Operations and deployment", "ops/"],
  ["workspace", "Appendix: workspace root", ""],
];
const match = (prefix, p) => (prefix ? p.startsWith(prefix) : !p.includes("/"));
const files = new Map(), dirs = new Map(), overviews = new Map();
for (const jf of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, jf), "utf8"));
  for (const [k, v] of Object.entries(d.partOverviews ?? {})) if (!overviews.has(k)) overviews.set(k, v);
  for (const x of d.directories ?? []) if (!dirs.has(x.path)) dirs.set(x.path, x.description);
  for (const f of d.files ?? []) if (!files.has(f.path)) files.set(f.path, f);
}
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const tick = (s) => { s = String(s ?? ""); return s.includes("`") ? "`` " + s + " ``" : "`" + s + "`"; };
const anchor = (s) => s.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-");
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");

let md = "# FilsPay — Code Contracts Reference\n\nWhat every file is responsible for, and the contract of every symbol it defines. ";
md += "Contracts describe the code as it behaves today (inputs, outputs, side effects, errors), not what comments claim; ";
md += "**⚠ Note** lines mark where a comment/doc says otherwise. Money is integer fils (1 BD = 1000 fils). `docs/` is not covered.\n\n";
md += "## Contents\n\n" + PARTS.map(([, t, p]) => `- [${t}](#${anchor(t)})${p ? ` — \`${p}\`` : ""}`).join("\n") + "\n";
let nf = 0, ns = 0;
for (const [key, title, prefix] of PARTS) {
  const pf = [...files.values()].filter((f) => match(prefix, f.path)).sort((a, b) => a.path.localeCompare(b.path));
  md += `\n---\n\n## ${title}\n\n`;
  if (overviews.has(key)) md += overviews.get(key) + "\n\n";
  const ds = [...new Set(pf.map((f) => dirOf(f.path)))].sort();
  md += "| Directory | Files | Responsibility |\n|---|---:|---|\n";
  for (const d of ds) md += `| \`${d}\` | ${pf.filter((f) => dirOf(f.path) === d).length} | ${cell(dirs.get(d))} |\n`;
  for (const d of ds) {
    const inDir = pf.filter((f) => dirOf(f.path) === d);
    md += `\n### \`${d}\`\n\n${dirs.get(d) ? "*" + dirs.get(d) + "*\n\n" : ""}`;
    for (const f of inDir.filter((f) => f.kind !== "test")) {
      nf++;
      md += `#### \`${f.path}\` <sub>${String(f.kind).toUpperCase()}</sub>\n\n${f.summary ?? ""}\n\n`;
      for (const s of f.symbols ?? []) {
        ns++;
        md += `- **${tick(s.name)}** <sub>${s.kind ?? ""}</sub>`;
        if (s.signature && s.signature !== s.name) md += `  \n  ${tick(s.signature)}`;
        if (s.contract) md += `  \n  ${s.contract}`;
        if (s.note) md += `  \n  > **⚠ Note.** ${s.note}`;
        md += "\n";
      }
      if (f.symbols?.length) md += "\n";
    }
    const tests = inDir.filter((f) => f.kind === "test");
    if (tests.length) {
      nf += tests.length;
      md += "**Tests in this directory**\n\n| Test file | What it covers |\n|---|---|\n";
      for (const t of tests) md += `| \`${path.basename(t.path)}\` | ${cell(t.summary)} |\n`;
      md += "\n";
    }
  }
}
fs.writeFileSync(out, md, "utf8");
console.log(`wrote ${out}: ${nf} files, ${ns} symbols, ${md.split("\n").length} lines`);
