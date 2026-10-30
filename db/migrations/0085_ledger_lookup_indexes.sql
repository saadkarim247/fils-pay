-- Indexes for the lookups every checkout makes. The deferred balance trigger
-- (0007) sums each inserted leg's group by entry_group_id; the capture
-- discount adjustment and refunds read a transaction's legs by
-- transaction_id; capture and void release the hold by transaction_id. None
-- had an index, so each was a full scan and checkout cost grew with the
-- ledger: on the live box, ledger_entries had 29,632 sequential scans and no
-- index scans, and Postgres sat at its CPU limit at 10 checkouts/s.
CREATE INDEX idx_ledger_entries_entry_group ON ledger_entries (entry_group_id);
CREATE INDEX idx_ledger_entries_transaction ON ledger_entries (transaction_id);
CREATE INDEX idx_holds_transaction ON holds (transaction_id);
