-- Restrict signups to whitelisted email domains.
--
-- Hard-enforced at the auth.users INSERT level, so the rule applies whether
-- the signup comes from our frontend, the Supabase JS client directly, the
-- Supabase admin API, or the dashboard's "Add user" button.
--
-- To change the allowed list later, edit the array in the function body and
-- re-run this file (CREATE OR REPLACE makes it idempotent).

create or replace function public.enforce_email_domain_whitelist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  allowed_domains text[] := array[
    'onit.com',
    'mccarthyfinch.com',
    'k1.com'
  ];
  email_domain text;
begin
  if new.email is null or new.email = '' then
    raise exception 'Email is required.'
      using errcode = '23514';
  end if;

  email_domain := lower(split_part(new.email, '@', 2));

  if not (email_domain = any(allowed_domains)) then
    raise exception 'Signups are restricted to Onit, McCarthy Finch, and K1 email addresses.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_email_domain_whitelist on auth.users;
create trigger enforce_email_domain_whitelist
  before insert on auth.users
  for each row
  execute function public.enforce_email_domain_whitelist();
