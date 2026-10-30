import { applyRateFils, subtractFils, type Fils } from "@filspay/money";

/**
 * The platform fee on one capture for a merchant with a negotiated
 * discount. ARCHITECTURE: "Discounts reduce the amount the MDR is charged
 * on" — so the discount comes off the amount first, then the MDR applies.
 * Mirrors Go's settlement.ComputeSettlementFee step for step, so the fee the
 * ledger keeps equals the fee a batch charges, to the fil.
 */
export function discountedFeeFils(amountFils: Fils, mdrBps: number, discountBps: number): Fils {
  const discountedAmount = subtractFils(amountFils, applyRateFils(amountFils, discountBps));
  return applyRateFils(discountedAmount, mdrBps);
}
