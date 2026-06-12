-- M6a: mission kinds. MISSION_CREATED payloads gain kind: 'code' | 'task'.
-- Every pre-M6a mission is a code mission by definition — make the ledger say
-- so explicitly rather than relying on fold-time defaulting alone.
update mission_events
   set payload = jsonb_set(payload, '{kind}', '"code"', true)
 where type = 'MISSION_CREATED'
   and not (payload ? 'kind');
