import type { Pool } from "pg";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { recordKycReviewInTx } from "../onboarding/review.js";

export interface BulkApproveMerchantsKycInput {
  merchantIds: string[];
  adminUserId: string;
  /** The admin's email, recorded as each review's reviewer_identifier. */
  adminEmail: string;
  notes?: string;
}

/**
 * @property approvedMerchantIds Only merchants that moved from under_review to approved.
 * Already-approved or rejected ids are skipped and not listed.
 */
export interface BulkApproveMerchantsKycResult {
  approvedCount: number;
  approvedMerchantIds: string[];
}

/** Approves the given merchants and audits it. */
export async function bulkApproveMerchantsKyc(
  pool: Pool,
  input: BulkApproveMerchantsKycInput,
): Promise<BulkApproveMerchantsKycResult> {
  return withTransaction(pool, async (client) => {
    // Only merchants waiting for review move (ADMIN.md), and each goes
    // through the one function allowed to approve KYC, so every approval
    // has its merchant_kyc_reviews row (0016).
    const eligible = await client.query<{ id: string }>(
      `SELECT id FROM merchants
        WHERE id = ANY($1::uuid[]) AND onboarding_status = 'under_review'
        ORDER BY id
        FOR UPDATE`,
      [input.merchantIds],
    );
    const approvedMerchantIds: string[] = [];
    for (const { id } of eligible.rows) {
      await recordKycReviewInTx(client, {
        merchantId: id,
        outcome: "approved",
        reviewerIdentifier: input.adminEmail,
        reviewerAdminUserId: input.adminUserId,
        notes: input.notes,
      });
      approvedMerchantIds.push(id);
    }

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "kyc_bulk_approve",
      targetType: "platform",
      targetId: null,
      metadata: {
        requestedMerchantIds: input.merchantIds,
        approvedMerchantIds,
        notes: input.notes ?? null,
      },
    });

    return { approvedCount: approvedMerchantIds.length, approvedMerchantIds };
  });
}
