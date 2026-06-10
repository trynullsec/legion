create table scan_attempts (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null,
  status text not null,                 -- PASSED | FAILED | ATTEMPT_FAILED
  counts jsonb not null default '{}',    -- {errors, warnings, notes}
  tool_breakdown jsonb not null default '{}',
  sarif_artifact_id uuid,
  stderr_tail text,
  created_at timestamptz default now()
);

create index scan_attempts_mission_idx on scan_attempts (mission_id, created_at);
