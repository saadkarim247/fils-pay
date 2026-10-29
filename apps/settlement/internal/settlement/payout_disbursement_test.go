package settlement

// A paid batch has exactly one payout disbursement record and exactly one
// settlement.paid notification (incident 2026-08-21: two merchants got
// settlement.paid twice and two disbursement records each).
//
// ARCHITECTURE: "pay posts payout legs and records disbursement; notify
// enqueues settlement.paid". The disbursement used to be written by the API's
// webhook dispatcher once per delivery row (per endpoint, per replay, per
// duplicate event, and never for a merchant with no endpoint), and the
// notify scan's NOT EXISTS + INSERT let two concurrent runs (daemon + CLI)
// both enqueue.

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
	"github.com/filspay/settlement/internal/splits"
)

func disbursements(t *testing.T, pool *pgxpool.Pool, batchID uuid.UUID) (count int, total int64) {
	t.Helper()
	err := pool.QueryRow(context.Background(),
		`SELECT count(*), COALESCE(SUM(amount_fils), 0) FROM settlement_payout_disbursements WHERE settlement_batch_id = $1`,
		batchID).Scan(&count, &total)
	if err != nil {
		t.Fatalf("count disbursements: %v", err)
	}
	return count, total
}

func closedBatch(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, day time.Time, amount int64) BatchResult {
	t.Helper()
	start, _ := BusinessDayWindow(day)
	insertCaptureEvent(t, pool, merchantID, 250, money.Fils(amount), start.Add(time.Hour))
	res, err := CloseBatch(context.Background(), pool, merchantID, day)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	return res
}

func TestPayoutBatchRecordsExactlyOneDisbursement(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	closed := closedBatch(t, pool, merchantID, time.Date(2026, 4, 13, 0, 0, 0, 0, time.UTC), 20_000)

	if _, err := PayoutBatch(ctx, pool, closed.BatchID); err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}
	if _, err := PayoutBatch(ctx, pool, closed.BatchID); err != nil { // re-run: already paid
		t.Fatalf("PayoutBatch (re-run): %v", err)
	}
	n, total := disbursements(t, pool, closed.BatchID)
	if n != 1 || total != int64(closed.NetPayoutFils) {
		t.Errorf("disbursements = %d totalling %d, want exactly 1 for the net payout %d", n, total, closed.NetPayoutFils)
	}
}

func TestSplitPayoutRecordsExactlyOneDisbursement(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	parent := insertActiveMerchant(t, pool, 250)
	childA := insertActiveMerchant(t, pool, 250)
	childB := insertActiveMerchant(t, pool, 250)
	if _, err := pool.Exec(ctx, `
		INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps)
		VALUES ($1, $2, 6000), ($1, $3, 4000)`, parent, childA, childB); err != nil {
		t.Fatalf("insert split children: %v", err)
	}
	closed := closedBatch(t, pool, parent, time.Date(2026, 4, 14, 0, 0, 0, 0, time.UTC), 30_000)

	if _, err := splits.PayoutSplitBatch(ctx, pool, closed.BatchID); err != nil {
		t.Fatalf("PayoutSplitBatch: %v", err)
	}
	if n, _ := disbursements(t, pool, closed.BatchID); n != 1 {
		t.Errorf("split payout disbursements = %d, want 1", n)
	}
}

func TestConcurrentNotifyRunsEnqueueOneSettlementPaidPerBatch(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	var batchIDs []uuid.UUID
	for i := 0; i < 12; i++ {
		closed := closedBatch(t, pool, merchantID, time.Date(2026, 5, 1+i, 0, 0, 0, 0, time.UTC), 10_000)
		if _, err := PayoutBatch(ctx, pool, closed.BatchID); err != nil {
			t.Fatalf("PayoutBatch: %v", err)
		}
		batchIDs = append(batchIDs, closed.BatchID)
	}

	// The daemon and an operator's CLI run (plus a retry) at the same moment.
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := EnqueuePayoutNotifications(ctx, pool); err != nil {
				t.Errorf("EnqueuePayoutNotifications: %v", err)
			}
		}()
	}
	wg.Wait()

	for _, id := range batchIDs {
		var n int
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM outbox_events WHERE event_type = 'settlement.paid' AND aggregate_id = $1`, id).Scan(&n); err != nil {
			t.Fatalf("count outbox: %v", err)
		}
		if n != 1 {
			t.Errorf("batch %s has %d settlement.paid events, want 1", id, n)
		}
	}
}
