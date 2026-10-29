package settlement

// MDR recalculation must never rewrite a batch that has already been paid.
// A paid batch's fee_fils / net_payout_fils are the record of money already
// sent; BatchAdjustment's own contract says "the original batch's figures
// stay as they were paid". Delta Marketplace, 11 Sep: a recalculation
// rewrote 9 paid batches (-41.870 BD) so the records no longer matched the
// payouts. Closed-but-unpaid batches are still recalculated (that is the
// tool's job: the new net is what will be paid).

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type batchFigures struct {
	status         string
	fee, net       int64
	adjustmentLegs int
}

func figuresOf(t *testing.T, pool *pgxpool.Pool, batchID uuid.UUID) batchFigures {
	t.Helper()
	var f batchFigures
	err := pool.QueryRow(context.Background(), `
		SELECT sb.status, sb.fee_fils, sb.net_payout_fils,
		       (SELECT count(*) FROM ledger_entries le
		         WHERE le.settlement_batch_id = sb.id AND le.description = 'MDR recalculation adjustment')
		  FROM settlement_batches sb WHERE sb.id = $1`, batchID).Scan(&f.status, &f.fee, &f.net, &f.adjustmentLegs)
	if err != nil {
		t.Fatalf("read batch %s: %v", batchID, err)
	}
	return f
}

func TestRecalculateMDR_LeavesPaidBatchesExactlyAsPaid(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)

	paidDay := time.Date(2026, 4, 6, 0, 0, 0, 0, time.UTC)
	unpaidDay := paidDay.AddDate(0, 0, 1)
	for _, day := range []time.Time{paidDay, unpaidDay} {
		start, _ := BusinessDayWindow(day)
		insertCaptureEvent(t, pool, merchantID, 250, 40_000, start.Add(time.Hour))
	}
	paid, err := CloseBatch(ctx, pool, merchantID, paidDay)
	if err != nil {
		t.Fatalf("CloseBatch(paid day): %v", err)
	}
	if _, err := PayoutBatch(ctx, pool, paid.BatchID); err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}
	unpaid, err := CloseBatch(ctx, pool, merchantID, unpaidDay)
	if err != nil {
		t.Fatalf("CloseBatch(unpaid day): %v", err)
	}
	paidBefore := figuresOf(t, pool, paid.BatchID)
	if paidBefore.status != "paid" {
		t.Fatalf("setup: paid batch status = %q", paidBefore.status)
	}

	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("update mdr_bps: %v", err)
	}
	result, err := RecalculateMDR(ctx, pool, merchantID, paidDay, unpaidDay.AddDate(0, 0, 1))
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}

	if got := figuresOf(t, pool, paid.BatchID); got != paidBefore {
		t.Errorf("paid batch changed: before %+v, after %+v", paidBefore, got)
	}
	for _, adj := range result.Adjusted {
		if adj.BatchID == paid.BatchID {
			t.Errorf("paid batch %s reported as adjusted", paid.BatchID)
		}
	}

	// The unpaid batch is still recalculated: that is what the tool is for.
	got := figuresOf(t, pool, unpaid.BatchID)
	wantFee := int64(ComputeSettlementFee(40_000, 300, 0))
	if got.fee != wantFee || got.net != int64(unpaid.GrossFils)-wantFee {
		t.Errorf("unpaid batch: fee %d net %d, want fee %d net %d", got.fee, got.net, wantFee, int64(unpaid.GrossFils)-wantFee)
	}
	if got.adjustmentLegs != 2 {
		t.Errorf("unpaid batch adjustment legs = %d, want 2", got.adjustmentLegs)
	}
}
