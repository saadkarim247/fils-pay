# 19 · The platform volume discount switches itself off (32-bit overflow)

**Severity:** High (every merchant overcharged 0.15% once it triggers) · **Area:** `db/migrations/0049_platform_stats.sql`, `apps/settlement/internal/settlement/platform_volume.go`, `apps/api/src/fees/platformVolumeTier.ts`

**What's wrong.** Once the platform has processed 2,000,000 BD in total,
every merchant gets 15 bps off their rate (the volume tier). The running
total is a 32-bit integer, so about 147,000 BD after the tier is reached
the counter wraps to a large negative number. The discount then silently
disappears for everyone.

**Why it's wrong.**
- `platform_stats.total_processed_fils` is `INTEGER`: at most
  2,147,483,647 fils, about 2,147,483 BD. The tier threshold is
  2,000,000,000 fils, uncomfortably close.
- The Go settlement code adds to it in `int32`
  (`current + int32(batchGrossFils)`), which wraps without any error.
- ADR-0001 says money is `BIGINT` fils.
- Two planted comments cover this up: "INTEGER in PostgreSQL is 64-bit on
  64-bit builds" (false; it's always 32-bit) and "total_processed_fils is
  BIGINT" (false).

**Spread / what it breaks.**
- After the wrap, every capture and every batch is priced 15 bps higher,
  for every merchant, with nothing in the logs.
- The counter is also wrong for any reporting built on it.
- The capture side would have broken too: the column can't even hold
  2,500,000,000.

**Fix (small, three parts).**
- New migration `0073_platform_stats_bigint.sql` widens the column to
  `BIGINT`. It is numbered 0073 because ADR-0005 reserves 0054–0056.
- Go: the counter is `int64` in its read, write and tier check.
- TypeScript: the BIGINT arrives as text, so it is converted with
  `Number()`, which is exact up to 2^53.

**Tests.**
- New file `internal/settlement/platform_volume_overflow_test.go`. It sets
  the counter to 2,100,000,000, runs a real 100,000 BD `CloseBatch`, and
  expects 2,200,000,000 with the 15 bps tier still on.
- New file `apps/api/src/fees/platformVolumeOverflow.test.ts`. At
  2,500,000,000 fils, capture's tier check still returns 15 bps.

Before the fix, the Go counter became −2,094,967,296 and the TypeScript
setup failed with "integer out of range". After it, both pass. Full suite
(fresh database, including the migration-chain test): no new failures. The
running stack's database is migrated too.
