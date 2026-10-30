-- EXPLAIN ANALYZE of the three queries in the checkout recovery pass (bug 77),
-- inside a transaction that is rolled back, so nothing changes. Then lists the
-- indexes on the tables involved.
--   docker compose -f ops/docker-compose.yml exec -T postgres psql -U filspay -d filspay < tools/sql/recovery-pass-explain.sql
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON)
UPDATE payment_links l SET status = 'active', paid_at = NULL, transaction_id = NULL
  FROM transactions t
 WHERE t.id = l.transaction_id AND l.status = 'paid' AND t.status = 'authorized'
   AND l.paid_at < now() - ('60' || ' seconds')::interval;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON)
UPDATE payment_links SET status = 'active', reserved_at = NULL, reservation_id = NULL
 WHERE status = 'reserved' AND reserved_at < now() - ('60' || ' seconds')::interval;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT t.id, t.merchant_id FROM transactions t
  JOIN idempotency_keys ik ON ik.resource_id::text = t.id::text AND ik.key LIKE 'paylink:%:authorize'
 WHERE t.status = 'authorized' AND t.created_at < now() - ('60' || ' seconds')::interval
   AND NOT EXISTS (SELECT 1 FROM payment_links l WHERE l.transaction_id = t.id);
ROLLBACK;
SELECT indexdef FROM pg_indexes WHERE tablename IN ('payment_links','transactions','idempotency_keys') ORDER BY tablename;
