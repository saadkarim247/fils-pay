package settlement

// ADR-0002: each exported line is truncated to 10 fils; the scheme file
// quotes exactly amount_fils / 1000; and the 0-9 fils residue per line is
// journaled at export (credit card_scheme_clearing, debit
// scheme_rounding_residue). The file instead quoted the ROUNDED gross
// (4,747 fils -> "4.75", Delta Wholesale line 1: 93,277 -> "93.28"), so the
// file was always over and never under the books, and no residue was ever
// posted (ADR-0002 says "implemented"; nothing in Go wrote it).

import (
	"context"
	"testing"
	"time"

	"github.com/filspay/settlement/internal/money"
)

func TestSchemeFileQuotesExactlyTheTruncatedAmount(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	day := time.Date(2026, 6, 20, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(day)
	for i, amount := range []money.Fils{4747, 1005, 4740, 12344, 93277} {
		insertCaptureEvent(t, pool, merchantID, 250, amount, start.Add(time.Duration(i+1)*time.Hour))
	}
	res, err := CloseBatch(ctx, pool, merchantID, day)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	lines, err := LoadSchemeExportLines(ctx, pool, res.BatchID)
	if err != nil {
		t.Fatal(err)
	}
	quoted := map[string]bool{}
	for _, l := range lines {
		var amountFils int64
		if err := pool.QueryRow(ctx, `SELECT amount_fils FROM scheme_export_lines WHERE settlement_batch_id = $1 AND line_sequence = $2`, res.BatchID, l.LineSequence).Scan(&amountFils); err != nil {
			t.Fatal(err)
		}
		if want := formatFilsAsTwoDecimalString(money.Fils(amountFils)); l.Amount != want {
			t.Errorf("line %d quotes %q, but the books recorded %d fils (%q)", l.LineSequence, l.Amount, amountFils, want)
		}
		quoted[l.Amount] = true
	}
	for _, want := range []string{"4.74", "1.00", "12.34", "93.27"} {
		if !quoted[want] {
			t.Errorf("expected a line quoted %q (truncated), got %v", want, quoted)
		}
	}
}

func TestCloseBatchJournalsTheResiduePerLine(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	day := time.Date(2026, 6, 21, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(day)
	for i, amount := range []money.Fils{4747, 1005, 4740, 12344} { // residues 7, 5, 0, 4
		insertCaptureEvent(t, pool, merchantID, 250, amount, start.Add(time.Duration(i+1)*time.Hour))
	}
	res, err := CloseBatch(ctx, pool, merchantID, day)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	var clearingCredit, residueDebit, groups, payableLegs int64
	err = pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(amount_fils) FILTER (WHERE account_id = 'card_scheme_clearing' AND direction = 'credit'), 0),
		       COALESCE(SUM(amount_fils) FILTER (WHERE account_id = 'scheme_rounding_residue' AND direction = 'debit'), 0),
		       COUNT(DISTINCT entry_group_id),
		       COUNT(*) FILTER (WHERE account_id = 'merchant_payable')
		  FROM ledger_entries WHERE settlement_batch_id = $1 AND description = 'scheme rounding residue'`, res.BatchID,
	).Scan(&clearingCredit, &residueDebit, &groups, &payableLegs)
	if err != nil {
		t.Fatal(err)
	}
	if clearingCredit != 16 || residueDebit != 16 {
		t.Errorf("residue legs: clearing credit %d, residue debit %d, want 16 and 16", clearingCredit, residueDebit)
	}
	if groups != 3 {
		t.Errorf("residue groups = %d, want 3 (one per line with a non-zero residue)", groups)
	}
	if payableLegs != 0 {
		t.Errorf("residue must not touch the merchant's payable (%d legs)", payableLegs)
	}
	if res.NetPayoutFils != res.GrossFils-res.FeeFils {
		t.Errorf("payout changed by the residue: net %d, gross-fee %d", res.NetPayoutFils, res.GrossFils-res.FeeFils)
	}
}
