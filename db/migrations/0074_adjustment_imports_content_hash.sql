-- One adjustment import per distinct content. Every import posts real
-- ledger legs, and nothing stopped the same sheet being applied twice
-- (2026-09-04: aug-adjustments-v3-FINAL.csv, twice, 22 s apart).
-- content_sha256 fingerprints the normalised rows; NULL for imports made
-- before this migration. Numbered past 0054-0056 (reserved, ADR-0005).
ALTER TABLE adjustment_imports ADD COLUMN content_sha256 TEXT;
CREATE UNIQUE INDEX adjustment_imports_content_sha256_key
    ON adjustment_imports (content_sha256) WHERE content_sha256 IS NOT NULL;
