// Builds the FilsPay code-contracts reference (pdfLaTeX) from per-slice JSON files.
// Usage: node tools/docs/contracts-to-latex.cjs <contractsDir> <repoRoot> <out.tex>
// Built-in modules only; the only external command is a read-only `git ls-files` / `git log`.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const [, , contractsDir, repoRoot, outFile] = process.argv;
if (!contractsDir || !repoRoot || !outFile) {
  console.error("usage: node tools/docs/contracts-to-latex.cjs <contractsDir> <repoRoot> <out.tex>");
  process.exit(2);
}

// ---------------------------------------------------------------- parts
const PARTS = [
  { key: "api", title: "API service", dir: "apps/api", lang: "TypeScript, Fastify",
    role: "HTTP API for merchants, the public checkout and the admin console; webhook dispatcher; acquirer client.",
    match: (p) => p.startsWith("apps/api/") },
  { key: "settlement", title: "Settlement service", dir: "apps/settlement", lang: "Go",
    role: "Daemon and CLI: daily batch close, payouts, scheme file export, splits, balance cache, internal HTTP API.",
    match: (p) => p.startsWith("apps/settlement/") },
  { key: "reporting", title: "Reporting worker", dir: "apps/reporting", lang: "TypeScript",
    role: "Consumes outbox events into analytics rollup tables; catch-up and rebuild tools.",
    match: (p) => p.startsWith("apps/reporting/") },
  { key: "web", title: "Merchant dashboard and hosted checkout", dir: "apps/web", lang: "TypeScript, React",
    role: "Merchant-facing dashboard and the public payment-link checkout page.",
    match: (p) => p.startsWith("apps/web/") },
  { key: "admin", title: "Admin console", dir: "apps/admin", lang: "TypeScript, React",
    role: "Internal operations console (support, finance, super_admin).",
    match: (p) => p.startsWith("apps/admin/") },
  { key: "money", title: "Money package", dir: "packages/money", lang: "TypeScript",
    role: "Branded Fils type, BHD parsing and formatting, basis-point rates, rounding and allocation.",
    match: (p) => p.startsWith("packages/money/") },
  { key: "events", title: "Events package", dir: "packages/events", lang: "TypeScript",
    role: "Outbox event types and the enqueueEvent helper shared by the TypeScript services.",
    match: (p) => p.startsWith("packages/events/") },
  { key: "migrations", title: "Database: migrations, runner and seed", dir: "db", lang: "SQL, TypeScript",
    role: "Postgres schema (migrations 0001-0072), the migration runner and deterministic seed data.",
    match: (p) => p.startsWith("db/") },
  { key: "scripts", title: "Operational scripts", dir: "scripts", lang: "TypeScript",
    role: "One-off finance scripts and the nightly hold-expiry job.",
    match: (p) => p.startsWith("scripts/") },
  { key: "ops", title: "Operations and deployment", dir: "ops", lang: "Docker Compose, env",
    role: "Local/hosted topology: services, ports, environment configuration.",
    match: (p) => p.startsWith("ops/") },
  { key: "workspace", title: "Workspace root", dir: ".", lang: "config, docs",
    role: "npm workspaces, TypeScript project config and the AI-assistant instruction files.",
    match: (p) => !p.includes("/"), appendix: true },
];

const API_SLICES = [
  ["api-core", "Core and HTTP surface"],
  ["api-money", "Money flows"],
  ["api-identity", "Identity, onboarding and admin logic"],
  ["api-events", "Webhooks, analytics and reporting"],
];

// ---------------------------------------------------------------- escaping
const UNICODE = new Map(Object.entries({
  "\u2192": "$\\rightarrow$", "\u2190": "$\\leftarrow$", "\u2194": "$\\leftrightarrow$",
  "\u21d2": "$\\Rightarrow$", "\u21d0": "$\\Leftarrow$", "\u2191": "$\\uparrow$", "\u2193": "$\\downarrow$",
  "\u2264": "$\\le$", "\u2265": "$\\ge$", "\u2260": "$\\neq$", "\u2248": "$\\approx$",
  "\u00d7": "$\\times$", "\u00f7": "$\\div$", "\u00b1": "$\\pm$", "\u2208": "$\\in$", "\u2209": "$\\notin$",
  "\u2211": "$\\sum$", "\u03a3": "$\\Sigma$", "\u2205": "$\\emptyset$", "\u221e": "$\\infty$",
  "\u2227": "$\\wedge$", "\u2228": "$\\vee$", "\u00ac": "$\\neg$", "\u2261": "$\\equiv$",
  "\u2212": "-", "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "--", "\u2014": "---",
  "\u2026": "\\ldots{}", "\u201c": "``", "\u201d": "''", "\u201e": ",,", "\u2018": "`", "\u2019": "'",
  "\u2032": "'", "\u2033": "''", "\u2022": "\\textbullet{}", "\u00b7": "\\textperiodcentered{}",
  "\u00b0": "\\textdegree{}", "\u2713": "$\\checkmark$", "\u2714": "$\\checkmark$", "\u2717": "x", "\u2718": "x",
  "\u26a0": "(!)", "\u00a0": "~", "\u202f": "~", "\u2009": "\\,", "\u00a7": "\\S{}", "\u00b6": "\\P{}",
  "\u00e9": "\\'e", "\u00e8": "\\`e", "\u00e1": "\\'a", "\u00e0": "\\`a", "\u00f6": "\\\"o", "\u00fc": "\\\"u",
  "\u00e4": "\\\"a", "\u00e7": "\\c{c}", "\u00ed": "\\'i", "\u00f3": "\\'o", "\u00fa": "\\'u", "\u00f1": "\\~n",
  "\u00b2": "\\textsuperscript{2}", "\u00b3": "\\textsuperscript{3}", "\u00b9": "\\textsuperscript{1}",
  "\u00bd": "1/2", "\u00bc": "1/4", "\u2030": "\\textperthousand{}", "\u00b5": "$\\mu$", "\u03bc": "$\\mu$",
}));
const unmapped = new Map();
const BREAK_AFTER = new Set(["/", ",", "(", ")", ":", ".", "|", "=", ";", "[", "]", "{", "}", "<", ">", "&", "_", "?"]);

function esc(input, opts = {}) {
  const code = Boolean(opts.code);
  const breaks = code && opts.breaks !== false;
  let out = "";
  const chars = Array.from(String(input ?? ""));
  for (let idx = 0; idx < chars.length; idx++) {
    const ch = chars[idx];
    let piece;
    switch (ch) {
      // ASCII "--" would become an en dash in prose; mapped Unicode dashes are emitted below untouched.
      case "-": piece = chars[idx + 1] === "-" ? "-{}" : "-"; break;
      // Long paths in prose need a break opportunity after each slash.
      case "/": piece = code ? "/" : "\\slash{}"; break;
      case "\\": piece = "\\textbackslash{}"; break;
      case "{": piece = "\\{"; break;
      case "}": piece = "\\}"; break;
      case "$": piece = "\\$"; break;
      case "&": piece = "\\&"; break;
      case "#": piece = "\\#"; break;
      case "%": piece = "\\%"; break;
      case "_": piece = "\\_"; break;
      case "~": piece = "\\textasciitilde{}"; break;
      case "^": piece = "\\textasciicircum{}"; break;
      case "|": piece = "\\textbar{}"; break;
      case "<": piece = "\\textless{}"; break;
      case ">": piece = "\\textgreater{}"; break;
      case "\r": piece = ""; break;
      case "\n": case "\t": piece = " "; break;
      default: {
        const cp = ch.codePointAt(0);
        if (cp < 128) piece = ch;
        else if (UNICODE.has(ch)) piece = UNICODE.get(ch);
        else {
          const ascii = ch.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
          if (/^[\x20-\x7e]+$/.test(ascii)) piece = esc(ascii, { code, breaks: false });
          else { piece = "?"; unmapped.set(ch, (unmapped.get(ch) ?? 0) + 1); }
        }
      }
    }
    out += piece;
    if (breaks && BREAK_AFTER.has(ch)) out += "\\allowbreak{}";
  }
  return out;
}
const code = (s) => esc(s, { code: true });
const codeNoBreak = (s) => esc(s, { code: true, breaks: false });
const text = (s) => esc(s);

// ---------------------------------------------------------------- load slices
const normPath = (p) => String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
const files = new Map();
const dirDescriptions = new Map();
const partOverviews = new Map();
const sliceOverviews = new Map();
const problems = [];

const jsonFiles = fs.readdirSync(contractsDir).filter((f) => f.endsWith(".json")).sort();
for (const jf of jsonFiles) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(contractsDir, jf), "utf8").replace(/^\uFEFF/, ""));
  } catch (err) {
    problems.push(`${jf}: invalid JSON (${err.message})`);
    continue;
  }
  const agent = doc.agent ?? path.basename(jf, ".json");
  if (doc.sliceOverview) sliceOverviews.set(agent, doc.sliceOverview);
  for (const [k, v] of Object.entries(doc.partOverviews ?? {})) if (v && !partOverviews.has(k)) partOverviews.set(k, v);
  for (const d of doc.directories ?? []) {
    const p = normPath(d.path) || ".";
    if (d.description && !dirDescriptions.has(p)) dirDescriptions.set(p, d.description);
  }
  for (const f of doc.files ?? []) {
    const p = normPath(f.path);
    if (!p) { problems.push(`${jf}: file entry without path`); continue; }
    if (files.has(p)) { problems.push(`${jf}: duplicate entry for ${p} (kept the one from ${files.get(p).agent})`); continue; }
    files.set(p, { ...f, path: p, agent, symbols: Array.isArray(f.symbols) ? f.symbols : [] });
  }
}

// ---------------------------------------------------------------- coverage
const git = (args) => execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
const tracked = git(["ls-files"]).split("\n").map((s) => s.trim()).filter(Boolean);
const snapshot = git(["log", "-1", "--format=%h|%cs"]).trim().split("|");
const coverage = [];
for (const part of PARTS) {
  const expected = tracked.filter(part.match);
  const documented = [...files.keys()].filter(part.match);
  const missing = expected.filter((p) => !files.has(p));
  const extra = documented.filter((p) => !expected.includes(p));
  coverage.push({ part: part.key, expected: expected.length, documented: documented.length, missing, extra });
}

// ---------------------------------------------------------------- rendering
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
const baseOf = (p) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p);
const isTest = (f) => String(f.kind).toLowerCase() === "test";
const labelOf = (s) => s.replace(/[^A-Za-z0-9]+/g, "-");
const pdfSafe = (s) => s.replace(/[\\{}$&#%^~|<>]/g, "").replace(/_/g, "\\_");

function renderSymbols(symbols) {
  if (!symbols.length) return "";
  const items = symbols.map((s) => {
    const sig = s.signature && s.signature.trim() && s.signature.trim() !== s.name ? `\\sig{${code(s.signature)}}` : "";
    const contract = s.contract ? `\\par ${text(s.contract)}` : "";
    const note = s.note ? `\\notebox{${text(s.note)}}` : "";
    return `  \\item \\symname{${code(s.name ?? "(unnamed)")}}\\symkind{${text(s.kind ?? "")}}${sig}${contract}${note}`;
  });
  return `\\begin{symbols}\n${items.join("\n")}\n\\end{symbols}\n`;
}

function renderFile(f) {
  let out = `\\filehead{${code(f.path)}}{${text(String(f.kind ?? "").toUpperCase())}}\n`;
  if (f.summary) out += `\\filesummary{${text(f.summary)}}\n`;
  out += renderSymbols(f.symbols);
  return out;
}

function renderTests(tests) {
  if (!tests.length) return "";
  const rows = tests
    .map((t) => `\\texttt{${code(baseOf(t.path))}} & ${text(t.summary ?? "")}${t.symbols?.length ? "" : ""} \\\\`)
    .join("\n");
  return [
    "\\testsheading",
    "\\begin{longtable}{@{}>{\\raggedright\\arraybackslash}p{0.32\\textwidth}>{\\raggedright\\arraybackslash}p{0.62\\textwidth}@{}}",
    "\\toprule \\textbf{Test file} & \\textbf{What it covers} \\\\ \\midrule \\endhead",
    "\\bottomrule \\endfoot",
    rows,
    "\\end{longtable}",
    "",
  ].join("\n");
}

function renderPart(part) {
  const partFiles = [...files.values()].filter((f) => part.match(f.path)).sort((a, b) => a.path.localeCompare(b.path));
  const dirs = [...new Set(partFiles.map((f) => dirOf(f.path)))].sort((a, b) => a.localeCompare(b));
  const symCount = partFiles.reduce((n, f) => n + f.symbols.length, 0);
  const dirLabel = part.dir === "." ? "repository root" : part.dir;
  let out = "\\clearpage\n";
  out += `\\section{${text(part.title)} \\texorpdfstring{(\\texttt{${codeNoBreak(dirLabel)}})}{(${pdfSafe(dirLabel)})}}\\label{part:${part.key}}\n`;
  out += `\\partfacts{${text(part.lang)}}{${partFiles.length}}{${symCount}}\n`;
  if (partOverviews.has(part.key)) out += `\\noindent ${text(partOverviews.get(part.key))}\\par\n`;
  if (part.key === "api") {
    const slices = API_SLICES.filter(([k]) => sliceOverviews.has(k));
    if (slices.length) {
      out += "\\begin{description}[leftmargin=1.2em,itemsep=0.4ex,font=\\normalfont\\bfseries]\n";
      for (const [k, label] of slices) out += `  \\item[${text(label)}.] ${text(sliceOverviews.get(k))}\n`;
      out += "\\end{description}\n";
    }
  }
  // Directory index for the part.
  out += "\\subsection*{Directories in this part}\n";
  out += "\\begin{longtable}{@{}>{\\raggedright\\arraybackslash}p{0.34\\textwidth}r>{\\raggedright\\arraybackslash}p{0.50\\textwidth}@{}}\n";
  out += "\\toprule \\textbf{Directory} & \\textbf{Files} & \\textbf{Responsibility} \\\\ \\midrule \\endhead\n\\bottomrule \\endfoot\n";
  for (const d of dirs) {
    const n = partFiles.filter((f) => dirOf(f.path) === d).length;
    out += `\\hyperref[dir:${labelOf(d)}]{\\texttt{${code(d === "." ? "(root)" : d)}}} & ${n} & ${text(dirDescriptions.get(d) ?? "")} \\\\\n`;
  }
  out += "\\end{longtable}\n";
  for (const d of dirs) {
    const inDir = partFiles.filter((f) => dirOf(f.path) === d);
    const title = d === "." ? "(repository root)" : d;
    out += `\\subsection{\\texorpdfstring{\\texttt{${codeNoBreak(title)}}}{${pdfSafe(title)}}}\\label{dir:${labelOf(d)}}\n`;
    if (dirDescriptions.has(d)) out += `\\dirdescription{${text(dirDescriptions.get(d))}}\n`;
    for (const f of inDir.filter((x) => !isTest(x))) out += renderFile(f);
    out += renderTests(inDir.filter(isTest));
  }
  return out;
}

function renderOverviewTable() {
  let out = "\\begin{longtable}{@{}>{\\raggedright\\arraybackslash}p{0.19\\textwidth}>{\\raggedright\\arraybackslash}p{0.17\\textwidth}rr>{\\raggedright\\arraybackslash}p{0.29\\textwidth}@{}}\n";
  out += "\\toprule \\textbf{Part} & \\textbf{Directory / language} & \\textbf{Files} & \\textbf{Symbols} & \\textbf{Role} \\\\ \\midrule \\endhead\n\\bottomrule \\endfoot\n";
  for (const part of PARTS) {
    const pf = [...files.values()].filter((f) => part.match(f.path));
    const sc = pf.reduce((n, f) => n + f.symbols.length, 0);
    out += `\\hyperref[part:${part.key}]{${text(part.title)}} & \\texttt{${code(part.dir === "." ? "(root)" : part.dir)}}\\newline {\\footnotesize ${text(part.lang)}} & ${pf.length} & ${sc} & ${text(part.role)} \\\\\n`;
  }
  out += "\\end{longtable}\n";
  return out;
}

const totalFiles = [...files.values()].filter((f) => PARTS.some((p) => p.match(f.path))).length;
const totalSymbols = [...files.values()].reduce((n, f) => n + f.symbols.length, 0);

const preamble = String.raw`\documentclass[10pt,a4paper]{article}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{lmodern}
\usepackage[margin=2cm]{geometry}
\usepackage{microtype}
\usepackage{xcolor}
\usepackage{amssymb}
\usepackage{textcomp}
\usepackage{enumitem}
\usepackage{array,longtable,booktabs}
\usepackage[hidelinks,bookmarksnumbered]{hyperref}

\definecolor{kindgray}{HTML}{6B7280}
\definecolor{warn}{HTML}{9A3412}
\definecolor{rule}{HTML}{D1D5DB}
\setcounter{tocdepth}{2}
\setlength{\parindent}{0pt}
\setlength{\parskip}{0.35ex}
\setlength{\emergencystretch}{3em}
\raggedbottom

\newcommand{\partfacts}[3]{{\color{kindgray}\small #1 \textbullet{} #2 files \textbullet{} #3 documented symbols}\par\medskip}
\newcommand{\dirdescription}[1]{{\itshape #1}\par\smallskip}
\newcommand{\filehead}[2]{\par\addvspace{1.1ex}{\color{rule}\hrule height 0.4pt}\nopagebreak\vspace{0.5ex}\noindent{\texttt{\textbf{#1}}}\hfill{\color{kindgray}\scriptsize\textsf{#2}}\par\nopagebreak}
\newcommand{\filesummary}[1]{\noindent #1\par}
\newcommand{\symname}[1]{\texttt{\textbf{#1}}}
\newcommand{\symkind}[1]{\enspace{\color{kindgray}\scriptsize\textsf{#1}}}
\newcommand{\sig}[1]{\par\nopagebreak{\small\ttfamily\raggedright #1\par}}
\newcommand{\notebox}[1]{\par{\color{warn}\small\textbf{Note.}~#1}}
\newcommand{\testsheading}{\par\addvspace{1ex}\noindent{\small\bfseries Tests in this directory}\par\nopagebreak}
\newenvironment{symbols}{\begin{itemize}[leftmargin=1.4em,itemsep=0.5ex,topsep=0.4ex,parsep=0.2ex,label=\textbullet]\small}{\end{itemize}}
`;

const front = String.raw`\begin{document}
\begin{titlepage}
\centering
\vspace*{3cm}
{\Huge\bfseries FilsPay\par}
\vspace{0.6cm}
{\LARGE Code Contracts Reference\par}
\vspace{0.8cm}
{\large What every file is responsible for, and the contract of every symbol it defines\par}
\vspace{2cm}
{\normalsize Repository snapshot: \texttt{main} @ \texttt{${text(snapshot[0])}} (${text(snapshot[1])})\par}
{\normalsize ${totalFiles} files \textbullet{} ${totalSymbols} documented symbols\par}
\vfill
{\normalsize Prepared by Saad Karim for The Handover hackathon\par}
{\small Documented 29 October 2026, read-only: no code was changed or executed to produce this reference.\par}
\end{titlepage}

\tableofcontents
\clearpage

\section*{How to read this document}
\addcontentsline{toc}{section}{How to read this document}
This reference describes the \emph{contracts} of the FilsPay code base: for each file, what it is responsible for, and for each
symbol it defines (function, type, component, route, table, \ldots) its signature and its observable behaviour --- inputs,
outputs, side effects (database tables read or written, events enqueued, HTTP calls made) and errors. It deliberately does not
explain implementation details.

\begin{itemize}[leftmargin=1.4em,itemsep=0.3ex]
  \item \textbf{Contracts describe the code as it behaves today}, not what comments, documentation or AI-assistant files
        claim. Where a comment or document says something different, a \textcolor{warn}{\textbf{Note.}} line records the
        difference. Notes are observations for orientation; the audit findings are documented separately.
  \item \textbf{Money} is always an integer number of fils (1~BD = 1000~fils). Names ending in \texttt{Fils} or
        \texttt{\_fils} are fils.
  \item \textbf{Signatures} are abbreviated: large inline object types are named and their key fields described in the
        contract. Routes are written as \texttt{METHOD /path} with their pre-handlers.
  \item \textbf{File kinds}: SOURCE (code), TEST (summarised in a table per directory), SQL (schema migrations), CONFIG,
        DOC, STYLE and ASSET.
  \item \textbf{Scope}: the ten parts below plus the repository root (appendix). The \texttt{docs/} folder is not covered.
\end{itemize}

\section*{System at a glance}
\addcontentsline{toc}{section}{System at a glance}
All services share one Postgres database. The API and the Go settlement service write the double-entry ledger; changes are
announced through a transactional outbox that the webhook dispatcher (inside the API) and the reporting worker consume. The
web and admin front ends talk only to the API; the admin console reaches the settlement service through the API, which calls
the settlement worker's authenticated internal HTTP API.

`;

let body = renderOverviewTable();
let appendixStarted = false;
for (const part of PARTS) {
  if (part.appendix && !appendixStarted) { body += "\\appendix\n"; appendixStarted = true; }
  body += renderPart(part);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${preamble}\n${front}${body}\n\\end{document}\n`, "utf8");

// ---------------------------------------------------------------- report
console.log(`wrote ${outFile}`);
console.log(`slices: ${jsonFiles.join(", ") || "(none)"}`);
console.log(`files documented (in parts): ${totalFiles}; symbols: ${totalSymbols}`);
for (const c of coverage) {
  const status = c.missing.length || c.extra.length ? "INCOMPLETE" : "ok";
  console.log(`  ${c.part.padEnd(11)} ${String(c.documented).padStart(3)}/${String(c.expected).padEnd(3)} ${status}`);
  if (c.missing.length) console.log(`     missing: ${c.missing.join(", ")}`);
  if (c.extra.length) console.log(`     not tracked in git: ${c.extra.join(", ")}`);
}
if (problems.length) console.log(`problems:\n  ${problems.join("\n  ")}`);
if (unmapped.size) console.log(`unmapped characters (rendered as ?): ${[...unmapped].map(([c, n]) => `U+${c.codePointAt(0).toString(16).toUpperCase()}x${n}`).join(", ")}`);
