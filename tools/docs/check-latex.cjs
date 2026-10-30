// Static sanity checks for generated LaTeX (no TeX engine available locally).
// Usage: node tools/docs/check-latex.cjs <file.tex>
"use strict";
const fs = require("fs");

const file = process.argv[2];
const src = fs.readFileSync(file, "utf8");
const lines = src.split(/\r?\n/);
const errors = [];

// 1. Brace balance per line-joined document, ignoring escaped braces.
let depth = 0;
lines.forEach((line, i) => {
  const cleaned = line.replace(/\\\\/g, "").replace(/\\[{}]/g, "");
  for (const ch of cleaned) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth < 0) { errors.push(`line ${i + 1}: unmatched }`); depth = 0; }
  }
});
if (depth !== 0) errors.push(`document ends with ${depth} unclosed {`);

// 2. \begin / \end nesting.
const stack = [];
const envRe = /\\(begin|end)\{([^}]+)\}/g;
lines.forEach((line, i) => {
  let m;
  while ((m = envRe.exec(line))) {
    if (m[1] === "begin") stack.push([m[2], i + 1]);
    else {
      const top = stack.pop();
      if (!top || top[0] !== m[2]) errors.push(`line ${i + 1}: \\end{${m[2]}} does not match ${top ? `\\begin{${top[0]}} (line ${top[1]})` : "anything"}`);
    }
  }
});
for (const [env, at] of stack) errors.push(`unclosed \\begin{${env}} at line ${at}`);

// 3. Raw specials in the body (after \begin{document}): unescaped % _ # outside the preamble.
const bodyStart = lines.findIndex((l) => l.startsWith("\\begin{document}"));
lines.slice(bodyStart + 1).forEach((line, k) => {
  const i = bodyStart + 2 + k;
  const stripped = line.replace(/\\\\/g, "");
  if (/(^|[^\\])%/.test(stripped)) errors.push(`line ${i}: unescaped %`);
  if (/(^|[^\\])_/.test(stripped)) errors.push(`line ${i}: unescaped _`);
  if (/(^|[^\\])#/.test(stripped)) errors.push(`line ${i}: unescaped #`);
  const dollars = (stripped.replace(/\\\$/g, "").match(/\$/g) ?? []).length;
  if (dollars % 2 !== 0) errors.push(`line ${i}: odd number of $ (math mode left open)`);
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(line)) errors.push(`line ${i}: non-ASCII character`);
});

console.log(`${file}: ${lines.length} lines, ${errors.length} problem(s)`);
for (const e of errors.slice(0, 40)) console.log(`  ${e}`);
process.exitCode = errors.length ? 1 : 0;
