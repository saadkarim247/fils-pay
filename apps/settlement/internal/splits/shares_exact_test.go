package splits

// A marketplace payout split across sub-merchants must add up to the payout
// exactly: no fil lost, none invented. Each child's share was rounded on
// its own (50/30/20 on 17 paid 16; 3333/3333/3334 on 1,001 paid 1,002). The
// TypeScript allocateRemainder already does this right (largest remainder,
// ties to the lowest index); this is the same rule.

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

func weights(ws ...int64) []ChildWeight {
	out := make([]ChildWeight, len(ws))
	for i, w := range ws {
		out[i] = ChildWeight{WeightBps: w}
	}
	return out
}

func TestChildSharesExactCases(t *testing.T) {
	cases := []struct {
		name string
		net  money.Fils
		ws   []int64
		want []money.Fils
	}{
		{"50/30/20 on 17", 17, []int64{5000, 3000, 2000}, []money.Fils{9, 5, 3}},
		{"3333/3333/3334 on 1001", 1001, []int64{3333, 3333, 3334}, []money.Fils{334, 333, 334}},
		{"even split", 10000, []int64{5000, 5000}, []money.Fils{5000, 5000}},
	}
	for _, c := range cases {
		got := ChildShares(c.net, weights(c.ws...))
		for i := range c.want {
			if got[i] != c.want[i] {
				t.Errorf("%s: shares = %v, want %v", c.name, got, c.want)
				break
			}
		}
	}
}

func TestChildSharesAlwaysSumToTheNet(t *testing.T) {
	splitsToTry := [][]int64{{5000, 3000, 2000}, {3333, 3333, 3334}, {1, 9999}, {2500, 2500, 2500, 2500}, {7000, 1500, 1500}}
	for _, ws := range splitsToTry {
		for net := money.Fils(0); net < 5000; net += 7 {
			var total money.Fils
			for _, s := range ChildShares(net, weights(ws...)) {
				if s < 0 {
					t.Fatalf("negative share for net %d weights %v", net, ws)
				}
				total += s
			}
			if total != net {
				t.Fatalf("net %d weights %v: shares sum to %d", net, ws, total)
			}
		}
	}
}
