// Builds the submission PDFs from the Markdown sections in this folder.
//   node docs/submission/build.mjs            -> out/TeamName_FilsPay_Submission.pdf + _Slides.pdf
// No dependencies: a small Markdown subset -> HTML, then headless Chrome/Edge prints it.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const TEAM = process.env.TEAM_NAME || "TeamName";
const out = join(here, "out");
mkdirSync(out, { recursive: true });

// Section order follows the submission guidelines. `shift` demotes headings so
// every file nests under its numbered section.
const SECTIONS = [
  { file: "cover.md" },
  // Judges' logins: gitignored, so they reach the PDF but never the repo.
  { file: "credentials.local.md", optional: true },
  { file: "summary.md" },
  { file: "architecture.md" },
  { file: "capacity.md" },
  { file: "findings.md" },
  { file: "root-causes.md", minLevel: 3 },
  { file: "decisions-and-risks.md", minLevel: 3 },
  { text: "### 4.9 Every finding in full\n\nOne entry per finding: symptom, how we found and reproduced it, root cause, fix, how we verified it, and the effect on existing data.\n" },
  { file: "findings-01-40.md", shift: 2 },
  { file: "findings-41-79.md", shift: 2 },
  { file: "ui.md" },
  { text: "## 6. AI usage\n" },
  { file: "ai-setup.md", minLevel: 3 },
  { file: "ai-approach.md", minLevel: 3 },
  { file: "ai-excerpts.md", minLevel: 3 },
  { file: "appendix.md", optional: true },
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(esc(c)) - 1}\u0000`);
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

function headingLevel(line) {
  const m = /^(#{1,6})\s/.exec(line);
  return m ? m[1].length : 0;
}

// Demote headings by `shift`, or just enough that the top heading is `minLevel`.
function adjustHeadings(md, { shift = 0, minLevel = 0 }) {
  const lines = md.split(/\r?\n/);
  if (minLevel) {
    let inFence = false, top = 7;
    for (const l of lines) {
      if (l.startsWith("```")) inFence = !inFence;
      const h = !inFence && headingLevel(l);
      if (h) top = Math.min(top, h);
    }
    shift = top < minLevel ? minLevel - top : 0;
  }
  if (!shift) return md;
  let inFence = false;
  return lines
    .map((l) => {
      if (l.startsWith("```")) inFence = !inFence;
      return !inFence && headingLevel(l) ? "#".repeat(shift) + l : l;
    })
    .join("\n");
}

// Fences indented under a list item are lifted out to column 0 (this subset has no nested blocks).
function unindentFences(md) {
  const out = [];
  let indent = null;
  for (const l of md.split(/\r?\n/)) {
    const m = /^(\s+)```/.exec(l);
    if (indent === null && m) { indent = m[1].length; out.push(l.slice(indent)); continue; }
    if (indent !== null) {
      const closes = /^\s*```\s*$/.test(l);
      out.push(l.slice(Math.min(indent, /^\s*/.exec(l)[0].length)));
      if (closes) indent = null;
      continue;
    }
    out.push(l);
  }
  return out.join("\n");
}

function mdToHtml(md) {
  const lines = unindentFences(md).split(/\r?\n/);
  const html = [];
  let i = 0;
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, "|")));
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const body = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      html.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
    } else if (headingLevel(l)) {
      const n = Math.min(headingLevel(l), 6);
      const text = l.replace(/^#+\s*/, "");
      const id = text.toLowerCase().replace(/[^\w]+/g, "-").replace(/^-|-$/g, "");
      html.push(`<h${n} id="${id}">${inline(text)}</h${n}>`);
      i++;
    } else if (/^\s*(---|\*\*\*)\s*$/.test(l)) {
      html.push("<hr>");
      i++;
    } else if (/^<!--\s*pagebreak\s*-->/.test(l)) {
      html.push('<div class="pb"></div>');
      i++;
    } else if (l.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(l);
      i += 2;
      const rows = [];
      for (; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(cells(lines[i]));
      html.push(
        `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") +
          "</tbody></table>",
      );
    } else if (/^\s*>/.test(l)) {
      const body = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ""));
      html.push(`<blockquote>${mdToHtml(body.join("\n"))}</blockquote>`);
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      html.push(list());
    } else if (!l.trim()) {
      i++;
    } else {
      const body = [];
      for (; i < lines.length && lines[i].trim() && !headingLevel(lines[i]) && !/^```/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && !/^\s*>/.test(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])); i++)
        body.push(lines[i]);
      html.push(`<p>${inline(body.join(" "))}</p>`);
    }
  }
  return html.join("\n");

  // Nested lists by indentation (2+ spaces = one level).
  function list() {
    const indentOf = (s) => /^(\s*)/.exec(s)[1].replace(/\t/g, "    ").length;
    const base = indentOf(lines[i]);
    const ordered = /^\s*\d+[.)]/.test(lines[i]);
    const items = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (!cur.trim()) {
        const next = lines[i + 1];
        if (next && /^\s*([-*+]|\d+[.)])\s+/.test(next) && indentOf(next) >= base) { i++; continue; }
        break;
      }
      const ind = indentOf(cur);
      if (ind < base) break;
      if (ind > base && /^\s*([-*+]|\d+[.)])\s+/.test(cur)) {
        items[items.length - 1] += list();
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(cur) && ind === base) {
        items.push(inline(cur.replace(/^\s*([-*+]|\d+[.)])\s+/, "")));
      } else if (items.length) {
        items[items.length - 1] += " " + inline(cur.trim());
      } else break;
      i++;
    }
    const tag = ordered ? "ol" : "ul";
    return `<${tag}>${items.map((x) => `<li>${x}</li>`).join("")}</${tag}>`;
  }
}

const DOC_CSS = `
@page { size: A4; margin: 16mm 15mm 18mm; }
body { font: 10.5pt/1.45 "Segoe UI", Calibri, Arial, sans-serif; color: #1d2433; background: #fff; }
h1 { font-size: 22pt; margin: 0 0 6pt; } h2 { font-size: 16pt; margin: 22pt 0 8pt; padding-bottom: 4pt; border-bottom: 2px solid #1f6feb; break-before: page; }
h2:first-of-type { break-before: auto; }
h3 { font-size: 12.5pt; margin: 16pt 0 6pt; color: #0b3d91; } h4 { font-size: 11pt; margin: 12pt 0 4pt; break-after: avoid; }
p, li { margin: 3pt 0; } ul, ol { padding-left: 18pt; margin: 4pt 0; }
code { font: 9pt Consolas, monospace; background: #f1f3f7; padding: 0 2pt; border-radius: 2pt; }
pre { background: #f5f7fa; border: 1px solid #dde2ea; padding: 6pt 8pt; font-size: 8.5pt; white-space: pre-wrap; word-break: break-word; break-inside: avoid; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0; font-size: 9pt; break-inside: auto; }
th, td { border: 1px solid #cfd6e0; padding: 3pt 5pt; vertical-align: top; text-align: left; } th { background: #eef2f8; }
tr { break-inside: avoid; }
img { max-width: 100%; border: 1px solid #dde2ea; margin: 4pt 0; }
blockquote { border-left: 3px solid #9fb3d1; margin: 6pt 0; padding: 2pt 10pt; color: #34405a; background: #f8fafc; }
a { color: #0b5cd5; text-decoration: none; }
.pb { break-after: page; }
.cover { min-height: 245mm; }
`;

function findBrowser() {
  const c = [
    process.env.CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const hit = c.find((p) => existsSync(p));
  if (!hit) throw new Error("No Chrome/Edge found; set CHROME=<path>");
  return hit;
}

// Chrome exits 0 even when it can't overwrite the target (e.g. the PDF is open
// in a viewer), so print to a fresh temp file and copy it over the target.
function printPdf(htmlPath, pdfPath) {
  const tmp = join(dirname(pdfPath), `.tmp-${process.pid}-${Date.now()}.pdf`);
  printTo(htmlPath, tmp);
  if (!existsSync(tmp)) throw new Error(`Chrome produced no PDF for ${htmlPath}`);
  try {
    copyFileSync(tmp, pdfPath);
  } catch (err) {
    throw new Error(`Can't overwrite ${pdfPath} (${err.code}). Close it in any PDF viewer and run again.`);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function printTo(htmlPath, pdfPath) {
  execFileSync(findBrowser(), [
    "--headless=new", "--disable-gpu", "--no-pdf-header-footer", "--no-first-run",
    `--user-data-dir=${join(tmpdir(), "filspay-pdf-profile")}`,
    "--allow-file-access-from-files", "--virtual-time-budget=8000",
    `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href,
  ], { stdio: "inherit" });
}

function build(name, parts, css, wrap = (b) => b) {
  const body = wrap(parts);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${TEAM} FilsPay ${name}</title><style>${css}</style></head><body>${body}</body></html>`;
  // Written next to the sources so relative image paths resolve.
  const htmlPath = join(here, `.${name.toLowerCase()}.html`);
  writeFileSync(htmlPath, html);
  const pdf = resolve(out, `${TEAM}_FilsPay_${name}.pdf`);
  printPdf(htmlPath, pdf);
  console.log("wrote", pdf);
}

const which = process.argv[2] || "all";

if (which === "all" || which === "doc") {
  const missing = [];
  const md = SECTIONS.map((s) => {
    if (s.text) return s.text;
    const p = join(here, s.file);
    if (!existsSync(p)) { if (!s.optional) missing.push(s.file); return ""; }
    const src = readFileSync(p, "utf8").replace(/^\uFEFF/, "");
    const adjusted = adjustHeadings(src, s);
    return s.file === "cover.md" ? `<div class="cover">\n\n${adjusted}\n\n</div>` : adjusted;
  }).join("\n\n");
  if (missing.length) console.warn("missing sections:", missing.join(", "));
  // Raw <div> wrappers pass through as their own lines.
  const html = md.split(/^(<\/?div[^>]*>)$/m).map((chunk) => (/^<\/?div/.test(chunk) ? chunk : mdToHtml(chunk))).join("\n");
  build("Submission", html, DOC_CSS);
}

if (which === "all" || which === "slides") {
  const p = join(here, "slides.html");
  if (existsSync(p)) {
    const pdf = resolve(out, `${TEAM}_FilsPay_Slides.pdf`);
    printPdf(p, pdf);
    console.log("wrote", pdf);
  } else console.warn("slides.html missing");
}
