package ledger

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// RefreshBalanceCache is the console's "Rebuild cached balances": it
// recomputes every merchant's cached balance and overwrites merchant_balances
// in one transaction.
//
// The figure is the same one the CLI's ledger rebuild produces (the merchant's
// merchant_payable net in ledger_entries), so the two paths agree, as ADR-0004
// requires. It used to read merchant_payable_position (the gross of every
// scheme line ever exported, with no fees, refunds, payouts or credits), which
// can never agree with the ledger (FP-203). It stays a fast path for an HTTP
// button: one grouped read of the ledger and one bulk upsert, instead of a
// query per merchant.
func RefreshBalanceCache(ctx context.Context, db *pgxpool.Pool) (map[uuid.UUID]RebuildDiff, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("ledger: RefreshBalanceCache: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	before := map[uuid.UUID]int64{}
	rows, err := tx.Query(ctx, `SELECT merchant_id, cached_payable_fils FROM merchant_balances FOR UPDATE`)
	if err != nil {
		return nil, fmt.Errorf("ledger: RefreshBalanceCache: read cache: %w", err)
	}
	for rows.Next() {
		var id uuid.UUID
		var v int64
		if err := rows.Scan(&id, &v); err != nil {
			rows.Close()
			return nil, fmt.Errorf("ledger: RefreshBalanceCache: scan cache: %w", err)
		}
		before[id] = v
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ledger: RefreshBalanceCache: iterate cache: %w", err)
	}

	rebuilt := map[uuid.UUID]int64{}
	rows, err = tx.Query(ctx, `
		SELECT merchant_id, SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END)
		  FROM ledger_entries
		 WHERE account_id = 'merchant_payable'
		 GROUP BY merchant_id
	`)
	if err != nil {
		return nil, fmt.Errorf("ledger: RefreshBalanceCache: aggregate ledger: %w", err)
	}
	for rows.Next() {
		var id uuid.UUID
		var v int64
		if err := rows.Scan(&id, &v); err != nil {
			rows.Close()
			return nil, fmt.Errorf("ledger: RefreshBalanceCache: scan ledger total: %w", err)
		}
		rebuilt[id] = v
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ledger: RefreshBalanceCache: iterate ledger totals: %w", err)
	}

	// A cached merchant with no ledger rows has a true balance of zero.
	for id := range before {
		if _, ok := rebuilt[id]; !ok {
			rebuilt[id] = 0
		}
	}

	ids := make([]uuid.UUID, 0, len(rebuilt))
	values := make([]int64, 0, len(rebuilt))
	diffs := make(map[uuid.UUID]RebuildDiff, len(rebuilt))
	for id, v := range rebuilt {
		ids = append(ids, id)
		values = append(values, v)
		diffs[id] = RebuildDiff{MerchantID: id, CachedBefore: money.Fils(before[id]), Rebuilt: money.Fils(v)}
	}

	if len(ids) > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
			SELECT id, v, now() FROM unnest($1::uuid[], $2::bigint[]) AS t(id, v)
			ON CONFLICT (merchant_id) DO UPDATE
			  SET cached_payable_fils = EXCLUDED.cached_payable_fils, updated_at = now()
		`, ids, values); err != nil {
			return nil, fmt.Errorf("ledger: RefreshBalanceCache: write rebuilt balances: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("ledger: RefreshBalanceCache: commit: %w", err)
	}
	return diffs, nil
}
