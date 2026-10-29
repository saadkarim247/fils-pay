package settlement

// The platform-wide processed-volume counter must keep counting past
// 2^31 fils (~2,147,483 BD). The volume tier starts at 2,000,000,000 fils,
// so with an int32 counter the platform earns the 15 bps bonus and then,
// ~147,000 BD later, the counter wraps negative and the bonus silently
// switches off for every merchant.

import (
	"context"
	"testing"
	"time"
)

func TestPlatformVolumeCounterKeepsCountingPastInt32(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	var original int64
	if err := pool.QueryRow(ctx, `SELECT total_processed_fils FROM platform_stats WHERE id = 1`).Scan(&original); err != nil {
		t.Fatalf("read counter: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `UPDATE platform_stats SET total_processed_fils = $1 WHERE id = 1`, original)
	})
	if _, err := pool.Exec(ctx, `UPDATE platform_stats SET total_processed_fils = 2100000000 WHERE id = 1`); err != nil {
		t.Fatalf("set counter: %v", err)
	}

	merchantID := insertActiveMerchant(t, pool, 250)
	day := time.Date(2026, 4, 9, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(day)
	insertCaptureEvent(t, pool, merchantID, 250, 100_000_000, start.Add(time.Hour)) // a 100,000 BD day
	if _, err := CloseBatch(ctx, pool, merchantID, day); err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	var after int64
	if err := pool.QueryRow(ctx, `SELECT total_processed_fils FROM platform_stats WHERE id = 1`).Scan(&after); err != nil {
		t.Fatalf("read counter after close: %v", err)
	}
	if after != 2_200_000_000 {
		t.Errorf("counter after a 100,000 BD batch = %d, want 2200000000", after)
	}
	if bonus := VolumeTierMdrBonusBps(after); bonus != 15 {
		t.Errorf("tier bonus at %d fils = %d bps, want 15 (the platform is past the tier)", after, bonus)
	}
}
