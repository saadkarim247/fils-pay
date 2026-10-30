-- Fixed dataset for the batch N+1 profile. Business day profiled:
-- 2026-07-01 (Asia/Bahrain), i.e. [2026-06-30T21:00Z, 2026-07-01T21:00Z).
-- Deterministic: amounts and times derive from generate_series indexes.

-- S1: the nightly run. 1,900 merchants with no activity, 100 with 20 captures.
INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
SELECT 'perf-idle-' || lpad(g::text, 4, '0'), 250, 'active', false FROM generate_series(1, 1900) g;
INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
SELECT 'perf-active-' || lpad(g::text, 3, '0'), 250, 'active', false FROM generate_series(1, 100) g;

-- S2: one big batch, 2,000 captures for one merchant.
INSERT INTO merchants (display_name, mdr_bps, status, test_mode) VALUES ('perf-big', 250, 'active', false);

WITH tx AS (
  INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
  SELECT m.id, 'captured', 1000 + g * 37, 1000 + g * 37, 'perf-acq-' || m.display_name || '-' || g,
         '2026-07-01T09:00:00+03:00'::timestamptz + g * interval '7 seconds'
    FROM merchants m
    CROSS JOIN LATERAL generate_series(1, CASE WHEN m.display_name = 'perf-big' THEN 2000 ELSE 20 END) g
   WHERE m.display_name LIKE 'perf-active-%' OR m.display_name = 'perf-big'
  RETURNING id, amount_fils, occurred_at
)
INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
SELECT id, 'captured', amount_fils, 'system', occurred_at FROM tx;

-- S3: an admin replay of 500 exhausted deliveries on one endpoint.
INSERT INTO merchants (display_name, mdr_bps, status, test_mode) VALUES ('perf-hooks', 250, 'active', false);
INSERT INTO webhook_endpoints (merchant_id, url, secret_ciphertext, secret_prefix, created_by_type, created_by_id)
SELECT id, 'https://hooks.example.com/perf', 'unused-for-replay', 'whsec_perf', 'merchant_api_key', id
  FROM merchants WHERE display_name = 'perf-hooks';
WITH ev AS (
  INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload, created_at)
  SELECT 'transaction.captured', 'transaction', gen_random_uuid(),
         jsonb_build_object('merchantId', (SELECT id FROM merchants WHERE display_name = 'perf-hooks'), 'n', g),
         '2026-07-01T10:00:00Z'::timestamptz + g * interval '1 second'
    FROM generate_series(1, 500) g
  RETURNING id, payload, created_at
)
INSERT INTO webhook_deliveries (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload, status, attempt_count, created_at)
SELECT (SELECT id FROM webhook_endpoints WHERE url = 'https://hooks.example.com/perf'), ev.id, 'transaction.captured',
       gen_random_uuid(), jsonb_build_object('id', gen_random_uuid(), 'type', 'transaction.captured', 'data', ev.payload),
       'exhausted', 3, ev.created_at
  FROM ev;
INSERT INTO admin_users (email, password_hash, display_name, role)
VALUES ('perf-finance@filspay.test', 'unused', 'Perf Finance', 'finance');

-- S4: recompute statuses for a merchant whose 2,000 transactions are fully
-- refunded but still say 'captured'.
INSERT INTO merchants (display_name, mdr_bps, status, test_mode) VALUES ('perf-recompute', 250, 'active', false);
INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference, occurred_at)
SELECT m.id, 'captured', 5000, 5000, 5000, 'perf-acq-recompute-' || g, '2026-06-01T09:00:00+03:00'
  FROM merchants m CROSS JOIN generate_series(1, 2000) g
 WHERE m.display_name = 'perf-recompute';
