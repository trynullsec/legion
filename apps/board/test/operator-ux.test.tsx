/**
 * M5.5 operator-UX smokes: one next action, live-status instead of buttons,
 * error sentences, first-run checklist. Fetch is stubbed at the boundary;
 * rendering is real.
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

const MISSION = {
  missionId: 'm-1',
  state: 'DRAFT',
  title: 'Demo mission',
  objective: 'demo',
  repoPath: '/tmp/demo',
  riskLevel: 'low',
  createdAt: '2026-06-11T08:00:00.000000Z',
  updatedAt: '2026-06-11T08:00:00.000000Z',
  eventCount: 1,
};

const EVENTS = [
  {
    id: 'e-1',
    missionId: 'm-1',
    seq: 1,
    type: 'MISSION_CREATED',
    payload: {},
    validFrom: '2026-06-11T08:00:00.000000Z',
    recordedAt: '2026-06-11T08:00:00.000000Z',
  },
];

interface StubConfig {
  state: string;
  workers?: unknown[];
  planPost?: { status: number; body: unknown };
  registered?: boolean;
  missions?: unknown[] | null; // null = default single mission
}

function stubFetch(cfg: StubConfig) {
  const mission = { ...MISSION, state: cfg.state };
  const missions = cfg.missions === null || cfg.missions === undefined
    ? [mission]
    : cfg.missions;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/api/auth/approver/status')) {
        return json({ registered: cfg.registered ?? true });
      }
      if (method === 'POST' && /\/api\/missions\/[^/]+\/plan$/.test(url)) {
        const r = cfg.planPost ?? { status: 202, body: { workerId: 'w' } };
        return json(r.body, r.status);
      }
      if (/\/api\/missions\/[^/]+\/workers$/.test(url)) {
        return json({ workers: cfg.workers ?? [] });
      }
      if (/\/api\/missions\/[^/]+\/scan$/.test(url)) {
        return json({ scan: null });
      }
      if (/\/api\/missions\/[^/]+\/artifacts$/.test(url)) {
        return json({ artifacts: [] });
      }
      if (/\/api\/missions\/[^/]+\/approval$/.test(url)) {
        return json({ approvals: [], hashes: null });
      }
      if (/\/api\/workers\/[^/]+\/events$/.test(url)) {
        return json({ events: [] });
      }
      if (/\/api\/missions\/[^/]+$/.test(url)) {
        return json({ mission, events: EVENTS });
      }
      if (url.includes('/api/missions')) {
        return json({ missions });
      }
      return json({});
    }),
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.restoreAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.removeChild(container);
});

async function renderApp() {
  await act(async () => {
    root = createRoot(container);
    root.render(<App />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 25));
  });
}

async function openMission() {
  const card = container.querySelector<HTMLButtonElement>('.card');
  expect(card).toBeTruthy();
  await act(async () => {
    card!.click();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 25));
  });
}

describe('M5.5 operator UX', () => {
  it('DRAFT shows exactly one primary action (Start planning)', async () => {
    stubFetch({ state: 'DRAFT' });
    await renderApp();
    await openMission();

    const primaries = container.querySelectorAll('.btn-primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]!.textContent).toContain('Start planning');
    expect(container.querySelector('.action-bar')).toBeTruthy();
  });

  it('a live planner replaces the button with a status line — nothing to 409', async () => {
    stubFetch({
      state: 'PLANNING',
      workers: [
        {
          workerId: 'w-1', missionId: 'm-1', role: 'planner', task: 't',
          workdir: '/x', pid: 1, status: 'RUNNING', reason: null,
          exitCode: null, createdAt: '2026-06-11T08:00:00.000000Z',
          updatedAt: '2026-06-11T08:00:00.000000Z', eventCount: 2,
        },
      ],
    });
    await renderApp();
    await openMission();

    expect(container.querySelector('.action-bar .btn')).toBeNull();
    expect(container.querySelector('.action-bar')?.textContent).toContain(
      'Planner is reading your repository',
    );
  });

  it('a forced 409 renders as a quiet sentence, not a JSON dump', async () => {
    stubFetch({
      state: 'DRAFT',
      planPost: { status: 409, body: { error: 'PLANNING_IN_PROGRESS' } },
    });
    await renderApp();
    await openMission();

    const button = container.querySelector<HTMLButtonElement>(
      '.action-bar .btn-primary',
    );
    await act(async () => {
      button!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });

    const notice = container.querySelector('.notice');
    expect(notice?.textContent).toContain(
      'A planner is already running for this mission.',
    );
    expect(notice?.textContent).not.toContain('409');
    expect(notice?.textContent).not.toContain('{');
  });

  it('first-run checklist appears on an empty install and clears when done', async () => {
    stubFetch({ state: 'DRAFT', registered: false, missions: [] });
    await renderApp();
    const checklist = container.querySelector(
      '[data-testid="first-run-checklist"]',
    );
    expect(checklist).toBeTruthy();
    expect(checklist!.querySelectorAll('li')).toHaveLength(3);
    await act(async () => root.unmount());

    // all three steps satisfied → checklist gone
    container = document.createElement('div');
    document.body.appendChild(container);
    stubFetch({
      state: 'MERGED',
      registered: true,
      missions: [{ ...MISSION, state: 'MERGED' }],
    });
    await renderApp();
    expect(
      container.querySelector('[data-testid="first-run-checklist"]'),
    ).toBeNull();
  });
});
