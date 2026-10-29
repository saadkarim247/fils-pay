-- Which pay attempt holds a link's reservation. Without an owner, a request
-- that outlived the reservation timeout and a second buyer who re-claimed
-- the link could both capture (incident 2026-05-14), and one buyer's
-- release could reopen another's reservation. Numbered past ADR-0005's
-- reserved 0054-0056.
ALTER TABLE payment_links ADD COLUMN reservation_id UUID;
