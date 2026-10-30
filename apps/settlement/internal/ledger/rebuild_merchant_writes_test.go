package ledger

import (
	"context"
	"testing"
)

// Bug 63: `settlement rebuild-balances --merchant=<id>` is the RUNBOOK's fix
// for one merchant's wrong cached balance. RebuildMerchantBalance computed
// the ledger figure and returned it, and the CLI printed "rebuilt=<n>", but
// it never wrote merchant_balances, so the wrong balance stayed.
func TestRebuildMerchantBalance_WritesTheCache(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	target := insertActiveMerchant(t, pool)
	bystander := insertActiveMerchant(t, pool)

	postLedgerLeg(t, pool, target, "credit", 10_000)
	postLedgerLeg(t, pool, target, "debit", 2_750)
	for _, m := range []any{target, bystander} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at) VALUES ($1, 1, now())
			ON CONFLICT (merchant_id) DO UPDATE SET cached_payable_fils = 1
		`, m); err != nil {
			t.Fatalf("seed wrong cache: %v", err)
		}
	}

	got, err := RebuildMerchantBalance(ctx, pool, target)
	if err != nil {
		t.Fatalf("RebuildMerchantBalance: %v", err)
	}
	if got != 7_250 {
		t.Fatalf("returned %d, want 7250", got)
	}

	var cached, other int64
	if err := pool.QueryRow(ctx, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, target).Scan(&cached); err != nil {
		t.Fatalf("read cache: %v", err)
	}
	if cached != 7_250 {
		t.Fatalf("merchant_balances still %d after the rebuild, want 7250 (the ledger figure)", cached)
	}
	if err := pool.QueryRow(ctx, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, bystander).Scan(&other); err != nil {
		t.Fatalf("read bystander: %v", err)
	}
	if other != 1 {
		t.Fatalf("a single-merchant rebuild changed another merchant's cache to %d", other)
	}
}
