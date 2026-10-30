package settlement

// End to end: a split payout pays the sub-merchants exactly the batch's net
// payout, and a configuration whose weights don't add up to 100% is refused
// instead of being paid out wrong.

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/filspay/settlement/internal/splits"
)

func TestSplitPayoutPaysExactlyTheNet(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	parent := insertActiveMerchant(t, pool, 0) // no fee, so net = 1,001
	var children []uuid.UUID
	for _, w := range []int64{3333, 3333, 3334} {
		c := insertActiveMerchant(t, pool, 0)
		children = append(children, c)
		if _, err := pool.Exec(ctx, `INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps) VALUES ($1, $2, $3)`, parent, c, w); err != nil {
			t.Fatal(err)
		}
	}
	day := time.Date(2026, 6, 15, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(day)
	insertCaptureEvent(t, pool, parent, 0, 1_001, start.Add(time.Hour))
	closed, err := CloseBatch(ctx, pool, parent, day)
	if err != nil || closed.NetPayoutFils != 1_001 {
		t.Fatalf("CloseBatch: %v net %d", err, closed.NetPayoutFils)
	}

	if _, err := splits.PayoutSplitBatch(ctx, pool, closed.BatchID); err != nil {
		t.Fatalf("PayoutSplitBatch: %v", err)
	}
	var allocated, legs int64
	if err := pool.QueryRow(ctx, `SELECT COALESCE(SUM(allocated_fils), 0) FROM settlement_batch_splits WHERE settlement_batch_id = $1`, closed.BatchID).Scan(&allocated); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COALESCE(SUM(amount_fils), 0) FROM ledger_entries WHERE settlement_batch_id = $1 AND account_id = 'platform_cash' AND direction = 'credit'`, closed.BatchID).Scan(&legs); err != nil {
		t.Fatal(err)
	}
	if allocated != 1_001 || legs != 1_001 {
		t.Errorf("split allocations = %d, payout legs = %d, want both exactly 1,001", allocated, legs)
	}
}

func TestSplitPayoutRefusesWeightsThatDoNotAddUpTo100Percent(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	parent := insertActiveMerchant(t, pool, 0)
	for _, w := range []int64{6000, 3000} { // 90%
		c := insertActiveMerchant(t, pool, 0)
		if _, err := pool.Exec(ctx, `INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps) VALUES ($1, $2, $3)`, parent, c, w); err != nil {
			t.Fatal(err)
		}
	}
	day := time.Date(2026, 6, 16, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(day)
	insertCaptureEvent(t, pool, parent, 0, 10_000, start.Add(time.Hour))
	closed, err := CloseBatch(ctx, pool, parent, day)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := splits.PayoutSplitBatch(ctx, pool, closed.BatchID); err == nil {
		t.Fatal("PayoutSplitBatch with 90% of weights configured: err = nil, want a refusal")
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM settlement_batches WHERE id = $1`, closed.BatchID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "closed" {
		t.Errorf("batch status = %q, want it left closed (unpaid)", status)
	}
}

// One misconfigured marketplace must not stop everyone else's payouts.
func TestDailyRunPaysOthersWhenOneSplitIsMisconfigured(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	day := time.Date(2026, 6, 17, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(day)

	badParent := insertActiveMerchant(t, pool, 0)
	child := insertActiveMerchant(t, pool, 0)
	if _, err := pool.Exec(ctx, `INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps) VALUES ($1, $2, 5000)`, badParent, child); err != nil {
		t.Fatal(err)
	}
	insertCaptureEvent(t, pool, badParent, 0, 4_000, start.Add(time.Hour))
	normal := insertActiveMerchant(t, pool, 0)
	insertCaptureEvent(t, pool, normal, 0, 7_000, start.Add(time.Hour))

	if _, err := RunDailyBatch(ctx, pool, day, nil); err != nil {
		t.Fatalf("RunDailyBatch: %v (one bad split must not fail the whole run)", err)
	}
	statusOf := func(m uuid.UUID) string {
		var s string
		if err := pool.QueryRow(ctx, `SELECT status FROM settlement_batches WHERE merchant_id = $1 AND batch_date = $2`, m, day).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	if s := statusOf(normal); s != "paid" {
		t.Errorf("normal merchant's batch = %q, want paid", s)
	}
	if s := statusOf(badParent); s != "closed" {
		t.Errorf("misconfigured marketplace's batch = %q, want left closed", s)
	}
}
