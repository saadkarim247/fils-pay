package settlement

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// loadSplitParents returns every merchant with configured split children,
// the same rule as splits.IsSplitParent, in one query.
func loadSplitParents(ctx context.Context, db *pgxpool.Pool) (map[uuid.UUID]bool, error) {
	rows, err := db.Query(ctx, `SELECT DISTINCT parent_merchant_id FROM merchant_split_children`)
	if err != nil {
		return nil, fmt.Errorf("settlement: RunDailyBatch: load split parents: %w", err)
	}
	defer rows.Close()
	parents := map[uuid.UUID]bool{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("settlement: RunDailyBatch: scan split parent: %w", err)
		}
		parents[id] = true
	}
	return parents, rows.Err()
}

// closeAndPayIdleMerchants writes, set-based, the zero batch that CloseBatch
// followed by PayoutBatch would write for each merchant that has nothing to
// settle on businessDate, and returns merchant -> batch for those it wrote.
//
// "Nothing to settle": eligible (active, not test mode), not a split parent,
// no batch yet for the day, no unbatched capture events in the day's window
// and no unbatched succeeded refund before its end. The window has already
// closed (RunDailyBatch checks), so this can't change under us. Anyone else
// takes the normal per-merchant path, which is unchanged.
//
// What the per-merchant path leaves for such a merchant, and what this
// writes: a 'paid' batch with zero totals and closed_at/paid_at set; one
// settlement.batch_closed outbox event with the same payload; the balance
// cache pointing at the batch (its value changes by +0 then -0). No ledger
// legs, disbursement or settlement.paid (all skipped for a zero payout).
// The +0 updates to platform_stats and the lifetime estimate are skipped.
func closeAndPayIdleMerchants(ctx context.Context, db *pgxpool.Pool, merchantIDs []uuid.UUID, businessDate time.Time) (map[uuid.UUID]uuid.UUID, error) {
	start, end := BusinessDayWindow(businessDate)
	batchDate := time.Date(businessDate.Year(), businessDate.Month(), businessDate.Day(), 0, 0, 0, 0, time.UTC)

	rows, err := db.Query(ctx, `
		WITH idle AS (
		  SELECT m.id
		    FROM merchants m
		   WHERE m.id = ANY($1) AND m.status = 'active' AND m.test_mode = false
		     AND NOT EXISTS (SELECT 1 FROM merchant_split_children s WHERE s.parent_merchant_id = m.id)
		     AND NOT EXISTS (SELECT 1 FROM settlement_batches b WHERE b.merchant_id = m.id AND b.batch_date = $2)
		     AND NOT EXISTS (
		           SELECT 1 FROM transaction_events te JOIN transactions t ON t.id = te.transaction_id
		            WHERE t.merchant_id = m.id AND te.event_type IN ('captured', 'partially_captured')
		              AND te.settlement_batch_id IS NULL AND te.occurred_at >= $3 AND te.occurred_at < $4)
		     AND NOT EXISTS (
		           SELECT 1 FROM refunds r
		            WHERE r.merchant_id = m.id AND r.status = 'succeeded'
		              AND r.settlement_batch_id IS NULL AND r.occurred_at < $4)
		),
		new_batches AS (
		  INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at, paid_at)
		  SELECT id, $2, 'paid', 0, 0, 0, now(), now() FROM idle
		  ON CONFLICT (merchant_id, batch_date) DO NOTHING
		  RETURNING id, merchant_id
		),
		closed_events AS (
		  INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
		  SELECT 'settlement.batch_closed', 'settlement_batch', b.id,
		         jsonb_build_object('merchantId', b.merchant_id::text, 'batchId', b.id::text,
		                            'batchDate', to_char($2::date, 'YYYY-MM-DD'),
		                            'grossFils', 0, 'feeFils', 0, 'netPayoutFils', 0)
		    FROM new_batches b
		),
		cache AS (
		  INSERT INTO merchant_balances (merchant_id, cached_payable_fils, last_settlement_batch_id, updated_at)
		  SELECT merchant_id, 0, id, now() FROM new_batches
		  ON CONFLICT (merchant_id) DO UPDATE
		    SET last_settlement_batch_id = EXCLUDED.last_settlement_batch_id, updated_at = now()
		)
		SELECT merchant_id, id FROM new_batches
	`, merchantIDs, batchDate, start, end)
	if err != nil {
		return nil, fmt.Errorf("settlement: RunDailyBatch: close idle merchants: %w", err)
	}
	defer rows.Close()
	written := map[uuid.UUID]uuid.UUID{}
	for rows.Next() {
		var merchantID, batchID uuid.UUID
		if err := rows.Scan(&merchantID, &batchID); err != nil {
			return nil, fmt.Errorf("settlement: RunDailyBatch: scan idle batch: %w", err)
		}
		written[merchantID] = batchID
	}
	return written, rows.Err()
}
