package settlement

// A business day can only be closed once it has ended. Closing today froze
// the batch early, and every capture later that day was never batched,
// because re-running a closed day is a no-op (ADMIN.md calls re-running
// "always safe"). The daemon only closes yesterday; the CLI, console and
// internal API accepted any date.

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestCloseBatchRefusesABusinessDayThatHasNotEnded(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	today := BusinessDateOf(time.Now())
	start, _ := BusinessDayWindow(today)
	insertCaptureEvent(t, pool, merchantID, 250, 5_000, start.Add(time.Minute))

	_, err := CloseBatch(ctx, pool, merchantID, today)
	if !errors.Is(err, ErrBusinessDayNotEnded) {
		t.Fatalf("CloseBatch(today) err = %v, want ErrBusinessDayNotEnded", err)
	}
	var batches, unbatched int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM settlement_batches WHERE merchant_id = $1`, merchantID).Scan(&batches); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM transaction_events te JOIN transactions t ON t.id = te.transaction_id
		 WHERE t.merchant_id = $1 AND te.settlement_batch_id IS NULL`, merchantID).Scan(&unbatched); err != nil {
		t.Fatal(err)
	}
	if batches != 0 || unbatched != 1 {
		t.Errorf("after refusing: %d batches, %d unbatched events; want 0 and 1", batches, unbatched)
	}
}

func TestRunDailyBatchRefusesTodayButClosesYesterday(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	today := BusinessDateOf(time.Now())
	if _, err := RunDailyBatch(ctx, pool, today, nil); !errors.Is(err, ErrBusinessDayNotEnded) {
		t.Fatalf("RunDailyBatch(today) err = %v, want ErrBusinessDayNotEnded", err)
	}

	merchantID := insertActiveMerchant(t, pool, 250)
	yesterday := today.AddDate(0, 0, -1)
	if _, err := RunDailyBatch(ctx, pool, yesterday, &merchantID); err != nil {
		t.Fatalf("RunDailyBatch(yesterday): %v", err)
	}
}
