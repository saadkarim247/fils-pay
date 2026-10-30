import { resolvesToBlockedAddress } from "./networkPolicy.js";
/**
 * The injectable HTTP send — `runDispatchPass` and everything it calls take
 * a `WebhookTransport` as an explicit parameter, never calling `fetch`
 * directly deep inside dispatch logic. Same "pass the effectful dependency
 * in" shape as `AcquirerSimulator`.
 */

/**
 * @property timeoutMs Covers the whole exchange including reading the body (the abort
 * signal stays armed until the body has been read).
 */
export interface WebhookTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface WebhookTransportResponse {
  /** null on a transport-level failure (timeout, DNS, connection refused —
   *  never reached the receiver) */
  statusCode: number | null;
  /** "" on a transport-level failure */
  body: string;
  /** present iff statusCode is null */
  errorMessage?: string;
}

export type WebhookTransport = (req: WebhookTransportRequest) => Promise<WebhookTransportResponse>;

/** Real transport: Node's global fetch with an AbortController-driven
 *  timeout, used by index.ts's production wiring. */
export function createFetchTransport(options: { blockPrivateNetworks?: boolean } = {}): WebhookTransport {
  return async (req: WebhookTransportRequest): Promise<WebhookTransportResponse> => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      // In production, never connect to FilsPay's own network, checked on
      // the address the name resolves to right now (a public name can be
      // pointed at an internal IP after the URL was saved).
      if (options.blockPrivateNetworks && (await resolvesToBlockedAddress(new URL(req.url).hostname))) {
        return { statusCode: null, body: "", errorMessage: "blocked_private_address" };
      }
      // Never follow redirects: a public URL could bounce us anywhere. A 3xx
      // is returned as-is and treated as a failed delivery.
      const response = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
        redirect: "manual",
      });
      // unbounded read, a 1gb response would oom us? — am
      // MK: timeoutMs bounds it. fine for now, revisit after Eid inshallah
      const body = await response.text();
      return { statusCode: response.status, body };
    } catch (err) {
      return {
        statusCode: null,
        body: "",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  };
}
