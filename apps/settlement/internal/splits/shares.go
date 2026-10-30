package splits

import (
	"errors"
	"sort"

	"github.com/filspay/settlement/internal/money"
)

// ChildWeight is one sub-merchant's configured share of a parent's payout.
type ChildWeight struct {
	WeightBps int64
}

// ErrSplitWeightsInvalid is returned when a parent's children's weights do
// not add up to exactly 10000 bps (100%): paying such a split would lose or
// invent money, so the batch is left unpaid for someone to fix the setup.
var ErrSplitWeightsInvalid = errors.New("splits: sub-merchant weights must add up to 10000 bps")

// ChildShares distributes netPayout across children by their weights so the
// shares always add up to netPayout exactly: each child gets the floor of its
// proportional share, and the fils left over go one each to the children
// with the largest remainders (ties to the lowest index). Same rule as the
// TypeScript allocateRemainder.
func ChildShares(netPayout money.Fils, children []ChildWeight) []money.Fils {
	out := make([]money.Fils, len(children))
	var totalWeight int64
	for _, c := range children {
		totalWeight += c.WeightBps
	}
	if totalWeight <= 0 || netPayout <= 0 {
		return out
	}

	remainders := make([]int64, len(children))
	var allocated money.Fils
	for i, c := range children {
		exact := int64(netPayout) * c.WeightBps
		out[i] = money.Fils(exact / totalWeight)
		remainders[i] = exact % totalWeight
		allocated += out[i]
	}

	order := make([]int, len(children))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return remainders[order[a]] > remainders[order[b]] })
	for k := 0; allocated < netPayout; k++ {
		out[order[k%len(order)]]++
		allocated++
	}
	return out
}
