// Minimal PDF image extractor (built-in modules only).
// Usage: node tools/docs/pdf-images.cjs <input.pdf> <outDir> [--dump]
//   --dump  only print object dictionaries, don't write images
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const [, , pdfPath, outDir, flag] = process.argv;
if (!pdfPath || !outDir) {
  console.error("usage: node tools/docs/pdf-images.cjs <input.pdf> <outDir> [--dump]");
  process.exit(2);
}
const buf = fs.readFileSync(pdfPath);
const latin = buf.toString("latin1"); // 1 char == 1 byte, so indices line up

// Collect every "N G obj ... endobj" with its dictionary and (optional) stream.
const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
const objs = new Map();
let m;
while ((m = objRe.exec(latin))) {
  const start = m.index + m[0].length;
  const end = latin.indexOf("endobj", start);
  if (end < 0) break;
  const body = latin.slice(start, end);
  const sIdx = body.search(/\bstream\r?\n/);
  const dict = sIdx >= 0 ? body.slice(0, sIdx) : body;
  let stream = null;
  if (sIdx >= 0) {
    const nl = body.slice(sIdx).match(/^stream\r?\n/)[0].length;
    const dataStart = start + sIdx + nl;
    const esIdx = latin.lastIndexOf("endstream", end);
    stream = { dataStart, dataEndGuess: esIdx };
  }
  objs.set(Number(m[1]), { num: Number(m[1]), dict: dict.trim(), stream });
  objRe.lastIndex = end;
}

const get = (dict, key) => {
  const r = new RegExp("/" + key + "\\s*(\\[[^\\]]*\\]|/[A-Za-z0-9]+|\\d+\\s+\\d+\\s+R|-?\\d+(?:\\.\\d+)?)");
  const x = dict.match(r);
  return x ? x[1].trim() : null;
};
const resolveNum = (v) => {
  if (v == null) return null;
  const ref = v.match(/^(\d+)\s+\d+\s+R$/);
  if (ref) {
    const o = objs.get(Number(ref[1]));
    return o ? Number(o.dict.trim()) : null;
  }
  return Number(v);
};

if (flag === "--dump") {
  for (const o of objs.values()) {
    const d = o.dict.replace(/\s+/g, " ");
    console.log(`obj ${o.num}: ${d.slice(0, 300)}${o.stream ? "  [stream]" : ""}`);
  }
  process.exit(0);
}

// PNG writer for decoded (Flate) raster data.
const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (b) => {
  let c = -1;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const writePng = (file, w, h, channels, raw) => {
  const colorType = { 1: 0, 3: 2, 4: 6 }[channels];
  const rowLen = w * channels;
  const lines = Buffer.alloc((rowLen + 1) * h);
  for (let y = 0; y < h; y++) {
    lines[y * (rowLen + 1)] = 0;
    raw.copy(lines, y * (rowLen + 1) + 1, y * rowLen, y * rowLen + rowLen);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(lines)), chunk("IEND", Buffer.alloc(0)),
  ]));
};

fs.mkdirSync(outDir, { recursive: true });
for (const o of objs.values()) {
  if (!o.stream || !/\/Subtype\s*\/Image/.test(o.dict)) continue;
  const len = resolveNum(get(o.dict, "Length"));
  const data = buf.subarray(o.stream.dataStart, o.stream.dataStart + (len ?? (o.stream.dataEndGuess - o.stream.dataStart)));
  const filter = get(o.dict, "Filter") || "(none)";
  const w = resolveNum(get(o.dict, "Width"));
  const h = resolveNum(get(o.dict, "Height"));
  const cs = get(o.dict, "ColorSpace") || "?";
  const bpc = resolveNum(get(o.dict, "BitsPerComponent"));
  let out = null;
  if (/DCTDecode/.test(filter)) {
    out = path.join(outDir, `obj${o.num}.jpg`);
    fs.writeFileSync(out, data);
  } else if (/JPXDecode/.test(filter)) {
    out = path.join(outDir, `obj${o.num}.jp2`);
    fs.writeFileSync(out, data);
  } else if (/FlateDecode/.test(filter) && bpc === 8) {
    const raw = zlib.inflateSync(data);
    const channels = /RGB/.test(cs) ? 3 : /CMYK/.test(cs) ? 4 : 1;
    out = path.join(outDir, `obj${o.num}.png`);
    writePng(out, w, h, channels, raw);
  }
  console.log(`obj ${o.num}: ${w}x${h} cs=${cs} bpc=${bpc} filter=${filter} bytes=${data.length} -> ${out ?? "(skipped)"}`);
}
