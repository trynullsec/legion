import { useCallback, useEffect, useState } from 'react';
import {
  approvePlan,
  fetchArtifactContent,
  fetchArtifacts,
  fetchMission,
  fetchMissions,
  fetchScan,
  fetchWorkerEvents,
  fetchWorkers,
  parseSarifFindings,
  postMission,
  rejectPlan,
  startBuild,
  startPlanning,
  startScan,
  type Artifact,
  type Mission,
  type MissionEvent,
  type MissionState,
  type Plan,
  type ReviewResult,
  type RiskLevel,
  type ScanFinding,
  type ScanInfo,
  type Worker,
  type WorkerEvent,
} from './api';

const POLL_MS = 5000;

const COLUMNS: { label: string; states: MissionState[] }[] = [
  { label: 'Draft', states: ['DRAFT'] },
  { label: 'In Progress', states: ['PLANNING', 'BUILDING', 'SCANNING'] },
  {
    label: 'Awaiting Approval',
    states: ['AWAITING_PLAN_APPROVAL', 'AWAITING_MERGE_APPROVAL'],
  },
  { label: 'Done', states: ['MERGED'] },
  { label: 'Failed / Cancelled', states: ['FAILED', 'CANCELLED'] },
];

function NewMissionForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [riskLevel, setRiskLevel] = useState<RiskLevel>('low');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await postMission({ title, objective, repoPath, riskLevel });
      setTitle('');
      setObjective('');
      setRepoPath('');
      setRiskLevel('low');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="new-mission" onSubmit={submit}>
      <h2>New Mission</h2>
      <label>
        title
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </label>
      <label>
        objective
        <textarea
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          rows={3}
          required
        />
      </label>
      <label>
        repo path
        <input
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          required
        />
      </label>
      <label>
        risk level
        <select
          value={riskLevel}
          onChange={(e) => setRiskLevel(e.target.value as RiskLevel)}
        >
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </label>
      <button type="submit" disabled={busy}>
        {busy ? 'Creating…' : 'Create Mission'}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function PlanSection({
  mission,
  events,
  onChanged,
}: {
  mission: Mission;
  events: MissionEvent[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const proposed = [...events]
    .reverse()
    .find((e) => e.type === 'PLAN_PROPOSED');
  const plan = proposed
    ? ((proposed.payload as { plan?: Plan }).plan ?? null)
    : null;

  const canPlan = mission.state === 'DRAFT' || mission.state === 'PLANNING';
  const awaiting = mission.state === 'AWAITING_PLAN_APPROVAL';
  if (!canPlan && !awaiting && !plan) return null;

  return (
    <section className="plan">
      <h3>Plan</h3>
      {error && <p className="error">{error}</p>}

      {canPlan && (
        <button
          className="primary"
          disabled={busy}
          onClick={() => void act(() => startPlanning(mission.missionId))}
        >
          {busy ? 'Working…' : 'Start planning'}
        </button>
      )}

      {plan && (
        <div className="plan-body">
          <p className="plan-summary">{plan.summary}</p>
          <p className="mono plan-meta">
            complexity: {plan.estimatedComplexity}
          </p>

          <h4 className="mono">Steps</h4>
          <ol className="plan-steps">
            {plan.steps.map((s) => (
              <li key={s.n}>
                <strong>{s.title}</strong> — {s.detail}
                {s.filesLikelyTouched.length > 0 && (
                  <span className="mono files">
                    {' '}
                    [{s.filesLikelyTouched.join(', ')}]
                  </span>
                )}
              </li>
            ))}
          </ol>

          {plan.risks.length > 0 && (
            <>
              <h4 className="mono">Risks</h4>
              <ul className="plan-risks">
                {plan.risks.map((r, i) => (
                  <li key={i}>
                    <span className={`mono badge badge-${r.severity}`}>
                      {r.severity}
                    </span>{' '}
                    {r.description}
                  </li>
                ))}
              </ul>
            </>
          )}

          {plan.openQuestions.length > 0 && (
            <>
              <h4 className="mono">Open questions</h4>
              <ul>
                {plan.openQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </>
          )}

          {awaiting && (
            <div className="plan-actions">
              <button
                className="primary"
                disabled={busy}
                onClick={() => void act(() => approvePlan(mission.missionId))}
              >
                Approve plan
              </button>
              <input
                placeholder="rejection reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <button
                disabled={busy || reason.trim().length === 0}
                onClick={() =>
                  void act(async () => {
                    await rejectPlan(mission.missionId, reason.trim());
                    setReason('');
                  })
                }
              >
                Reject
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith('diff --git') || line.startsWith('index ')) return 'd-file';
  if (line.startsWith('@@')) return 'd-hunk';
  if (line.startsWith('+')) return 'd-add';
  if (line.startsWith('-')) return 'd-del';
  return 'd-ctx';
}

function BuildSection({ mission }: { mission: Mission }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [diff, setDiff] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewResult | null>(null);

  const load = useCallback(async () => {
    try {
      setArtifacts(await fetchArtifacts(mission.missionId));
      // latest reviewer verdict from worker trajectories
      const workers = await fetchWorkers(mission.missionId);
      const reviewers = workers.filter((w) => w.role === 'reviewer');
      const last = reviewers[reviewers.length - 1];
      if (last) {
        const events = await fetchWorkerEvents(last.workerId);
        const result = [...events]
          .reverse()
          .find((e) => e.type === 'REVIEW_RESULT');
        setReview(result ? (result.payload as unknown as ReviewResult) : null);
      }
    } catch {
      /* build API optional in dev */
    }
  }, [mission.missionId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const buildable = mission.state === 'BUILDING';
  if (!buildable && artifacts.length === 0 && !review) return null;

  return (
    <section className="build">
      <h3>Build</h3>
      {error && <p className="error">{error}</p>}
      {buildable && (
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            startBuild(mission.missionId)
              .then(() => load())
              .catch((e) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Working…' : 'Start build'}
        </button>
      )}

      {review && (
        <div className="review-box">
          <p>
            <span className={`mono chip chip-${review.verdict === 'approve' ? 'EXITED' : 'FAILED'}`}>
              {review.verdict}
            </span>{' '}
            {review.summary}
          </p>
          {review.comments.length > 0 && (
            <ul>
              {review.comments.map((cm, i) => (
                <li key={i}>
                  <span className={`mono badge badge-${cm.severity === 'must_fix' ? 'high' : cm.severity === 'should_fix' ? 'medium' : 'low'}`}>
                    {cm.severity}
                  </span>{' '}
                  <span className="mono files">{cm.file ?? '(general)'}</span> {cm.body}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {artifacts.length > 0 && (
        <div className="artifact-list">
          {artifacts.map((a) => (
            <button
              key={a.id}
              className="worker-chip"
              onClick={() =>
                void fetchArtifactContent(a.id)
                  .then((r) => setDiff(r.content))
                  .catch((e) => setError(String(e)))
              }
            >
              <span className="mono">{a.type}</span>
              <span className="mono small">
                {a.stats.files} files +{a.stats.insertions} −{a.stats.deletions} ·{' '}
                {a.stats.commits} commits
              </span>
            </button>
          ))}
        </div>
      )}

      {diff !== null && (
        <pre className="diff-view">
          {diff.split('\n').map((line, i) => (
            <span key={i} className={diffLineClass(line)}>
              {line}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
    </section>
  );
}

function ScanSection({ mission }: { mission: Mission }) {
  const [scan, setScan] = useState<ScanInfo | null>(null);
  const [findings, setFindings] = useState<ScanFinding[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setScan(await fetchScan(mission.missionId));
    } catch {
      /* scan API optional in dev */
    }
  }, [mission.missionId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const scannable = mission.state === 'SCANNING';
  if (!scan && !scannable) return null;

  const showFindings = async () => {
    if (!scan?.sarifArtifactId) return;
    try {
      const res = await fetch(`/api/artifacts/${scan.sarifArtifactId}`);
      const body = await res.json();
      setFindings(parseSarifFindings(body.content));
      setExpanded(true);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <section className="scan">
      <h3>Security Scan</h3>
      {error && <p className="error">{error}</p>}
      {scannable && (
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            startScan(mission.missionId)
              .then(() => load())
              .catch((e) => setError(String(e)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Working…' : scan ? 'Re-run scan' : 'Run scan'}
        </button>
      )}
      {scannable && !scan && (
        <p className="mono small">scan runs automatically after a build completes</p>
      )}
      {scan && (
        <div className="scan-box">
          <p>
            <span
              className={`mono chip chip-${
                scan.status === 'PASSED' ? 'EXITED' : 'FAILED'
              }`}
            >
              {scan.status}
            </span>{' '}
            <span className="mono small">
              {scan.counts.errors} errors · {scan.counts.warnings} warnings ·{' '}
              {scan.counts.notes} notes
            </span>
          </p>
          {scan.status === 'FAILED' && (
            <p className="mono small route-note">
              scan failed — mission routed back to building for rework
            </p>
          )}
          {scan.status === 'ATTEMPT_FAILED' && (
            <p className="mono small route-note">
              scanner crashed — mission still scanning; re-run when ready
              {scan.stderrTail && (
                <>
                  <br />
                  {scan.stderrTail.slice(-200)}
                </>
              )}
            </p>
          )}
          <p className="mono small">
            {Object.entries(scan.toolBreakdown).map(([tool, c]) => (
              <span key={tool} className="tool-chip">
                {tool}: {c.errors}e/{c.warnings}w/{c.notes}n
              </span>
            ))}
          </p>
          {scan.sarifArtifactId && (
            <p className="mono small">
              <button className="linkish" onClick={() => void showFindings()}>
                {expanded ? 'findings:' : 'show findings'}
              </button>{' '}
              <a
                href={`/api/artifacts/${scan.sarifArtifactId}`}
                target="_blank"
                rel="noopener"
              >
                raw SARIF ↗
              </a>
            </p>
          )}
          {expanded && findings && (
            <ul className="findings">
              {findings.length === 0 && <li className="mono small">no findings</li>}
              {findings.map((f, i) => (
                <li key={i}>
                  <span
                    className={`mono badge badge-${
                      f.level === 'error' ? 'high' : f.level === 'warning' ? 'medium' : 'low'
                    }`}
                  >
                    {f.level}
                  </span>{' '}
                  <span className="mono">{f.tool}</span>{' '}
                  <span className="mono">{f.ruleId}</span>{' '}
                  <span className="mono files">
                    {f.file ?? '?'}:{f.line ?? '?'}
                  </span>{' '}
                  {f.message.slice(0, 200)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function WorkersSection({ missionId }: { missionId: string }) {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [trajectory, setTrajectory] = useState<WorkerEvent[]>([]);

  const load = useCallback(async () => {
    try {
      const list = await fetchWorkers(missionId);
      setWorkers(list);
      const target = selected ?? list[list.length - 1]?.workerId ?? null;
      if (target) {
        setTrajectory(await fetchWorkerEvents(target));
      }
    } catch {
      /* workers API optional in dev */
    }
  }, [missionId, selected]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  if (workers.length === 0) return null;

  const active = selected ?? workers[workers.length - 1]?.workerId;

  return (
    <section className="workers">
      <h3>Workers</h3>
      <div className="worker-chips">
        {workers.map((w) => (
          <button
            key={w.workerId}
            className={`worker-chip ${w.workerId === active ? 'active' : ''}`}
            onClick={() => setSelected(w.workerId)}
          >
            <span className="mono">{w.role}</span>
            <span className={`mono chip chip-${w.status}`}>
              {w.status}
              {w.reason ? `:${w.reason}` : ''}
            </span>
          </button>
        ))}
      </div>
      <ol className="trajectory">
        {trajectory.map((e) => (
          <li key={e.id}>
            <span className="mono seq">#{e.seq}</span>
            <span className="mono type">{e.type}</span>
            <span className="mono feed-body">
              {summarizeWorkerEvent(e)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function summarizeWorkerEvent(e: WorkerEvent): string {
  const p = e.payload;
  switch (e.type) {
    case 'MODEL_MESSAGE':
      return String(p.text ?? '').slice(0, 280);
    case 'TOOL_CALL':
      return `${String(p.tool ?? '')} ${String(p.args ?? '').slice(0, 200)}`;
    case 'TOOL_RESULT':
      return `${String(p.tool ?? '')} → ${String(p.result ?? '').slice(0, 200)}`;
    case 'AGENT_STATUS':
      return String(p.message ?? '').slice(0, 200);
    case 'WORKER_FAILED':
      return `${String(p.reason ?? '')} ${String(p.lastStderr ?? '').slice(0, 160)}`;
    default:
      return JSON.stringify(p).slice(0, 200);
  }
}

function MissionDetail({
  missionId,
  onBack,
}: {
  missionId: string;
  onBack: () => void;
}) {
  const [mission, setMission] = useState<Mission | null>(null);
  const [events, setEvents] = useState<MissionEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchMission(missionId);
      setMission(data.mission);
      setEvents(data.events);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [missionId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="detail">
      <button className="back" onClick={onBack}>
        ← Board
      </button>
      {error && <p className="error">{error}</p>}
      {mission && (
        <>
          <h2>{mission.title}</h2>
          <p className="meta">
            <span className={`state state-${mission.state}`}>
              {mission.state}
            </span>
            <span className="mono">risk: {mission.riskLevel}</span>
            <span className="mono">{mission.repoPath}</span>
          </p>
          <p className="objective">{mission.objective}</p>
          <h3>Event Timeline</h3>
          <ol className="timeline">
            {events.map((e) => (
              <li key={e.id}>
                <span className="mono seq">#{e.seq}</span>
                <span className="mono type">{e.type}</span>
                <span className="mono time">
                  {new Date(e.recordedAt).toLocaleString()}
                </span>
                {Object.keys(e.payload).length > 0 && (
                  <pre className="payload">
                    {JSON.stringify(e.payload, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ol>
          <PlanSection
            mission={mission}
            events={events}
            onChanged={() => void load()}
          />
          <BuildSection mission={mission} />
          <ScanSection mission={mission} />
          <WorkersSection missionId={missionId} />
        </>
      )}
    </div>
  );
}

export default function App() {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMissions(await fetchMissions());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="app">
      <header>
        <h1>
          AGENT LEGION <span className="mono sub">/ mission board</span>
        </h1>
      </header>
      {error && <p className="error">api unreachable: {error}</p>}
      {selected ? (
        <MissionDetail missionId={selected} onBack={() => setSelected(null)} />
      ) : (
        <>
          <NewMissionForm onCreated={() => void load()} />
          <div className="columns">
            {COLUMNS.map((col) => {
              const items = missions.filter((m) =>
                col.states.includes(m.state),
              );
              return (
                <section className="column" key={col.label}>
                  <h2 className="mono">
                    {col.label} <span className="count">{items.length}</span>
                  </h2>
                  {items.map((m) => (
                    <button
                      className="card"
                      key={m.missionId}
                      onClick={() => setSelected(m.missionId)}
                    >
                      <span className="card-title">{m.title}</span>
                      <span className={`mono state state-${m.state}`}>
                        {m.state}
                      </span>
                      <span className="mono small">
                        risk {m.riskLevel} · {m.eventCount} events
                      </span>
                    </button>
                  ))}
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
