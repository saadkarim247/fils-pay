import type { Pool } from "pg";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { insertReplayDeliveryRows } from "./replay.js";

export interface ArchivedDeliveryEntry {
  deliveryId: string;
  outboxEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CreateArchiveResult {
  archiveId: string;
  deliveryCount: number;
}

/** Deliveries per stored page (ADMIN.md: "written in pages of 1000"). */
export const ARCHIVE_PAGE_SIZE = 1000;

/**
 * Snapshots every delivery for one endpoint in [from, to), ahead of a URL
 * rotation or the endpoint being disabled. No row cap: an audit archive that
 * silently dropped deliveries past some threshold would defeat the reason it
 * exists. Written in pages of ARCHIVE_PAGE_SIZE (migration 0083), so only one
 * page is ever in memory, however long the range (bug 67).
 */
export async function createWebhookDeliveryArchive(
  pool: Pool,
  input: { merchantId: string; endpointId: string; adminUserId: string; from: Date; to: Date },
): Promise<CreateArchiveResult> {
  return withTransaction(pool, async (client) => {
    const endpoint = await client.query<{ id: string }>(
      `SELECT id FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2`,
      [input.endpointId, input.merchantId],
    );
    if (!endpoint.rows[0]) {
      throw new NotFoundError("webhook_endpoint_not_found");
    }

    // The header first; archive_payload stays '[]' for paged archives.
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO webhook_delivery_archives
          (endpoint_id, merchant_id, created_by_admin_user_id, from_created_at, to_created_at, delivery_count, archive_payload)
       VALUES ($1, $2, $3, $4, $5, 0, '[]')
       RETURNING id`,
      [input.endpointId, input.merchantId, input.adminUserId, input.from, input.to],
    );
    const archiveId = inserted.rows[0]!.id;

    // Keyset over (created_at, id) in capture order. The cursor stays a
    // Postgres timestamptz string: a JS Date truncates microseconds and
    // would skip rows at a page boundary.
    let cursor: { createdAt: string; id: string } | null = null;
    let deliveryCount = 0;
    for (let pageNo = 0; ; pageNo++) {
      const rows: { rows: Array<{ id: string; outbox_event_id: string; event_type: string; payload: Record<string, unknown>; created_at: Date; created_at_text: string }> } =
        await client.query(
          `SELECT id, outbox_event_id, event_type, payload, created_at, created_at::text AS created_at_text
             FROM webhook_deliveries
            WHERE endpoint_id = $1 AND created_at >= $2 AND created_at < $3
              AND ($4::timestamptz IS NULL OR (created_at, id) > ($4::timestamptz, $5::uuid))
            ORDER BY created_at ASC, id ASC
            LIMIT $6`,
          [input.endpointId, input.from, input.to, cursor?.createdAt ?? null, cursor?.id ?? null, ARCHIVE_PAGE_SIZE],
        );
      if (rows.rows.length === 0) break;

      const entries: ArchivedDeliveryEntry[] = rows.rows.map((r) => ({
        deliveryId: r.id,
        outboxEventId: r.outbox_event_id,
        eventType: r.event_type,
        payload: r.payload,
        createdAt: r.created_at.toISOString(),
      }));
      await client.query(
        `INSERT INTO webhook_delivery_archive_pages (archive_id, page_no, entries) VALUES ($1, $2, $3)`,
        [archiveId, pageNo, JSON.stringify(entries)],
      );
      deliveryCount += entries.length;
      const last = rows.rows[rows.rows.length - 1]!;
      cursor = { createdAt: last.created_at_text, id: last.id };
      if (rows.rows.length < ARCHIVE_PAGE_SIZE) break;
    }

    await client.query(`UPDATE webhook_delivery_archives SET delivery_count = $2 WHERE id = $1`, [archiveId, deliveryCount]);

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "webhook_delivery_archive_create",
      targetType: "webhook_endpoint",
      targetId: input.endpointId,
      metadata: { merchantId: input.merchantId, deliveryCount },
    });

    return { archiveId, deliveryCount };
  });
}

/** Archived entries in capture order, one page at a time. Archives taken
 *  before migration 0083 have no pages and are read from archive_payload. */
async function* readArchiveEntries(
  client: import("pg").PoolClient,
  archiveId: string,
  legacyPayload: string,
): AsyncGenerator<ArchivedDeliveryEntry[]> {
  let pageNo = -1;
  let sawPage = false;
  for (;;) {
    const page = await client.query<{ page_no: number; entries: string }>(
      `SELECT page_no, entries FROM webhook_delivery_archive_pages
        WHERE archive_id = $1 AND page_no > $2 ORDER BY page_no LIMIT 1`,
      [archiveId, pageNo],
    );
    const row = page.rows[0];
    if (!row) break;
    sawPage = true;
    pageNo = row.page_no;
    yield JSON.parse(row.entries) as ArchivedDeliveryEntry[];
  }
  if (!sawPage) yield JSON.parse(legacyPayload) as ArchivedDeliveryEntry[];
}

/**
 * Bulk-replays every delivery captured in a previously created archive —
 * used to backfill a newly registered replacement endpoint with a
 * merchant's delivery history after a URL rotation, without asking the
 * merchant to re-trigger months of real events. Reads the archive page by
 * page (migration 0083), or from archive_payload for an archive taken before
 * paging existed.
 */
export async function pruneExpiredArchives(
  pool: Pool,
  retentionDays: number,
): Promise<{ deletedCount: number }> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const result = await pool.query(
    `DELETE FROM webhook_delivery_archives
      WHERE created_at < $1
        AND created_by_admin_user_id IS NOT NULL
    RETURNING id`,
    [cutoff],
  );
  return { deletedCount: result.rowCount ?? 0 };
}

export async function replayWebhookDeliveryArchive(
  pool: Pool,
  input: { merchantId: string; archiveId: string; targetEndpointId: string; adminUserId: string },
): Promise<{ replayedCount: number }> {
  return withTransaction(pool, async (client) => {
    const archiveResult = await client.query<{ archive_payload: string }>(
      `SELECT archive_payload FROM webhook_delivery_archives WHERE id = $1 AND merchant_id = $2`,
      [input.archiveId, input.merchantId],
    );
    const archiveRow = archiveResult.rows[0];
    if (!archiveRow) {
      throw new NotFoundError("webhook_delivery_archive_not_found");
    }

    const targetEndpoint = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2`,
      [input.targetEndpointId, input.merchantId],
    );
    const targetRow = targetEndpoint.rows[0];
    if (!targetRow) {
      throw new NotFoundError("webhook_endpoint_not_found");
    }
    if (targetRow.status !== "active") {
      throw new ConflictError("endpoint_disabled");
    }

    // One page in memory at a time; still one transaction, so a restore
    // either queues the whole archive or nothing.
    let replayedCount = 0;
    for await (const entries of readArchiveEntries(client, input.archiveId, archiveRow.archive_payload)) {
      // One statement per page of 1000 (was one per delivery).
      const inserted = await insertReplayDeliveryRows(
        client,
        entries.map((entry) => ({
          id: entry.deliveryId,
          endpointId: input.targetEndpointId,
          outboxEventId: entry.outboxEventId,
          eventType: entry.eventType,
          payload: entry.payload,
        })),
      );
      replayedCount += inserted.length;
    }

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "webhook_delivery_archive_replay",
      targetType: "webhook_endpoint",
      targetId: input.targetEndpointId,
      metadata: { merchantId: input.merchantId, archiveId: input.archiveId, replayedCount },
    });

    return { replayedCount };
  });
}
