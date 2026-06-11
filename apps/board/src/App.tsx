import { useCallback, useEffect, useState } from 'react';
import {
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import {
  approvalOptions,
  fetchApproval,
  isApproverRegistered,
  submitApprove,
  submitReject,
  type ApprovalInfo,
} from './api';
import {
  ApiError,
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
import {
  errorSentence,
  nextAction,
  summarizeEvent,
  timeAgo,
  type LiveWorkerInfo,
} from './ux';

const POLL_MS = 5000;

/** The 4-point star glyph (matches the wordmark); spins while loading. */
function Star({ spin = false, size = 14 }: { spin?: boolean; size?: number }) {
  return (
    <svg
      className={`star ${spin ? 'spin' : ''}`}
      width={size}
      height={size}
      viewBox="-100 -100 200 200"
      aria-hidden="true"
    >
      <path
        d="M 0,-100 Q 0,0 100,0 Q 0,0 0,100 Q 0,0 -100,0 Q 0,0 0,-100 Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Section divider: hairline with a centered mono label + optional hint. */
function Divider({ label, hint }: { label: string; hint?: string }) {
  return (
    <>
      <div className="divider" role="heading" aria-level={3} aria-label={label}>
        <span>{label}</span>
      </div>
      {hint && <p className="divider-hint">{hint}</p>}
    </>
  );
}

/** A quiet, in-context error sentence; unknown codes get a RAW disclosure. */
function Notice({ error }: { error: unknown | null }) {
  if (!error) return null;
  // plain strings are already sentences (e.g. cancelled passkey prompts)
  if (typeof error === 'string') {
    return (
      <div className="notice mono" role="alert">
        {error}
      </div>
    );
  }
  const code = error instanceof ApiError ? error.code : String(error);
  const raw =
    error instanceof ApiError ? error.raw : String((error as Error)?.message ?? error);
  const sentence = errorSentence(code);
  const unknown = sentence.startsWith('Something failed');
  return (
    <div className="notice mono" role="alert">
      {sentence}
      {unknown && (
        <details className="notice-raw">
          <summary>RAW</summary>
          <pre>{raw}</pre>
        </details>
      )}
    </div>
  );
}

/** Corner registration marks (⌐) for framed surfaces. */
function Corners() {
  return (
    <>
      <span className="corner corner-tl" aria-hidden="true" />
      <span className="corner corner-tr" aria-hidden="true" />
      <span className="corner corner-bl" aria-hidden="true" />
      <span className="corner corner-br" aria-hidden="true" />
    </>
  );
}

function midTruncate(s: string, keep = 12): string {
  return s.length <= keep * 2 + 1 ? s : `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

/** Full-width mono hash row; click copies the full value. */
function HashRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="hash-row"
      type="button"
      title={value}
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      <span className="hash-label">{label}</span>
      <span className="hash-value">{midTruncate(value, 16)}</span>
      <span className="hash-copy">{copied ? 'COPIED' : 'COPY'}</span>
    </button>
  );
}

/**
 * Run the full approver registration ceremony. Returns ok + a plain-language
 * notice for the two real failure modes (cancel/timeout, no platform
 * authenticator). The server options never pin authenticatorAttachment, so
 * the browser's cross-device (QR) path stays available.
 */
async function performRegistration(): Promise<{
  ok: boolean;
  notice: string | null;
}> {
  try {
    const optsRes = await fetch('/api/auth/approver/register-options', {
      method: 'POST',
    });
    if (!optsRes.ok) {
      const body = (await optsRes.json()) as { error?: string };
      return { ok: false, notice: body.error ?? 'registration unavailable' };
    }
    const { options } = (await optsRes.json()) as { options: never };
    const attestation = await startRegistration({ optionsJSON: options });
    const res = await fetch('/api/auth/approver/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response: attestation }),
    });
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      return { ok: false, notice: body.error ?? 'registration failed' };
    }
    return { ok: true, notice: null };
  } catch (e) {
    const err = e as { name?: string; cause?: { name?: string } };
    const names = [err.name, err.cause?.name];
    if (names.includes('NotAllowedError') || /time[d ]?out/i.test(String(e))) {
      return {
        ok: false,
        notice: 'Registration was cancelled or timed out — try again.',
      };
    }
    return { ok: false, notice: String((e as Error).message ?? e) };
  }
}

/** Pre-flight hint when this machine has no platform authenticator. */
async function platformAuthHint(): Promise<string | null> {
  try {
    const available =
      await window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.();
    return available
      ? null
      : 'No Touch ID on this machine — choose your iPhone in the browser prompt (QR)';
  } catch {
    return null;
  }
}

/** Shared register button: header and approval panel run the same flow. */
function RegisterApproverButton({
  label,
  onRegistered,
}: {
  label: string;
  onRegistered: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setNotice(null);
    const hint = await platformAuthHint();
    if (hint) setNotice(hint);
    const result = await performRegistration();
    if (result.ok) {
      setNotice(null);
      onRegistered();
    } else if (result.notice) {
      setNotice(result.notice);
    }
    setBusy(false);
  };

  return (
    <span className="register-wrap">
      <button className="btn" disabled={busy} onClick={() => void run()}>
        {busy && <Star spin />} {label}
      </button>
      {notice && <span className="mono small register-notice">{notice}</span>}
    </span>
  );
}

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
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [riskLevel, setRiskLevel] = useState<RiskLevel>('low');
  const [error, setError] = useState<unknown | null>(null);
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
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="btn new-mission-toggle" onClick={() => setOpen(true)}>
        + New Mission
      </button>
    );
  }

  return (
    <form className="new-mission" onSubmit={submit}>
      <div className="new-mission-head">
        <span className="label">New Mission</span>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => setOpen(false)}
        >
          Close
        </button>
      </div>
      <label>
        title
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <span className="field-help">Like a ticket title</span>
      </label>
      <label>
        objective
        <textarea
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          rows={3}
          required
        />
        <span className="field-help">
          What should change, where, and what proves it worked — agents read
          this verbatim
        </span>
      </label>
      <label>
        repo path
        <input
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          required
        />
        <span className="field-help">
          Absolute path to a local git repository
        </span>
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
        <span className="field-help">Display-only for now</span>
      </label>
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy && <Star spin />} {busy ? 'Creating…' : 'Create Mission'}
      </button>
      <Notice error={error} />
    </form>
  );
}

/** First-run checklist: appears on a fresh install, checks off live. */
function FirstRunChecklist({
  registered,
  missions,
}: {
  registered: boolean | null;
  missions: Mission[];
}) {
  const stepRegistered = registered === true;
  const stepCreated = missions.length > 0;
  const POST_PLAN: MissionState[] = [
    'BUILDING',
    'SCANNING',
    'AWAITING_MERGE_APPROVAL',
    'MERGED',
  ];
  const stepApproved = missions.some((m) => POST_PLAN.includes(m.state));
  if (stepRegistered && stepCreated && stepApproved) return null;
  if (registered === null) return null; // status unknown — don't flash

  const steps = [
    { done: stepRegistered, text: 'Register your passkey' },
    { done: stepCreated, text: 'Create your first mission' },
    { done: stepApproved, text: 'Approve the plan when it arrives' },
  ];

  return (
    <div className="checklist" data-testid="first-run-checklist">
      <span className="label">Getting started</span>
      <ol>
        {steps.map((s, i) => (
          <li key={i} className={s.done ? 'done' : ''}>
            <span className="mono check-num">
              {s.done ? '✓' : String(i + 1)}
            </span>
            {s.text}
          </li>
        ))}
      </ol>
    </div>
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
  const [error, setError] = useState<unknown | null>(null);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err);
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

  const awaiting = mission.state === 'AWAITING_PLAN_APPROVAL';
  if (!awaiting && !plan) return null;

  return (
    <section className="plan" id="plan-section">
      <Divider
        label="Plan"
        hint="Proposed by an agent that read your repo — approve it or reject with a reason."
      />
      <Notice error={error} />

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
                <span className="mono step-num">
                  {String(s.n).padStart(2, '0')}
                </span>
                <span className="step-body">
                  <strong>{s.title}</strong> — {s.detail}
                  {s.filesLikelyTouched.length > 0 && (
                    <span className="mono files">
                      {' '}
                      [{s.filesLikelyTouched.join(', ')}]
                    </span>
                  )}
                </span>
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
                className="btn btn-primary"
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
                className="btn btn-danger"
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
  const [error, setError] = useState<unknown | null>(null);
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

  if (mission.state !== 'BUILDING' && artifacts.length === 0 && !review) {
    return null;
  }

  return (
    <section className="build">
      <Divider
        label="Build"
        hint="A coder agent implements the plan with real commits; a reviewer agent reads the diff before you ever see it."
      />
      <Notice error={error} />

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
                  .catch((e) => setError(e))
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

function MergedBanner({ missionId }: { missionId: string }) {
  const [commit, setCommit] = useState<string | null>(null);
  useEffect(() => {
    void fetchMission(missionId).then((d) => {
      const merged = [...d.events].reverse().find((e) => e.type === 'MERGE_APPROVED');
      const mc = merged?.payload?.mergeCommit;
      setCommit(typeof mc === 'string' ? mc : null);
    });
  }, [missionId]);
  return (
    <section className="approval">
      <Divider label="Merged" />
      <div className="approval-box merged-box">
        <p className="mono small">
          This mission was approved with a passkey and merged into your
          repository.
        </p>
        {commit && <HashRow label="merge commit" value={commit} />}
      </div>
    </section>
  );
}

function ApprovalPanel({ mission }: { mission: Mission }) {
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [info, setInfo] = useState<ApprovalInfo | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRegistered(await isApproverRegistered());
      setInfo(await fetchApproval(mission.missionId));
    } catch {
      /* approval API optional in dev */
    }
  }, [mission.missionId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  if (mission.state !== 'AWAITING_MERGE_APPROVAL') return null;

  const runCeremony = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const options = await approvalOptions(mission.missionId);
      const assertion = await startAuthentication({ optionsJSON: options as never });
      if (decision === 'approve') {
        const r = await submitApprove(mission.missionId, assertion);
        if (r.error) setError(new ApiError(409, r.error, JSON.stringify(r)));
        else setStatus(`Merged — commit ${r.mergeCommit?.slice(0, 10)}.`);
      } else {
        await submitReject(mission.missionId, assertion, reason.trim());
        setStatus('Rejected — the mission went back to building with your reason.');
      }
      await load();
    } catch (e) {
      const name = (e as { name?: string }).name ?? '';
      if (name === 'NotAllowedError') {
        setError('The passkey prompt was cancelled or timed out — try again.');
      } else {
        setError(e);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="approval" id="gate-section">
      <Divider
        label="Human Gate — Merge Approval"
        hint="Your passkey signature approves these exact bytes."
      />
      <Notice error={error} />
      {status && <p className="mono small gate-status">{status}</p>}

      {registered === false && (
        <div className="approval-box">
          <p className="mono small">
            No approver registered — the gate cannot be crossed without a
            passkey.
          </p>
          <RegisterApproverButton
            label="Register approver to proceed"
            onRegistered={() => void load()}
          />
        </div>
      )}

      {registered && (
        <div className="approval-box approval-hero">
          {info?.hashes && (
            <div className="hash-block">
              <HashRow label="diff sha256" value={info.hashes.diff} />
              <HashRow label="sarif sha256" value={info.hashes.sarif} />
            </div>
          )}
          <button
            className="btn btn-primary btn-hero"
            disabled={busy}
            onClick={() => void runCeremony('approve')}
          >
            {busy && <Star spin size={18} />}{' '}
            {busy ? 'Working…' : 'Approve with passkey'}
          </button>
          <div className="plan-actions">
            <input
              placeholder="rejection reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              className="btn btn-danger"
              disabled={busy || reason.trim().length === 0}
              onClick={() => void runCeremony('reject')}
            >
              Reject…
            </button>
          </div>
          <p className="dispose-caption mono">
            THE LEGION PROPOSES · YOU DISPOSE
          </p>
          <p className="mono small">
            an approval is a passkey signature bound to the exact bytes above —
            tamper voids it
          </p>
        </div>
      )}
    </section>
  );
}

function ScanSection({ mission }: { mission: Mission }) {
  const [scan, setScan] = useState<ScanInfo | null>(null);
  const [findings, setFindings] = useState<ScanFinding[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

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
      setError(e);
    }
  };

  return (
    <section className="scan">
      <Divider
        label="Security Scan"
        hint="Every diff is scanned before you're asked to approve. Errors block; warnings are recorded."
      />
      <Notice error={error} />
      {scannable && !scan && (
        <p className="mono small">
          The scan starts automatically when a build completes.
        </p>
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
              The scan found blocking issues — this mission went back to
              building so an agent can fix them.
            </p>
          )}
          {scan.status === 'ATTEMPT_FAILED' && (
            <>
              <p className="mono small route-note">
                A scanner crashed before finishing — nothing was passed or
                failed. Run the scan again when ready.
              </p>
              {scannable && (
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setError(null);
                    startScan(mission.missionId)
                      .then(() => load())
                      .catch((e) => setError(e))
                      .finally(() => setBusy(false));
                  }}
                >
                  {busy && <Star spin />} {busy ? 'Working…' : 'Re-run scan'}
                </button>
              )}
            </>
          )}
          <table className="tool-table mono">
            <thead>
              <tr>
                <th>tool</th>
                <th>errors</th>
                <th>warnings</th>
                <th>notes</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(scan.toolBreakdown).map(([tool, c]) => (
                <tr key={tool}>
                  <td>{tool}</td>
                  <td>{c.errors}</td>
                  <td>{c.warnings}</td>
                  <td>{c.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
  const [raw, setRaw] = useState(false);

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

  // human feed: one sentence per meaningful event (display-only)
  const feed = trajectory
    .map((e) => ({ e, line: summarizeEvent(e) }))
    .filter((x): x is { e: WorkerEvent; line: { text: string; danger: boolean } } =>
      x.line !== null,
    );

  return (
    <section className="workers">
      <Divider
        label="Activity"
        hint="What the agents are doing, in plain words. RAW shows the full event stream."
      />
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
        <button
          className={`worker-chip raw-toggle ${raw ? 'active' : ''}`}
          onClick={() => setRaw((r) => !r)}
          aria-pressed={raw}
        >
          <span className="mono">RAW</span>
        </button>
      </div>

      {!raw && (
        <ol className="trajectory feed">
          {feed.map(({ e, line }) => (
            <li key={e.id} className={line.danger ? 'feed-danger' : ''}>
              <span className="mono time" title={e.recordedAt}>
                {timeAgo(e.recordedAt)}
              </span>
              <span className="feed-text">{line.text}</span>
            </li>
          ))}
          {feed.length === 0 && (
            <li className="mono small">Nothing to report yet.</li>
          )}
        </ol>
      )}

      {raw && (
        <ol className="trajectory">
          {trajectory.map((e) => (
            <li key={e.id}>
              <span className="mono seq">#{e.seq}</span>
              <span className="mono type">{e.type}</span>
              <span className="mono feed-body">{rawWorkerEvent(e)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function rawWorkerEvent(e: WorkerEvent): string {
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

/**
 * The single next human step, directly under the title. Buttons render only
 * when the action is actually available; live attempts show a status line
 * instead — there is nothing to click that could 409.
 */
function NextActionBar({
  mission,
  workers,
  events,
  onChanged,
}: {
  mission: Mission;
  workers: Worker[];
  events: MissionEvent[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const isLive = (w: Worker) => w.status === 'STARTING' || w.status === 'RUNNING';
  const live: LiveWorkerInfo = {
    hasLivePlanner: workers.some((w) => w.role === 'planner' && isLive(w)),
    hasLiveCoder: workers.some((w) => w.role === 'coder' && isLive(w)),
    hasLiveReviewer: workers.some((w) => w.role === 'reviewer' && isLive(w)),
  };
  const action = nextAction(mission.state, live);

  const run = async (kind: 'plan' | 'build') => {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'plan') await startPlanning(mission.missionId);
      else await startBuild(mission.missionId);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const mergeCommit =
    mission.state === 'MERGED'
      ? ([...events].reverse().find((e) => e.type === 'MERGE_APPROVED')
          ?.payload?.mergeCommit as string | undefined)
      : undefined;

  return (
    <div className="action-bar">
      {action.kind === 'button' && (
        <>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void run(action.action)}
          >
            {busy && <Star spin />} {busy ? 'Working…' : action.label}
          </button>
          <span className="action-help">{action.help}</span>
        </>
      )}
      {action.kind === 'scrollButton' && (
        <>
          <button
            className="btn btn-primary"
            onClick={() =>
              document
                .getElementById(action.target)
                ?.scrollIntoView({ behavior: 'smooth' })
            }
          >
            {action.label}
          </button>
          <span className="action-help">{action.help}</span>
        </>
      )}
      {action.kind === 'status' && (
        <span className="action-status mono">
          {action.spinning && <Star spin />} {action.text}
        </span>
      )}
      {action.kind === 'done' && (
        <span className="action-status mono">
          {action.text}
          {mergeCommit && (
            <span
              className="action-commit"
              title={mergeCommit}
            >{` commit ${mergeCommit.slice(0, 10)}`}</span>
          )}
        </span>
      )}
      <Notice error={error} />
    </div>
  );
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
  const [workers, setWorkers] = useState<Worker[]>([]);
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
    try {
      setWorkers(await fetchWorkers(missionId));
    } catch {
      /* workers API optional in dev */
    }
  }, [missionId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="detail">
      <Corners />
      <button className="btn back" onClick={onBack}>
        ← Board
      </button>
      {error && <p className="error">{error}</p>}
      {mission && (
        <>
          <h2>{mission.title}</h2>
          <NextActionBar
            mission={mission}
            workers={workers}
            events={events}
            onChanged={() => void load()}
          />
          <p className="meta">
            <span className={`state state-${mission.state}`}>
              {mission.state}
            </span>
            <span className="mono">risk: {mission.riskLevel}</span>
            <span className="mono">{mission.repoPath}</span>
          </p>
          <p className="objective">{mission.objective}</p>
          <Divider
            label="Event Ledger"
            hint="The mission's append-only history — every state change, in order."
          />
          <ol className="timeline">
            {events.map((e) => (
              <li key={e.id}>
                <span className="node" aria-hidden="true" />
                <span className="mono seq">
                  {String(e.seq).padStart(2, '0')}
                </span>
                <span className="mono type">{e.type}</span>
                <span className="mono time" title={e.recordedAt}>
                  {timeAgo(e.recordedAt)}
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
          <ApprovalPanel mission={mission} />
          {mission.state === 'MERGED' && (
            <MergedBanner missionId={mission.missionId} />
          )}
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
  const [registered, setRegistered] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      setMissions(await fetchMissions());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    try {
      setRegistered(await isApproverRegistered());
    } catch {
      /* status endpoint optional in dev */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="app">
      <header className="header-row">
        <h1>
          <Star size={18} /> NULLSEC LEGION{' '}
          <span className="mono sub">/ MISSION BOARD</span>
        </h1>
        {registered === false && (
          <RegisterApproverButton
            label="Register approver"
            onRegistered={() => void load()}
          />
        )}
      </header>
      {error && <p className="error">api unreachable: {error}</p>}
      {selected ? (
        <MissionDetail missionId={selected} onBack={() => setSelected(null)} />
      ) : (
        <div className="board-frame">
          <Corners />
          <FirstRunChecklist registered={registered} missions={missions} />
          <NewMissionForm onCreated={() => void load()} />
          <div className="columns">
            {COLUMNS.map((col) => {
              const items = missions.filter((m) =>
                col.states.includes(m.state),
              );
              return (
                <section className="column" key={col.label}>
                  <h2>
                    <span className="col-label">{col.label}</span>
                    <span className="count">{items.length}</span>
                  </h2>
                  {items.length === 0 && (
                    <p className="col-empty" aria-hidden="true">
                      —
                    </p>
                  )}
                  {items.map((m) => (
                    <button
                      className={`card card-${m.state}`}
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
        </div>
      )}
    </div>
  );
}
