/**
 * T92 (M8) — board smoke: an open mission renders live tool activity
 * (terminal/code/file/browser/web) from the worker trajectory, and the
 * /workspace deliverable file tree at the gate. Fetch stubbed; rendering real.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const T0 = '2026-06-15T08:00:00.000000Z';

const OPEN_MISSION = {
  missionId: 'm-open8',
  state: 'AWAITING_MERGE_APPROVAL',
  title: 'Full-capability research',
  objective: 'compute stats and write a report',
  kind: 'open',
  repoPath: null,
  deliverTo: null,
  scheduledBy: null,
  riskLevel: 'open-readonly',
  createdAt: T0,
  updatedAt: T0,
  eventCount: 9,
};

const WORKER = {
  workerId: 'w-open8', missionId: 'm-open8', role: 'worker', task: 't',
  workdir: '/x', pid: 1, status: 'EXITED', reason: null, exitCode: 0,
  createdAt: T0, updatedAt: T0, eventCount: 5,
};

// a trajectory exercising the M8 tool surface
const WORKER_EVENTS = [
  { id: 'we1', missionId: 'm-open8', workerId: 'w-open8', seq: 1, type: 'WORKER_CREATED', payload: { role: 'worker' }, recordedAt: T0 },
  { id: 'we2', missionId: 'm-open8', workerId: 'w-open8', seq: 2, type: 'TOOL_CALL', payload: { tool: 'web_search', args: '{"query":"sqlite"}' }, recordedAt: T0 },
  { id: 'we3', missionId: 'm-open8', workerId: 'w-open8', seq: 3, type: 'TOOL_CALL', payload: { tool: 'execute_code', args: '{"language":"python"}' }, recordedAt: T0 },
  { id: 'we4', missionId: 'm-open8', workerId: 'w-open8', seq: 4, type: 'TOOL_CALL', payload: { tool: 'write_file', args: '{"path":"/workspace/report.md"}' }, recordedAt: T0 },
  { id: 'we5', missionId: 'm-open8', workerId: 'w-open8', seq: 5, type: 'WORKER_EXITED', payload: { exitCode: 0 }, recordedAt: T0 },
];

const PREVIEW = {
  archive: true,
  sha256: 'abc',
  files: [
    { name: 'report.md', sha256: 'a', content: '# Report\n\nThe mean is 6.\n', truncated: false },
    { name: 'data.csv', sha256: 'b', content: 'n,v\n1,2\n', truncated: false },
  ],
};

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/approver/status')) return json({ registered: true });
      if (/\/api\/missions\/[^/]+\/workers$/.test(url)) return json({ workers: [WORKER] });
      if (/\/api\/workers\/[^/]+\/events$/.test(url)) return json({ events: WORKER_EVENTS });
      if (/\/api\/missions\/[^/]+\/scan$/.test(url)) return json({ scan: null });
      if (/\/api\/missions\/[^/]+\/artifacts$/.test(url)) return json({ artifacts: [] });
      if (/\/api\/missions\/[^/]+\/approval$/.test(url)) return json({ approvals: [], hashes: { diff: 'abc', sarif: 'f' } });
      if (/\/api\/missions\/[^/]+\/deliverable$/.test(url)) return json({ deliverable: PREVIEW });
      if (/\/api\/missions\/[^/]+$/.test(url)) return json({ mission: OPEN_MISSION, events: [] });
      if (url.includes('/api/missions')) return json({ missions: [OPEN_MISSION] });
      return json({});
    }),
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.restoreAllMocks();
  stubFetch();
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.removeChild(container);
});

async function renderAndOpen() {
  await act(async () => {
    root = createRoot(container);
    root.render(<App />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  const card = container.querySelector<HTMLButtonElement>('.card');
  await act(async () => card!.click());
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
}

describe('T92: open-mission board — live tools + workspace tree', () => {
  it('renders live tool activity from the trajectory', async () => {
    await renderAndOpen();
    const text = container.textContent ?? '';
    expect(text).toContain('Searched the web');
    expect(text).toContain('Ran code');
    expect(text).toContain('Wrote /workspace/report.md');
  });

  it('shows the /workspace file tree at the gate', async () => {
    await renderAndOpen();
    const tree = container.querySelector('[data-testid="workspace-tree"]');
    expect(tree).toBeTruthy();
    expect(tree!.textContent).toContain('report.md');
    expect(tree!.textContent).toContain('data.csv');
    expect(tree!.textContent).toMatch(/workspace · 2 files/);
  });
});
