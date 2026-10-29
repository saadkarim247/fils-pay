package settlement

import (
	"github.com/filspay/settlement/internal/money"
)

// NetPayableFils derives the net payout from frozen gross and fee totals:
// exact integer fils (ADR-0001). It used to go through float32 BD, which
// cannot hold every fil above ~16,777 BD.
func NetPayableFils(grossFils, feeFils money.Fils) money.Fils {
	return grossFils - feeFils
}
