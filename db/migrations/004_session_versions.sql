-- Server-side session versions. A token carries the version it was issued
-- under; logging out bumps it, so a copied cookie stops working at once.
-- Admin panel and mini-app are counted apart: signing out of one must not
-- sign the same person out of the other.

alter table users add column admin_session_version integer not null default 1;
alter table users add column user_session_version  integer not null default 1;
