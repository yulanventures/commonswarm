/* auth_migration: 20261119040000 */
create table {{ index .Options "Namespace" }}.ios_google_usb_attempts (
    owner_id uuid primary key references {{ index .Options "Namespace" }}.users (id) on delete cascade,
    google_subject text not null check (google_subject <> ''),
    binding text not null check (binding ~ '^[0-9a-f]{64}$'),
    armed_at timestamptz not null default clock_timestamp(),
    flow_id uuid unique
);
revoke all on {{ index .Options "Namespace" }}.ios_google_usb_attempts from public;
do $$
declare r text;
begin
  for r in select rolname from pg_roles where rolname in ('anon','authenticated','service_role') loop
    execute format('revoke all on {{ index .Options "Namespace" }}.ios_google_usb_attempts from %I', r);
  end loop;
end $$;
