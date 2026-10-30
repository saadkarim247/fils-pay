// Narrative puzzle helper (2nd transmission, commit 8022020). Usage: node tools/puzzle/vigenere.js
// Vigenère decrypt: try candidate keys, then a per-column frequency attack for a 5-letter key.
"use strict";
const CT = "WPJPW HXJWD HIAJK DVTYW LVJAW UGHTE PQYMW UMBWA WMXKA QLNYJ RBYMA UBJJF".replace(/\s+/g, "");
const dec = (key) =>
  [...CT].map((c, i) => String.fromCharCode(((c.charCodeAt(0) - 65 - (key.charCodeAt(i % key.length) - 97) + 26) % 26) + 65)).join("");

// English letter frequencies (A..Z) for scoring.
const F = [8.2,1.5,2.8,4.3,12.7,2.2,2.0,6.1,7.0,0.15,0.77,4.0,2.4,6.7,7.5,1.9,0.095,6.0,6.3,9.1,2.8,0.98,2.4,0.15,2.0,0.074];
const score = (s) => [...s].reduce((a, c) => a + Math.log(F[c.charCodeAt(0) - 65]), 0);

const candidates = ["diffs", "money", "truth", "audit", "tests", "codes", "order", "rules", "fixes", "patch", "diff", "thediff", "yousif", "reader", "claude", "model"];
console.log("== candidate keys");
for (const k of candidates) console.log(k.padEnd(8), score(dec(k)).toFixed(1).padStart(7), dec(k));

// Per-column best shift for key length 5.
const keyLen = 5;
let key = "";
for (let col = 0; col < keyLen; col++) {
  let best = { s: -Infinity, k: 0 };
  for (let k = 0; k < 26; k++) {
    let s = 0;
    for (let i = col; i < CT.length; i += keyLen) s += Math.log(F[(CT.charCodeAt(i) - 65 - k + 26) % 26]);
    if (s > best.s) best = { s, k };
  }
  key += String.fromCharCode(97 + best.k);
}
console.log("== frequency-attack key:", key, "->", dec(key));
