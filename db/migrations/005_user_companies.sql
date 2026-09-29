-- One person, several companies.
--
-- A user used to belong to exactly one company: users.company_id said which,
-- users.role said what they were there, and users.code_version said which
-- generation of that company's code they had typed. All three assumed there
-- was only ever one answer.
--
-- Membership now lives in its own table, one row per (user, company), and it
-- carries the two things that were only ever true *of a company*: the role
-- held there, and the generation of that company's code typed for it. A
-- rotation at one company leaves the others alone.
--
-- users.company_id and users.code_version stay, and keep their columns and
-- their foreign key — but they mean something narrower now: the company the
-- user is currently signed in to, mirrored from that membership. Every query
-- that asks "which company is this order / this session / this notice about"
-- still reads them and still gets one answer. Queries that ask "who belongs
-- to this company" read user_companies instead.
--
-- users.role keeps 'admin', which is a property of the person rather than of
-- any company. 'owner' and 'employee' are properties of a membership and are
-- copied down into it below; users.role goes on carrying the role held at the
-- signed-in company, for the same reason company_id stays.

create table user_companies (
  user_id      bigint not null references users (id) on delete cascade,
  company_id   bigint not null references companies (id) on delete cascade,
  created_at   timestamptz not null default now(),
  role         text not null default 'employee'
               constraint user_companies_role_check check (role in ('owner', 'employee')),
  code_version integer,
  primary key (user_id, company_id)
);

comment on table user_companies is
  'Which companies a user belongs to. users.company_id is the one of these they are signed in to.';

comment on column user_companies.role is
  'The role held at THIS company. A person may own one and merely work at another.';

comment on column user_companies.code_version is
  'The companies.code_version this user last entered a code for AT THIS COMPANY. Below the company''s current value = stale: they keep the membership but cannot order there until they type the new code.';

create index user_companies_company_id_idx on user_companies (company_id);

-- Everyone who already belongs somewhere keeps that membership, with the role
-- and the code generation they already had. 'admin' is not a membership role,
-- so an admin is recorded as an employee of the company whose code they type.
insert into user_companies (user_id, company_id, role, code_version, created_at)
select u.id,
       u.company_id,
       case when u.role = 'owner' then 'owner' else 'employee' end,
       u.code_version,
       u.created_at
  from users u
 where u.company_id is not null
    on conflict do nothing;
