package settlement

// Refunds must come out of the merchant's payout. A refund debits the
// merchant's payable when it happens; the daily batch then has to pay out
// captures - fees - (refunds - fee reversed), or the platform pays the
// merchant for money already returned to the buyer. CloseBatch read only
// capture events, so refunds were never netted and refunds.settlement_batch_id
// was never set.
//
// A refund is deducted from the first payout that can cover it: if a day's
// refunds exceed its net, the rest stays unbatched and rolls into the next
// day. A payout is never negative and no refund is deducted twice.

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func insertRefund(t *testing.T, pool *pgxpool.Pool, merchantID, txnID uuid.UUID, amount, feeReversed int64, at time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(context.Background(), `
		INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status, acquirer_reference,
		                     reason, created_by_type, created_by_id, occurred_at)
		VALUES ($1, $2, $3, $4, 'succeeded', 'acq_refund_test', 'test', 'merchant_api_key', gen_random_uuid(), $5)
		RETURNING id`, txnID, merchantID, amount, feeReversed, at).Scan(&id)
	if err != nil {
		t.Fatalf("insert refund: %v", err)
	}
	return id
}

func refundBatch(t *testing.T, pool *pgxpool.Pool, refundID uuid.UUID) *uuid.UUID {
	t.Helper()
	var batch *uuid.UUID
	if err := pool.QueryRow(context.Background(), `SELECT settlement_batch_id FROM refunds WHERE id = $1`, refundID).Scan(&batch); err != nil {
		t.Fatalf("read refund batch: %v", err)
	}
	return batch
}

func TestCloseBatchNetsTheDaysRefunds(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	day := time.Date(2026, 6, 2, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(day)
	txnID, _ := insertCaptureEvent(t, pool, merchantID, 250, 10_000, start.Add(time.Hour)) // fee 250
	refundID := insertRefund(t, pool, merchantID, txnID, 4_000, 100, start.Add(3*time.Hour))

	res, err := CloseBatch(ctx, pool, merchantID, day)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if want := int64(10_000 - 250 - (4_000 - 100)); int64(res.NetPayoutFils) != want {
		t.Errorf("net payout = %d, want %d (captures - fee - refund net of fee reversed)", res.NetPayoutFils, want)
	}
	if b := refundBatch(t, pool, refundID); b == nil || *b != res.BatchID {
		t.Errorf("refund not marked as netted into batch %s (got %v)", res.BatchID, b)
	}

	again, err := CloseBatch(ctx, pool, merchantID, day) // idempotent re-run
	if err != nil || again.NetPayoutFils != res.NetPayoutFils {
		t.Errorf("re-run changed the batch: %v / %d vs %d", err, again.NetPayoutFils, res.NetPayoutFils)
	}
}

func TestRefundAfterADayClosedComesOutOfTheNextPayout(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	day1 := time.Date(2026, 6, 3, 0, 0, 0, 0, time.UTC)
	day2 := day1.AddDate(0, 0, 1)
	s1, _ := BusinessDayWindow(day1)
	s2, _ := BusinessDayWindow(day2)

	txn1, _ := insertCaptureEvent(t, pool, merchantID, 250, 10_000, s1.Add(time.Hour))
	if res, err := CloseBatch(ctx, pool, merchantID, day1); err != nil || res.NetPayoutFils != 9_750 {
		t.Fatalf("day 1: %v net %d", err, res.NetPayoutFils)
	}
	insertCaptureEvent(t, pool, merchantID, 250, 2_000, s2.Add(time.Hour)) // fee 50
	refundID := insertRefund(t, pool, merchantID, txn1, 1_000, 25, s2.Add(2*time.Hour))

	res2, err := CloseBatch(ctx, pool, merchantID, day2)
	if err != nil {
		t.Fatalf("day 2: %v", err)
	}
	if want := int64(2_000 - 50 - (1_000 - 25)); int64(res2.NetPayoutFils) != want {
		t.Errorf("day 2 net = %d, want %d", res2.NetPayoutFils, want)
	}
	if b := refundBatch(t, pool, refundID); b == nil || *b != res2.BatchID {
		t.Errorf("refund should be netted into day 2's batch")
	}
}

func TestRefundsLargerThanADaysNetRollForwardAndNeverGoNegative(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	day1 := time.Date(2026, 6, 6, 0, 0, 0, 0, time.UTC)
	day2 := day1.AddDate(0, 0, 1)
	s1, _ := BusinessDayWindow(day1)
	s2, _ := BusinessDayWindow(day2)

	earlierTxn, _ := insertCaptureEvent(t, pool, merchantID, 250, 4_000, s1.Add(-48*time.Hour)) // from an older, separate day
	insertCaptureEvent(t, pool, merchantID, 250, 1_000, s1.Add(time.Hour))                     // day 1: fee 25, net 975
	bigRefund := insertRefund(t, pool, merchantID, earlierTxn, 3_000, 75, s1.Add(2*time.Hour)) // net 2,925 > 975

	res1, err := CloseBatch(ctx, pool, merchantID, day1)
	if err != nil {
		t.Fatalf("day 1: %v", err)
	}
	if res1.NetPayoutFils != 975 {
		t.Errorf("day 1 net = %d, want 975 (the refund does not fit, so it waits)", res1.NetPayoutFils)
	}
	if b := refundBatch(t, pool, bigRefund); b != nil {
		t.Errorf("a refund that did not fit must stay unbatched, got batch %s", b)
	}

	insertCaptureEvent(t, pool, merchantID, 250, 5_000, s2.Add(time.Hour)) // fee 125, net 4,875
	res2, err := CloseBatch(ctx, pool, merchantID, day2)
	if err != nil {
		t.Fatalf("day 2: %v", err)
	}
	if want := int64(4_875 - 2_925); int64(res2.NetPayoutFils) != want {
		t.Errorf("day 2 net = %d, want %d", res2.NetPayoutFils, want)
	}
	if b := refundBatch(t, pool, bigRefund); b == nil || *b != res2.BatchID {
		t.Errorf("the rolled-forward refund should be netted into day 2")
	}
}

func TestMDRRecalculationKeepsRefundsNettedInTheBatch(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	day := time.Date(2026, 6, 10, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(day)
	txnID, _ := insertCaptureEvent(t, pool, merchantID, 250, 10_000, start.Add(time.Hour))
	insertRefund(t, pool, merchantID, txnID, 4_000, 100, start.Add(2*time.Hour))
	res, err := CloseBatch(ctx, pool, merchantID, day)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatal(err)
	}
	if _, err := RecalculateMDR(ctx, pool, merchantID, day, day.AddDate(0, 0, 1)); err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	var fee, net int64
	if err := pool.QueryRow(ctx, `SELECT fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1`, res.BatchID).Scan(&fee, &net); err != nil {
		t.Fatal(err)
	}
	if want := 10_000 - fee - (4_000 - 100); net != want {
		t.Errorf("after recalculation net = %d, want gross - new fee - refunds = %d", net, want)
	}
}
