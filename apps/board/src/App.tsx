import { useCallback, useEffect, useState } from 'react';
import {
  fetchMission,
  fetchMissions,
  fetchWorkerEvents,
  fetchWorkers,
  postMission,
  type Mission,
  type MissionEvent,
  type MissionState,
  type RiskLevel,
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
