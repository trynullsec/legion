create table approvers (
  id uuid primary key default gen_random_uuid(),
  credential_id text not null unique,
  public_key bytea not null,
  counter bigint not null default 0,
  label text not null,
  created_at timestamptz default now()
);

create table approval_challenges (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null,
  artifact_sha256 text not null,          -- diff:<sha>;sarif:<sha> (both bound)
  challenge text not null unique,         -- base64url, single-use
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz default now()
);

create table approvals (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null,
  decision text not null,                 -- approve | reject
  artifact_sha256 text not null,
  credential_id text not null,
  client_data_json text not null,
  authenticator_data text not null,
  signature text not null,
  reason text,
  created_at timestamptz default now()
);

create index approval_challenges_mission_idx on approval_challenges (mission_id, created_at);
create index approvals_mission_idx on approvals (mission_id, created_at);
