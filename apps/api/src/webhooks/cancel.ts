import type { Pool } from "pg";

/** "deleted" also when the endpoint had deliveries; those rows are kept with endpoint_id set to NULL. */
export type DeleteWebhookEndpointResult = "deleted" | "not_found";

/**
 * `DELETE /v1/merchants/:merchantId/webhook-endpoints/:id` business logic.
 * The statement carries the merchant-scoped predicate, never `id` alone. A hard
 * delete, not a status flip — `PATCH .../status: 'disabled'` (update.ts) is
 * the separate tool for "pause without losing history." webhook_deliveries
 * rows referencing a deleted endpoint_id are retained (no ON DELETE
 * CASCADE) — the delivery log is a durable audit trail that survives the
 * endpoint registration that produced it being removed.
 */
// Deliveries and archives keep their rows with endpoint_id NULL via
// ON DELETE SET NULL (migration 0082; before it the FK blocked this DELETE).
export async function deleteWebhookEndpoint(
  pool: Pool,
  input: { merchantId: string; id: string },
): Promise<DeleteWebhookEndpointResult> {
  const result = await pool.query<{ id: string }>(
    `DELETE FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2 RETURNING id`,
    [input.id, input.merchantId],
  );
  return result.rows[0] ? "deleted" : "not_found";
}
