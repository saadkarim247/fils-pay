package ledger

// The console's "Rebuild cached balances" must produce the same figure as
// the CLI's ledger rebuild (FP-203; ADR-0004: "they agree whenever the cache
// is consistent"). It overwrote merchant_balances with
// merchant_payable_position: the gross of every scheme line ever exported,
// with no fees, refunds, payouts or credits (Alpha Retail: 135K -> 7K).

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func postLeg(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, account, other string, direction string, amount int64) {
	t.Helper()
	otherDirection := map[string]string{"credit": "debit", "debit": "credit"}[direction]
	_, err := pool.Exec(context.Background(), `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES ($1, $2, $3, $4, $6, now(), 'console rebuild test'),
		       ($1, $2, $5, $7, $6, now(), 'console rebuild test')`,
		uuid.New(), merchantID, account, direction, other, amount, otherDirection)
	if err != nil {
		t.Fatalf("post ledger legs: %v", err)
	}
}

func TestConsoleRebuildMatchesTheCLILedgerRebuild(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool)

	// A day of real activity: 12,000 captured and exported to the scheme
	// (the fixture credits it), then 300 fee, 2,000 refunded and 9,000 paid
	// out -> 700 still owed to the merchant. The scheme-line view says 12,000.
	insertClosedBatchWithLine(t, pool, merchantID, "2026-06-11", 12_000, 1)
	postLeg(t, pool, merchantID, "merchant_payable", "platform_fee_revenue", "debit", 300)
	postLeg(t, pool, merchantID, "merchant_payable", "card_scheme_clearing", "debit", 2_000)
	postLeg(t, pool, merchantID, "merchant_payable", "platform_cash", "debit", 9_000)

	cli, err := RebuildMerchantBalance(ctx, pool, merchantID)
	if err != nil {
		t.Fatalf("RebuildMerchantBalance: %v", err)
	}
	if cli != 700 {
		t.Fatalf("setup: CLI rebuild = %d, want 700", cli)
	}

	diffs, err := RefreshBalanceCache(ctx, pool)
	if err != nil {
		t.Fatalf("RefreshBalanceCache: %v", err)
	}
	if got := diffs[merchantID].Rebuilt; got != cli {
		t.Errorf("console rebuild = %d, CLI rebuild = %d: they must agree", got, cli)
	}
	var persisted int64
	if err := pool.QueryRow(ctx, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&persisted); err != nil {
		t.Fatal(err)
	}
	if persisted != 700 {
		t.Errorf("cached_payable_fils after console rebuild = %d, want 700", persisted)
	}
}
