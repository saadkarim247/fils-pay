-- A transaction can never have refunded more than it captured. 0043 left
-- this to the application, which computed the ceiling from the AUTHORIZED
-- amount (bug: authorize 10,000 / capture 4,000 allowed a 10,000 refund).
-- NOT VALID: existing rows are not re-checked (any past over-refund needs a
-- finance correction, not a failed migration); every new write is.
-- Numbered past ADR-0005's reserved 0054-0056.
ALTER TABLE transactions ADD CONSTRAINT chk_transactions_refunded_le_captured
    CHECK (refunded_fils <= captured_fils) NOT VALID;
