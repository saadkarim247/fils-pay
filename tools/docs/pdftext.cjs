// Rough PDF probe: counts pages/images, inflates content streams and prints text shown by Tj/TJ.
// Usage: node tools/docs/pdftext.cjs <file.pdf>
const fs = require("fs"), zlib = require("zlib");
const buf = fs.readFileSync(process.argv[2]); const s = buf.toString("latin1");
console.log("pages:", (s.match(/\/Type\s*\/Page[^s]/g) || []).length, "images:", (s.match(/\/Subtype\s*\/Image/g) || []).length, "fonts:", (s.match(/\/Type\s*\/Font/g) || []).length);
const re = /stream\r?\n/g; let m, out = [];
while ((m = re.exec(s))) {
  const start = m.index + m[0].length, end = s.indexOf("endstream", start);
  const dict = s.slice(Math.max(0, m.index - 300), m.index);
  if (!/FlateDecode/.test(dict.slice(dict.lastIndexOf("<<")))) continue;
  try {
    const t = zlib.inflateSync(buf.subarray(start, end)).toString("latin1");
    if (/T[jJ]/.test(t)) out.push(t);
  } catch {}
}
console.log("text streams:", out.length);
const txt = out.map(t => [...t.matchAll(/\[(.*?)\]\s*TJ|\((.*?)\)\s*Tj/gs)].map(x => (x[1] ? [...x[1].matchAll(/\(((?:\.|[^\)])*)\)/g)].map(y => y[1]).join("") : x[2])).join(" ")).join("\n---\n");
console.log(txt.slice(0, 400));
