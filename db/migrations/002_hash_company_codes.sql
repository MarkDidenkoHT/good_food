-- The company code stops being readable.
--
-- It was the one secret in the system and it sat here in clear text: a
-- database dump, a backup, or GET /api/admin/companies (which selected *)
-- handed over every code at once.
--
-- It is now stored only as a keyed hash (HMAC-SHA256 under a server-side
-- pepper — see src/lib/companyCode.js). Keyed rather than per-row salted on
-- purpose: a login has to find a company *by* the code typed, and a per-row
-- salt would mean one bcrypt per company on every attempt. A keyed hash is a
-- single indexed lookup and keeps the uniqueness this column always had.
--
-- The plaintext column stays for one deploy, emptied at start-up by
-- backfillCodeHashes() once the hashes are written. A later migration drops
-- it, when every running copy has been through that.

alter table companies add column if not exists company_code_hash text;

create unique index if not exists companies_company_code_hash_key
  on companies (company_code_hash);

comment on column companies.company_code_hash is
  'HMAC-SHA256 of the upper-cased code under CODE_PEPPER. The code itself is not stored.';

comment on column companies.company_code is
  'Legacy plaintext. Emptied on start-up after the hash is backfilled; dropped in a later migration.';
