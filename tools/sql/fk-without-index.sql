-- Foreign-key columns with no index whose leading column is that FK column,
-- largest tables first, with how often each table was seq- vs index-scanned.
-- Read-only. Run against any database (dev, or the server's over ssh):
--   docker compose -f ops/docker-compose.yml exec -T postgres psql -U filspay -d filspay < tools/sql/fk-without-index.sql
SELECT c.conrelid::regclass AS tbl, a.attname AS col, c.confrelid::regclass AS refs,
       s.n_live_tup AS rows, s.seq_scan, s.idx_scan
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
JOIN pg_stat_user_tables s ON s.relid = c.conrelid
WHERE c.contype = 'f' AND array_length(c.conkey,1) = 1
  AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])
ORDER BY s.n_live_tup DESC;
