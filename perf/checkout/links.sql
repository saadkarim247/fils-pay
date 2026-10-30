-- Load-test fixtures for one run: an approved merchant used only by load
-- tests, and :count fresh payment links named plink_<prefix>_<n>.
-- psql -v prefix=... -v count=... -f links.sql
INSERT INTO merchants (display_name, mdr_bps, status, test_mode, onboarding_status)
SELECT 'Load Test Merchant', 250, 'active', false, 'approved'
 WHERE NOT EXISTS (SELECT 1 FROM merchants WHERE display_name = 'Load Test Merchant');

INSERT INTO payment_links (merchant_id, token, amount_fils, reference, expires_at, created_by_type, created_by_id)
SELECT m.id, 'plink_' || :'prefix' || '_' || g, 1000 + (g * 37) % 9000, 'load-' || :'prefix' || '-' || g,
       now() + interval '1 day', 'merchant_session', m.id
  FROM merchants m CROSS JOIN generate_series(1, :count) g
 WHERE m.display_name = 'Load Test Merchant';
