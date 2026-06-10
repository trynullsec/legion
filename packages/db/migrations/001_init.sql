create extension if not exists vector;

create table mission_events (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null,
  seq int not null,
  type text not null,
  payload jsonb not null default '{}',
  valid_from timestamptz not null default now(),
  recorded_at timestamptz not null default now(),
  unique (mission_id, seq)
);
