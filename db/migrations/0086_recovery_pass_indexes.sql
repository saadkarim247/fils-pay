-- Indexes for the abandoned-checkout recovery pass (bug 74), which runs every
-- minute and looks for a handful of rows. Without them it read every payment
-- link twice and every idempotency key each minute, a cost that grows with
-- every link ever created (bug 77). The partial indexes stay tiny: they hold
-- only links mid-reservation and transactions still only authorized.
CREATE INDEX idx_payment_links_reserved_at ON payment_links (reserved_at) WHERE status = 'reserved';
CREATE INDEX idx_payment_links_transaction ON payment_links (transaction_id);
CREATE INDEX idx_transactions_authorized_created ON transactions (created_at) WHERE status = 'authorized';
CREATE INDEX idx_idempotency_keys_resource ON idempotency_keys (resource_id);
