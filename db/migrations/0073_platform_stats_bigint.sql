-- platform_stats.total_processed_fils was INTEGER (max 2,147,483,647 fils,
-- ~2,147,483 BD) while the volume tier starts at 2,000,000,000 fils: the
-- counter overflowed shortly after the platform earned the tier. Money
-- columns are BIGINT fils (ADR-0001). Numbered 0073 because 0054-0056 are
-- reserved for settlement v2 (ADR-0005).
ALTER TABLE platform_stats ALTER COLUMN total_processed_fils TYPE BIGINT;
