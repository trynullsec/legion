/**
 * T61 (M6b) — board smoke: risk-policy notices. Low-risk detail shows the
 * express notice once the policy fired; high-risk shows the strict-scan
 * notice. Fetch is stubbed at the boundary; rendering is real.
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

const T0 = '2026-06-12T08:00:00.000000Z';

function mission(riskLevel: string, state: string) {
  return {
    missionId: 'm-1',
    state,
    title: 'Risk mission',
    objective: 'demo',
    kind: 'task',
    repoPath: null,
    deliverTo: null,
    riskLevel,
    createdAt: T0,
    updatedAt: T0,
    eventCount: 1,
  };
}

function events(withAutoApproval: boolean) {
  const base = [
    { id: 'e-1', missionId: 'm-1', seq: 1, type: 'MISSION_CREATED', payload: {}, validFrom: T0, recordedAt: T0 },
  ];
  if (!withAutoApproval) return base;
  return [
    ...base,
    { id: 'e-2', missionId: 'm-1', seq: 2, type: 'PLANNING_STARTED', payload: {}, validFrom: T0, recordedAt: T0 },
    {
      id: 'e-3', missionId: 'm-1', seq: 3, type: 'PLAN_PROPOSED',
      payload: {
        plan: {
          summary: 's', estimatedComplexity: 'trivial', risks: [], openQuestions: [],
          steps: [{ n: 1, title: 't', detail: 'd', filesLikelyTouched: [] }],
        },
      },
      validFrom: T0, recordedAt: T0,
    },
    {
      id: 'e-4', missionId: 'm-1', seq: 4, type: 'PLAN_APPROVED',
      payload: { autoApproved: true, policy: 'risk:low' },
      validFrom: T0, recordedAt: T0,
    },
  ];
}

function stubFetch(m: ReturnType<typeof mission>, evts: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/approver/status')) return json({ registered: true });
      if (/\/api\/missions\/[^/]+\/workers$/.test(url)) return json({ workers: [] });
      if (/\/api\/missions\/[^/]+\/scan$/.test(url)) return json({ scan: null });
      if (/\/api\/missions\/[^/]+\/artifacts$/.test(url)) return json({ artifacts: [] });
      if (/\/api\/missions\/[^/]+\/approval$/.test(url)) return json({ approvals: [], hashes: null });
      if (/\/api\/missions\/[^/]+\/deliverable$/.test(url)) return json({ deliverable: null });
      if (/\/api\/workers\/[^/]+\/events$/.test(url)) return json({ events: [] });
      if (/\/api\/missions\/[^/]+$/.test(url)) return json({ mission: m, events: evts });
      if (url.includes('/api/missions')) return json({ missions: [m] });
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

async function renderAndOpen() {
  await act(async () => {
    root = createRoot(container);
    root.render(<App />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 25));
  });
  const card = container.querySelector<HTMLButtonElement>('.card');
  expect(card).toBeTruthy();
  await act(async () => {
    card!.click();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 25));
  });
}

describe('T61: risk-policy notices', () => {
  it('low-risk detail shows the express notice after the policy fired', async () => {
    stubFetch(mission('low', 'BUILDING'), events(true));
    await renderAndOpen();
    const text = container.textContent ?? '';
    expect(text).toContain('EXPRESS · PLAN AUTO-APPROVED');
    expect(text).toContain('risk:low');
  });

  it('low-risk detail shows no express notice before the policy fired', async () => {
    stubFetch(mission('low', 'DRAFT'), events(false));
    await renderAndOpen();
    expect(container.textContent).not.toContain('EXPRESS · PLAN AUTO-APPROVED');
  });

  it('high-risk detail shows the strict-scan notice', async () => {
    stubFetch(mission('high', 'DRAFT'), events(false));
    await renderAndOpen();
    expect(container.textContent).toContain('STRICT SCAN · WARNINGS BLOCK');
  });
});
