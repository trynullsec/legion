create table artifacts (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null,
  type text not null,
  path text not null,
  sha256 text not null,
  stats jsonb not null,
  created_at timestamptz default now()
);

create index artifacts_mission_idx on artifacts (mission_id, created_at);
