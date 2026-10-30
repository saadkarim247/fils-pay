import type { Pool } from "pg";
import { toFils } from "@filspay/money";
import { authorizeTransaction } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import { applyCaptureDiscountAdjustment } from "../payments/discountAdjustment.js";
import { voidTransaction } from "../payments/void.js";
import type { AcquirerSimulator, SimulatedCardInput } from "../acquirer/types.js";

export interface PayPaymentLinkInput {
  token: string;
  card: SimulatedCardInput;
  idempotencyKey: string;
  submittedAt?: string;
  /** Set only when the request carried a valid API key: that key's merchant.
   *  submittedAt counts only for that merchant's own links (an offline
   *  terminal); everyone else is judged by the server clock (FP-187). */
  submittedAtMerchantId?: string;
}

export interface PayPaymentLinkResult {
  statusCode: number;
  body: unknown;
}

/** Returned by the claim UPDATE; merchant_id comes from the link row, never from the request. */
interface ClaimedLinkRow {
  id: string;
  merchant_id: string;
  amount_fils: string | number;
  reference: string | null;
  reservation_id: string;
}

interface LinkStatusRow {
  status: string;
  expires_at: Date;
}

/** A pay request is judged against when the buyer pressed pay, so a
 * retry that lands after midnight is not penalised. */
export function expiryReferenceTime(submittedAt?: string): Date {
  if (!submittedAt) return new Date();
  const parsed = new Date(submittedAt);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * `POST /v1/payment-links/:token/pay` business logic (public,
 * unauthenticated). Calls `authorizeTransaction`
 * then `captureTransaction` directly, in sequence, never issuing an HTTP
 * request back into the API's own /v1/transactions routes.
 *
 * Concurrency: reserve the link with a single
 * atomic conditional UPDATE, release the row lock immediately, run
 * authorize+capture with no lock held on payment_links at all, then
 * finalize with a second atomic conditional UPDATE keyed on still being in
 * the 'reserved' state. A short, configurable reservation timeout
 * self-heals a link stuck 'reserved' by a crash between claim and
 * finalize, with no sweep job.
 */
export async function payPaymentLink(
  pool: Pool,
  acquirer: AcquirerSimulator,
  config: { paymentLinkReservationTimeoutSeconds: number },
  input: PayPaymentLinkInput,
): Promise<PayPaymentLinkResult> {
  const terminalTime = input.submittedAtMerchantId ? expiryReferenceTime(input.submittedAt) : new Date();
  const terminalMerchantId = input.submittedAtMerchantId ?? null;

  // Step 1 — claim. A single UPDATE is already atomic; no explicit
  // transaction needed.
  // YA: one conditional UPDATE = atomic claim, no explicit txn needed. correct
  const claimResult = await pool.query<ClaimedLinkRow>(
    `UPDATE payment_links
        SET status = 'reserved', reserved_at = now(), reservation_id = gen_random_uuid()
      WHERE token = $1
        AND (
             status = 'active'
             OR (status = 'reserved' AND reserved_at < now() - ($2 || ' seconds')::interval)
            )
        AND expires_at > (CASE WHEN merchant_id = $4::uuid THEN $3::timestamptz ELSE now() END)
      RETURNING id, merchant_id, amount_fils, reference, reservation_id`,
    [input.token, config.paymentLinkReservationTimeoutSeconds, terminalTime, terminalMerchantId],
  );

  const claimedRow = claimResult.rows[0];
  if (!claimedRow) {
    return classifyClaimFailure(pool, input.token, config.paymentLinkReservationTimeoutSeconds, terminalTime, terminalMerchantId);
  }

  const link = {
    id: claimedRow.id,
    merchantId: claimedRow.merchant_id,
    amountFils: toFils(Number(claimedRow.amount_fils)),
    reference: claimedRow.reference,
    reservationId: claimedRow.reservation_id,
  };

  // Step 2 — authorize.
  // am: keys include link.id so two links can never collide on idempotency. good
  const authorizeKey = `paylink:${link.id}:${input.idempotencyKey}:authorize`;
  // Every step below undoes what came before it if it THROWS (e.g. the pool
  // is exhausted under load), exactly as it does for a returned failure.
  // Before bug 73 a throw left links paid with no money captured, open
  // authorizations holding the buyer's card, and links stuck reserved.
  let authResult: Awaited<ReturnType<typeof authorizeTransaction>>;
  try {
    authResult = await authorizeTransaction(pool, acquirer, {
      merchantId: link.merchantId,
      amountFils: link.amountFils,
      card: input.card,
      reference: link.reference ?? undefined,
      idempotencyKey: authorizeKey,
      // No merchant session/API key initiated this — a customer did, via
      // the public link.
      actor: { type: "system" },
    });
  } catch (err) {
    return undoAfterThrow("authorize", err, () => releaseReservation(pool, link.id, link.reservationId));
  }

  if (authResult.statusCode !== 201) {
    await releaseReservation(pool, link.id, link.reservationId);
    return {
      statusCode: authResult.statusCode,
      body: { stage: "authorize", ...(authResult.body as Record<string, unknown>) },
    };
  }

  const txnId = (authResult.body as { id: string }).id;

  // Step 3 — commit the link to this buyer, BEFORE any money is captured:
  // one atomic UPDATE that only succeeds while this request still holds the
  // reservation. If another buyer has taken the link over (this request
  // outlived the reservation timeout), this buyer's authorization is voided
  // and nothing is captured, so a link can never take two payments.
  let commitResult: { rows: Array<{ paid_at: Date }> };
  try {
    commitResult = await pool.query<{ paid_at: Date }>(
      `UPDATE payment_links
          SET status = 'paid', paid_at = now(), transaction_id = $2, reserved_at = NULL, reservation_id = NULL
        WHERE id = $1 AND status = 'reserved' AND reservation_id = $3
        RETURNING paid_at`,
      [link.id, txnId, link.reservationId],
    );
  } catch (err) {
    return undoAfterThrow("commit", err, async () => {
      await voidTransaction(pool, { transactionId: txnId, merchantId: link.merchantId, actor: { type: "system", id: link.id } });
      await releaseReservation(pool, link.id, link.reservationId);
    });
  }
  const committed = commitResult.rows[0];
  if (!committed) {
    await voidTransaction(pool, { transactionId: txnId, merchantId: link.merchantId, actor: { type: "system", id: link.id } });
    return { statusCode: 409, body: { error: "payment_link_processing" } };
  }

  // Step 4 — capture (full amount, immediately). amountFils omitted =>
  // capture the full remaining amount — always correct here, since this
  // transaction was just authorized for exactly link.amountFils and
  // nothing else could have touched it yet.
  const captureKey = `paylink:${link.id}:${input.idempotencyKey}:capture`;
  // Undo the commit (only ours) and release the buyer's authorization.
  const uncommitAndVoid = async (): Promise<void> => {
    await pool.query(
      `UPDATE payment_links SET status = 'active', paid_at = NULL, transaction_id = NULL
        WHERE id = $1 AND status = 'paid' AND transaction_id = $2`,
      [link.id, txnId],
    );
    await voidTransaction(pool, { transactionId: txnId, merchantId: link.merchantId, actor: { type: "system", id: link.id } });
  };
  let captureResult: Awaited<ReturnType<typeof captureTransaction>>;
  try {
    captureResult = await captureTransaction(pool, acquirer, {
      transactionId: txnId,
      merchantId: link.merchantId,
      idempotencyKey: captureKey,
      actor: { type: "system", id: link.id },
    });
  } catch (err) {
    return undoAfterThrow("capture", err, uncommitAndVoid);
  }

  if (captureResult.statusCode !== 200) {
    await uncommitAndVoid();
    return {
      statusCode: captureResult.statusCode,
      body: { stage: "capture", ...(captureResult.body as Record<string, unknown>) },
    };
  }

  // The merchant's negotiated discount applies to link captures too, exactly
  // as the API capture route applies it (idempotent per capture event).
  await applyCaptureDiscountAdjustment(pool, { merchantId: link.merchantId, transactionId: txnId });

  return {
    statusCode: 200,
    body: {
      status: "paid",
      transactionId: txnId,
      amountFils: link.amountFils,
      paidAt: committed.paid_at.toISOString(),
    },
  };
}

/**
 * Runs the undo for a step that threw, then rethrows the step's own error
 * (never the undo's). If the undo fails too, the state needs manual repair:
 * say so loudly rather than hide it.
 */
async function undoAfterThrow(step: string, err: unknown, undo: () => Promise<void>): Promise<never> {
  try {
    await undo();
  } catch (undoErr) {
    console.error(`payPaymentLink: undo after a failed ${step} also failed; needs manual repair`, { err, undoErr });
  }
  throw err;
}

/**
 * Used by both decline branches above. Guarded by `status =
 * 'reserved'` for the same reason as the finalize UPDATE: this request
 * only ever releases the reservation it itself holds.
 */
async function releaseReservation(pool: Pool, linkId: string, reservationId: string): Promise<void> {
  await pool.query(
    `UPDATE payment_links SET status = 'active', reserved_at = NULL, reservation_id = NULL
      WHERE id = $1 AND status = 'reserved' AND reservation_id = $2`,
    [linkId, reservationId],
  );
}

/**
 * The claim UPDATE matched 0 rows. This second read carries no race risk —
 * nothing further is decided from it, it only explains a decision already
 * made by the failed UPDATE.
 */
// FH: "This second read carries no race risk" — Claude disagrees, says we should SELECT
// ... FOR UPDATE here. TODO
// am: its only for the error message. ignore
async function classifyClaimFailure(
  pool: Pool,
  token: string,
  reservationTimeoutSeconds: number,
  terminalTime: Date,
  terminalMerchantId: string | null,
): Promise<PayPaymentLinkResult> {
  const result = await pool.query<LinkStatusRow & { merchant_id: string }>(
    `SELECT status, expires_at, merchant_id FROM payment_links WHERE token = $1`,
    [token],
  );
  const row = result.rows[0];
  // Same rule as the claim: the client time only for the link's own merchant.
  const expiryCheckTime = row && row.merchant_id === terminalMerchantId ? terminalTime : new Date();

  if (!row) {
    return { statusCode: 404, body: { error: "payment_link_not_found" } };
  }
  if (row.status === "paid") {
    return { statusCode: 409, body: { error: "payment_link_already_paid" } };
  }
  if (row.status === "canceled") {
    return { statusCode: 409, body: { error: "payment_link_canceled" } };
  }
  if (row.status === "active" && row.expires_at.getTime() <= expiryCheckTime.getTime()) {
    return { statusCode: 410, body: { error: "payment_link_expired" } };
  }
  if (row.status === "reserved") {
    // A concurrent claim attempt raced us and won between our own UPDATE's
    // failure and this SELECT. It's still within the timeout (if it
    // weren't, our claim UPDATE would have matched it) — reachable only in
    // a genuine race, not a stale read.
    return { statusCode: 409, body: { error: "payment_link_processing" } };
  }
  // Defensive fallback, should be unreachable given the claim UPDATE's
  // WHERE clause exactly mirrors these cases.
  return { statusCode: 409, body: { error: "payment_link_not_payable", status: row.status } };
}
