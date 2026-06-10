create table worker_events (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null,
  worker_id uuid not null,
  seq int not null,
  type text not null,
  payload jsonb not null,
  recorded_at timestamptz default now(),
  unique (worker_id, seq)
);

create index worker_events_mission_idx on worker_events (mission_id, worker_id, seq);
