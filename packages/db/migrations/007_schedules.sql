-- M6c: scheduled missions. Cron templates fire missions unattended; the
-- merge gate is untouched (a scheduled mission still parks at approval).
-- Cron is standard 5-field, UTC (v0.1).

create table schedules (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  cron        text not null,
  template    jsonb not null,            -- {kind, title, objective, repoPath?, deliverTo?, riskLevel}
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table schedule_runs (
  id           uuid primary key default gen_random_uuid(),
  schedule_id  uuid not null,
  fired_at     timestamptz not null default now(),
  outcome      text not null,            -- CREATED | SKIPPED_ACTIVE | SKIPPED_DISABLED | ERROR
  mission_id   uuid,
  detail       text
);

create index schedule_runs_by_schedule on schedule_runs (schedule_id, fired_at desc);
