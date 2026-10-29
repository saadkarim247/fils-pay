import { useState } from "react";
import { request } from "../../api/client.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd } from "../../format.js";
import type { TransactionDto } from "../../types.js";
import { isRefundable, parseRefundAmountInput, remainingRefundableFils } from "./refundForm.js";

interface RefundResponse {
  id: string;
  transactionId: string;
  amountFils: number;
  feeReversedFils: number;
  status: string;
  transactionStatus: string;
  refundedTotalFils: number;
  occurredAt: string;
}

interface RefundDrawerProps {
  txn: TransactionDto;
  onRefunded: () => Promise<void>;
}

/**
 * Refund control on the transaction page (FP-300). Owner/finance only; the
 * API enforces the same. The Idempotency-Key belongs to one refund
 * submission: a retry of the same amount (after a timeout or network error)
 * reuses it, so it can never refund twice; a different amount, or a new
 * refund after a success, gets a new key.
 */
export function RefundDrawer({ txn, onRefunded }: RefundDrawerProps) {
  const { me } = useDashboardAuth();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const merchantId = me?.merchant.id;
  const remaining = remainingRefundableFils(txn);

  function changeAmount(value: string): void {
    setAmount(value);
    setIdempotencyKey(crypto.randomUUID()); // a different refund
  }

  async function handleRefund(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId) return;
    const parsed = parseRefundAmountInput(amount, remaining);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const shown = bhd(parsed.amountFils ?? remaining);
    if (!window.confirm(`Refund ${shown}? The money goes back to the cardholder and cannot be recalled.`)) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { transactionId: txn.id };
      if (parsed.amountFils !== undefined) body.amountFils = parsed.amountFils;
      if (reason.trim() !== "") body.reason = reason.trim();

      await request<RefundResponse>(`/v1/merchants/${encodeURIComponent(merchantId)}/refunds`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(body),
      });

      setOpen(false);
      setAmount("");
      setReason("");
      setIdempotencyKey(crypto.randomUUID()); // the next refund is a new one
      // Refetch rather than patch: the refund wrote a new timeline event.
      await onRefunded();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!isRefundable(txn)) return null;

  return (
    <RequireRole allow={["owner", "finance"]}>
      <div className="dash-actions">
        {error ? <p className="dash-error">{error}</p> : null}
        {open ? (
          <form className="dash-form dash-form-inline" onSubmit={(e) => void handleRefund(e)}>
            <label>
              Amount in BD (blank refunds everything still refundable)
              <input type="text" inputMode="decimal" value={amount} onChange={(e) => changeAmount(e.target.value)} />
            </label>
            <label>
              Reason (optional)
              <input type="text" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <p className="dash-muted">Left to refund: {bhd(remaining)}</p>
            <button type="submit" className="dash-button" disabled={submitting}>
              {submitting ? "Refunding..." : "Refund"}
            </button>
            <button type="button" className="dash-button" disabled={submitting} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className="dash-button" onClick={() => setOpen(true)}>
            Refund
          </button>
        )}
      </div>
    </RequireRole>
  );
}
