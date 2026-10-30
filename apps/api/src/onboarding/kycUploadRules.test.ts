/**
 * KYC uploads are judged by their bytes, not their names, and images can't
 * be used to exhaust the server.
 *
 * ARCHITECTURE: "KYC uploads are validated by detected content type (magic
 * bytes)". The PDF-only rule for commercial registrations and bank letters
 * checked the FILE NAME, so a phone photo renamed "CR-2026.pdf" was
 * accepted. And thumbnails were generated with sharp's default pixel limit
 * (~268 MP): a tiny, highly compressed image declaring a huge canvas
 * decodes to hundreds of MB (a decompression bomb).
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { createTestHarness } from "../testSupport/fixtures.js";
import { recordKycDocument } from "./kyc.js";
import { generateKycThumbnail } from "./kycThumbnail.js";

const h = createTestHarness({ KYC_UPLOAD_DIR: mkdtempSync(join(tmpdir(), "kyc-rules-")) });

const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
const jpeg = () => sharp({ create: { width: 40, height: 40, channels: 3, background: "#888" } }).jpeg().toBuffer();

function upload(m: { merchantId: string; ownerUserId: string }, documentType: string, fileName: string, buffer: Buffer) {
  return recordKycDocument(h.pool, h.config, {
    merchantId: m.merchantId,
    documentType: documentType as never,
    fileName,
    buffer,
    uploadedBy: m.ownerUserId,
  });
}

test("a photo renamed to .pdf is refused for a commercial registration", async () => {
  const m = await h.merchant({ label: "kyc-rules" });
  await assert.rejects(
    upload(m, "commercial_registration", "CR-2026.pdf", await jpeg()),
    (err: unknown) => (err as { code?: string }).code === "document_must_be_pdf",
  );
});

test("a real PDF is accepted for a bank letter whatever it is named", async () => {
  const m = await h.merchant({ label: "kyc-rules" });
  const res = await upload(m, "bank_letter", "scan_0001", PDF_BYTES);
  assert.equal(res.documentType, "bank_letter");
});

test("an image whose canvas is too large is refused instead of being decoded", async () => {
  // 9000 x 9000 flat PNG: small on disk, ~81 MP once decoded.
  const bomb = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: "#000" } }).png({ compressionLevel: 9 }).toBuffer();
  assert.ok(bomb.length < 1_000_000, `fixture should be small on disk (${bomb.length} bytes)`);
  await assert.rejects(generateKycThumbnail(bomb, "png"));
});

test("a normal photo still gets a thumbnail", async () => {
  const thumb = await generateKycThumbnail(await jpeg(), "jpeg");
  assert.ok(thumb && thumb.buffer.length > 0);
});
