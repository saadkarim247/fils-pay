// Package disbursement records the payout-rail instruction for a paid
// settlement batch: exactly one per batch, written by the payout step
// itself (ARCHITECTURE: "pay ... records disbursement").
package disbursement

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Record inserts the batch's disbursement inside the payout transaction,
// which already holds the batch row lock. A batch with nothing to pay out
// gets none; a batch that already has one is left alone.
func Record(ctx context.Context, tx pgx.Tx, batchID uuid.UUID, amountFils int64) error {
	if amountFils <= 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO settlement_payout_disbursements (settlement_batch_id, amount_fils, disbursement_reference)
		SELECT $1, $2, 'disb_' || gen_random_uuid()
		 WHERE NOT EXISTS (SELECT 1 FROM settlement_payout_disbursements WHERE settlement_batch_id = $1)
	`, batchID, amountFils)
	if err != nil {
		return fmt.Errorf("disbursement: record for batch %s: %w", batchID, err)
	}
	return nil
}
