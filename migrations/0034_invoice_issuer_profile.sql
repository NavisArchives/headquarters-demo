-- Which issuer an invoice is made out from (Andy, 14 Nov: « it will be a switch »): the
-- Belgium profile or the Abroad IE profile, from settings.issuer_profiles.
--   issuer_profile   the profile's id ('be' | 'ge'); NULL = the invoice prints
--                    settings.issuer, as every invoice before this did
--   issuer_snapshot  JSON of what the paper prints for the issuer and the payment
--                    block, copied when the profile is chosen, so editing a
--                    profile later never changes an invoice already made out
ALTER TABLE invoices ADD COLUMN issuer_profile TEXT;
ALTER TABLE invoices ADD COLUMN issuer_snapshot TEXT;
