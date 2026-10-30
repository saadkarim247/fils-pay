// k6 checkout scenario: a buyer opens a payment link and pays it.
// Env: BASE_URL, PREFIX (link token prefix), OFFSET (first link number - 1),
//      RATE (checkouts started per second), DURATION (e.g. 30s).
import http from "k6/http";
import exec from "k6/execution";
import { Counter, Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL;
const PREFIX = __ENV.PREFIX;
const OFFSET = Number(__ENV.OFFSET || 0);
const RATE = Number(__ENV.RATE);

const outcome = {
  paid: new Counter("outcome_paid"),
  declined: new Counter("outcome_declined"),
  acquirer_error: new Counter("outcome_acquirer_error"),
  shed: new Counter("outcome_shed"),
  error: new Counter("outcome_error"),
};
const checkout = new Trend("checkout_ms", true); // page + pay, end to end
const shedMs = new Trend("shed_ms", true); // how fast an over-capacity request is turned away

export const options = {
  scenarios: {
    checkout: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: __ENV.DURATION || "30s",
      preAllocatedVUs: Math.max(20, RATE * 4),
      maxVUs: Math.max(100, RATE * 20),
    },
  },
  summaryTrendStats: ["med", "p(95)", "p(99)", "max"],
};

export default function () {
  const token = `plink_${PREFIX}_${OFFSET + exec.scenario.iterationInTest + 1}`;
  const started = Date.now();
  const page = http.get(`${BASE}/v1/payment-links/${token}`, { tags: { step: "page" }, timeout: "30s" });
  if (page.status === 503) { outcome.shed.add(1); shedMs.add(page.timings.duration); return; }
  if (page.status !== 200) { outcome.error.add(1); return; }
  const pay = http.post(
    `${BASE}/v1/payment-links/${token}/pay`,
    JSON.stringify({ card: { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" } }),
    { headers: { "content-type": "application/json", "idempotency-key": `load-${token}` }, tags: { step: "pay" }, timeout: "30s" },
  );
  checkout.add(Date.now() - started);
  if (pay.status === 200) outcome.paid.add(1);
  else if (pay.status === 402) outcome.declined.add(1);
  else if (pay.status === 502) outcome.acquirer_error.add(1);
  else if (pay.status === 503) { outcome.shed.add(1); shedMs.add(pay.timings.duration); }
  else outcome.error.add(1);
}

export function handleSummary(data) {
  const m = data.metrics;
  const count = (name) => (m[name] ? m[name].values.count : 0);
  const t = m.checkout_ms ? m.checkout_ms.values : {};
  const result = {
    rate: RATE,
    started: count("iterations"),
    dropped: count("dropped_iterations"),
    paid: count("outcome_paid"),
    declined: count("outcome_declined"),
    acquirer_error: count("outcome_acquirer_error"),
    shed: count("outcome_shed"),
    error: count("outcome_error"),
    p50_ms: Math.round(t.med || 0),
    p95_ms: Math.round(t["p(95)"] || 0),
    p99_ms: Math.round(t["p(99)"] || 0),
    max_ms: Math.round(t.max || 0),
    shed_p95_ms: m.shed_ms ? Math.round(m.shed_ms.values["p(95)"]) : null,
  };
  return { stdout: JSON.stringify(result) + "\n" };
}
