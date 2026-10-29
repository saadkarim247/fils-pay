package settlement

// Settlement must resolve the same fee rate capture does. When two
// fee_schedules rows share an effective_from (a same-day correction), the
// later-entered row wins: capture's query orders by effective_from DESC,
// created_at DESC. Settlement ordered by effective_from alone, so the winner
// depended on physical row order.

import (
	"context"
	"testing"
	"time"
)

func TestEffectiveRateTieGoesToLaterEnteredRow(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)

	effective := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	// The correction (entered later) is inserted FIRST, so physical order
	// disagrees with entry order.
	if _, err := pool.Exec(ctx, `
		INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from, created_at) VALUES
		  ($1, 210, $2, '2026-09-02T00:00:00Z'),
		  ($1, 230, $2, '2026-09-01T00:00:00Z')`, merchantID, effective); err != nil {
		t.Fatalf("insert schedules: %v", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	schedules, err := LoadFeeSchedules(ctx, tx, merchantID)
	if err != nil {
		t.Fatalf("LoadFeeSchedules: %v", err)
	}
	if got := EffectiveMdrBpsAt(schedules, effective.Add(12*time.Hour), 250); got != 210 {
		t.Errorf("rate on 1 Sep = %d bps, want 210 (the later-entered correction, as capture charges)", got)
	}
}
