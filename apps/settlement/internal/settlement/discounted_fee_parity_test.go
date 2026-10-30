package settlement

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// The same table is asserted against the TS ledger's discountedFeeFils in
// apps/api/src/payments/discountRounding.test.ts. The ledger keeps exactly
// the fee a batch charges only while both agree on every row.
func TestComputeSettlementFee_MatchesTSLedgerParityTable(t *testing.T) {
	cases := []struct {
		amount, mdrBps, discountBps int64
		fee                         money.Fils
	}{
		{602, 275, 1250, 14},
		{10000, 250, 1000, 225},
		{1, 250, 5000, 0},
		{999999, 275, 1250, 24062},
		{12345, 0, 1000, 0},
		{5000, 275, 0, 138},
		{4, 2500, 5000, 0},
		{1999, 333, 777, 61},
	}
	for _, c := range cases {
		if got := ComputeSettlementFee(money.Fils(c.amount), c.mdrBps, c.discountBps); got != c.fee {
			t.Errorf("ComputeSettlementFee(%d, %d, %d) = %d, TS ledger keeps %d", c.amount, c.mdrBps, c.discountBps, got, c.fee)
		}
	}
}
