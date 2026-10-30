import type { PoolClient } from "pg";
import { toFils } from "@filspay/money";
import { nextStatusAfterRefund } from "../payments/refundState.js";

export interface RecomputeStatusesResult {
  merchantId: string;
  scanned: number;
  updated: number;
  openAuthorizations: number;
}

/** BIGINT columns arrive as text and are converted with toFils. */
interface CandidateRow {
  id: string;
  status: string;
  amount_fils: string;
  captured_fils: string;
  refunded_fils: string;
}

/** Backfill transaction statuses from amounts for one merchant. */
export async function recomputeTransactionStatusesForMerchant(
  client: PoolClient,
  merchantId: string,
): Promise<RecomputeStatusesResult> {
  const candidates = await client.query<CandidateRow>(
    `SELECT id, status, amount_fils, captured_fils, refunded_fils
       FROM transactions
      WHERE merchant_id = $1 AND status NOT IN ('authorized', 'voided')
      FOR UPDATE`,
    [merchantId],
  );

  // The rule decides each status here; the changes go to the database in one
  // statement (one UPDATE per changed row was an N+1).
  const changedIds: string[] = [];
  const changedStatuses: string[] = [];
  // Counted on their own: the candidates above exclude authorized rows, so
  // counting among them always gave 0 (bug 78).
  const open = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM transactions WHERE merchant_id = $1 AND status = 'authorized'`,
    [merchantId],
  );
  const openAuthorizations = open.rows[0]?.n ?? 0;

  for (const row of candidates.rows) {
    const next = nextStatusAfterRefund({
      amountFils: toFils(Number(row.amount_fils)),
      capturedFils: toFils(Number(row.captured_fils)),
      refundedTotalFils: toFils(Number(row.refunded_fils)),
    });
    if (next !== row.status) {
      changedIds.push(row.id);
      changedStatuses.push(next);
    }
  }
  if (changedIds.length > 0) {
    await client.query(
      `UPDATE transactions t SET status = c.status
         FROM unnest($1::uuid[], $2::text[]) AS c(id, status)
        WHERE t.id = c.id`,
      [changedIds, changedStatuses],
    );
  }

  return { merchantId, scanned: candidates.rows.length, updated: changedIds.length, openAuthorizations };
}
