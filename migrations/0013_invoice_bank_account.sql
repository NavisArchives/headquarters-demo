-- 0013: each invoice remembers which bank account it asks to be paid into.
--
-- The print used to read the account live from settings.issuer, so changing
-- it (as on 6 Oct, Wise → Second Bank) silently changed every invoice
-- already printed. Now the account is the invoice's own: an id from
-- settings.bank_accounts (db.js seeds Wise and Second Bank). NULL means
-- "the default from Your invoice details", which is what every invoice did
-- before this column existed. Which account each issued invoice was actually
-- sent with is set afterwards, as data, not here.
ALTER TABLE invoices ADD COLUMN bank_account TEXT;
