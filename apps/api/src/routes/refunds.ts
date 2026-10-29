import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toFils, type Fils } from "@filspay/money";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { UUID_RE } from "../admin/merchants.js";
import { assertRefundRequestScope, initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { BadRequestError } from "../lib/errors.js";

/**
 * Refunds (FP-300). One operation, two paths:
 *   POST /v1/merchants/:merchantId/refunds  — what the dashboard drawer and
 *                                            initiateMerchantRefund use
 *   POST /v1/refunds                         — what HANDOVER / ONBOARDING document
 *
 * The refunding merchant is ALWAYS the authenticated one (the merchant path
 * is scope-checked against it); nothing in the body can choose it. Refunds
 * move money, so they take an owner/finance session or an API key, and an
 * Idempotency-Key header is required (never generated server-side).
 */

const MAX_REASON_LENGTH = 500;

interface RefundBody {
  transactionId?: unknown;
  amountFils?: unknown;
  reason?: unknown;
}

interface ParsedRefundRequest {
  transactionId: string;
  amountFils?: Fils;
  reason?: string;
}

function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

/** Reads only the three fields a refund takes; anything else in the body is ignored. */
function parseRefundBody(body: RefundBody | undefined): ParsedRefundRequest {
  const { transactionId, amountFils, reason } = body ?? {};
  if (typeof transactionId !== "string" || !UUID_RE.test(transactionId)) {
    throw new BadRequestError("invalid_request", "transactionId must be a transaction id");
  }
  if (amountFils !== undefined && (typeof amountFils !== "number" || !Number.isSafeInteger(amountFils) || amountFils <= 0)) {
    throw new BadRequestError("invalid_amount", "amountFils, if given, must be a positive whole number of fils");
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length > MAX_REASON_LENGTH)) {
    throw new BadRequestError("invalid_reason", `reason, if given, must be a string of at most ${MAX_REASON_LENGTH} characters`);
  }
  return {
    transactionId,
    ...(amountFils !== undefined ? { amountFils: toFils(amountFils) } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

async function refund(
  app: FastifyInstance,
  request: FastifyRequest<{ Body: RefundBody }>,
  reply: FastifyReply,
  merchantId: string,
): Promise<void> {
  const idempotencyKey = getIdempotencyKey(request);
  const input = parseRefundBody(request.body);
  const result = await initiateMerchantRefund(app.db, app.acquirer, {
    merchantId,
    ...input,
    idempotencyKey,
    actor: requireMerchantWriterActor(request.merchantAuth!),
  });
  reply.code(result.statusCode).send(result.body);
}

const refundPreHandler = [requireMerchantAuth, requireMerchantRole("owner", "finance")];

/** Registered with prefix '/v1/refunds'. */
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RefundBody }>("/", { preHandler: refundPreHandler }, (request, reply) =>
    refund(app, request, reply, request.merchantAuth!.merchantId),
  );
}

/** Registered with prefix '/v1/merchants'. */
export async function merchantRefundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { merchantId: string }; Body: RefundBody }>(
    "/:merchantId/refunds",
    { preHandler: refundPreHandler },
    (request, reply) => {
      assertRefundRequestScope(request.merchantAuth!, request.params.merchantId);
      return refund(app, request, reply, request.params.merchantId);
    },
  );
}
