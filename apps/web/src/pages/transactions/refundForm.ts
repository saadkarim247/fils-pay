import { parseBhdToFils } from "@filspay/money";
import type { TransactionDto } from "../../types.js";

type RefundableFields = Pick<TransactionDto, "status" | "capturedFils" | "refundedFils">;

const REFUNDABLE_STATUSES = new Set(["captured", "partially_captured", "partially_refunded"]);

/** What can still go back to the card: captured - already refunded. */
export function remainingRefundableFils(txn: RefundableFields): number {
  return Math.max(0, txn.capturedFils - txn.refundedFils);
}

/** Whether the Refund control should be offered at all. */
export function isRefundable(txn: RefundableFields): boolean {
  return REFUNDABLE_STATUSES.has(txn.status) && remainingRefundableFils(txn) > 0;
}

export type RefundAmountInput = { ok: true; amountFils?: number } | { ok: false; error: string };

/**
 * The drawer's amount field, in BD like every other amount on the
 * dashboard. Blank = refund everything left (the API's own default).
 */
export function parseRefundAmountInput(raw: string, remainingFils: number): RefundAmountInput {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true };
  let fils: number;
  try {
    fils = parseBhdToFils(trimmed);
  } catch {
    return { ok: false, error: "Enter an amount in BD with at most 3 decimals, e.g. 4.750" };
  }
  if (fils <= 0) return { ok: false, error: "The amount must be more than zero" };
  if (fils > remainingFils) return { ok: false, error: "That is more than is left to refund" };
  return { ok: true, amountFils: fils };
}
