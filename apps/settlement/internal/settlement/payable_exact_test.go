package settlement

// The net payout must be exactly gross minus fee, in whole fils, at every
// size (ADR-0001: integer fils, no floats). float32 holds only 24 bits of
// mantissa, so above ~16,777 BD it cannot represent every fil and payouts
// come out 1-2 fils off (Delta Wholesale, 14 Sep: gross 20,000.123 BD, fee
// 420.003 BD, paid 19,580.119 instead of 19,580.120).

import (
	"context"
	"testing"
	"time"

	"github.com/filspay/settlement/internal/money"
)

func TestNetPayableFilsIsExactSubtraction(t *testing.T) {
	cases := []struct {
		name       string
		gross, fee money.Fils
	}{
		{"small batch", 13_333, 333},
		{"Delta Wholesale 14 Sep", 20_000_123, 420_003},
		{"just above float32's exact range", 16_777_217, 1},
		{"150,000 BD batch", 150_000_001, 3_000_000},
		{"10 million BD", 10_000_000_007, 210_000_000},
	}
	for _, c := range cases {
		if got, want := NetPayableFils(c.gross, c.fee), c.gross-c.fee; got != want {
			t.Errorf("%s: NetPayableFils(%d, %d) = %d, want %d (off by %d fils)", c.name, c.gross, c.fee, got, want, got-want)
		}
	}
}

func TestNetPayableFilsExactAcrossARangeOfSizes(t *testing.T) {
	for gross := money.Fils(16_000_000); gross < 40_000_000; gross += 7_919 {
		fee := gross / 47
		if got := NetPayableFils(gross, fee); got != gross-fee {
			t.Fatalf("NetPayableFils(%d, %d) = %d, want %d", gross, fee, got, gross-fee)
		}
	}
}

// End to end: a real CloseBatch over a 20,000.123 BD day stores a payout
// that is exactly the batch's own gross minus its own fee.
func TestCloseBatchLargeDayPaysExactlyGrossMinusFee(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 210
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 3, 24, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, mdrBps, 20_000_123, start.Add(2*time.Hour))

	result, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	var gross, fee, net int64
	err = pool.QueryRow(context.Background(),
		`SELECT gross_fils, fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1`, result.BatchID,
	).Scan(&gross, &fee, &net)
	if err != nil {
		t.Fatalf("query settlement_batches: %v", err)
	}
	if net != gross-fee {
		t.Errorf("net_payout_fils = %d, want gross %d - fee %d = %d (off by %d fils)", net, gross, fee, gross-fee, net-(gross-fee))
	}
}
