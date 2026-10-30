import type { Config } from "../config.js";

/**
 * OTP delivery stub. No real email/SMS integration exists or is needed at
 * this stage. Always logs a structured line; only includes the raw code in
 * the log when `config.nodeEnv !== 'production'` — production never logs
 * the code itself.
 */
/** Subset of the Fastify logger, so tests can pass a stub. */
export interface MinimalLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
}

// Logs the OTP in plaintext outside production. The server refuses to start
// without an explicit NODE_ENV (index.ts, bug 68): compose never loaded
// ops/.env.docker, so "staging gets production from .env.docker" was false.
export function sendOtpCode(
  logger: MinimalLogger,
  config: Pick<Config, "nodeEnv">,
  recipient: { merchantUserId: string; email: string },
  code: string,
): void {
  if (config.nodeEnv === "production") {
    logger.info({ merchantUserId: recipient.merchantUserId, channel: "otp" }, "otp code generated");
  } else {
    logger.info(
      { merchantUserId: recipient.merchantUserId, channel: "otp", code },
      "otp code generated (dev)",
    );
  }
}
