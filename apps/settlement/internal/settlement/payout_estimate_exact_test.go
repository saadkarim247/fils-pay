package settlement

import (
	"context"
	"fmt"
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// Bug 57: the lifetime payout figure was float32 / REAL, which cannot hold
// every fil above 2^24 (16,777.216 BD). A high-volume merchant's total
// stopped moving for small payouts and drifted from the real sum.
func TestUpdateLifetimePayoutMonitoringEstimate_ExactAboveFloat32Range(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// 19,580,120 fils is the Delta Wholesale 14 Sep net payout.
	payouts := []money.Fils{19_580_120, 1, 1, 1, 7, 3_000_000_001}
	var want int64
	for _, net := range payouts {
		want += int64(net)
		if err := UpdateLifetimePayoutMonitoringEstimate(ctx, tx, merchantID, net); err != nil {
			t.Fatalf("UpdateLifetimePayoutMonitoringEstimate(%d): %v", net, err)
		}
	}

	var got string
	if err := tx.QueryRow(ctx, `
		SELECT lifetime_net_payout_monitoring_estimate::text FROM merchants WHERE id = $1
	`, merchantID).Scan(&got); err != nil {
		t.Fatalf("read back estimate: %v", err)
	}
	if got != fmt.Sprint(want) {
		t.Fatalf("lifetime estimate = %s, want exactly %d (the sum of every payout)", got, want)
	}
}

func TestEstimateMonthlyPayout_ExactAboveFloat32Range(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	for i, net := range []int64{19_580_120, 1, 1, 1} {
		if _, err := tx.Exec(ctx, `
			INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at)
			VALUES ($1, (now() - make_interval(days => $2))::date, 'paid', $3, 0, $3, now() - make_interval(days => $2))
		`, merchantID, i+1, net); err != nil {
			t.Fatalf("insert batch: %v", err)
		}
	}

	got, err := EstimateMonthlyPayout(ctx, tx, merchantID)
	if err != nil {
		t.Fatalf("EstimateMonthlyPayout: %v", err)
	}
	if int64(got) != 19_580_123 {
		t.Fatalf("monthly estimate = %v, want exactly 19580123", got)
	}
}
