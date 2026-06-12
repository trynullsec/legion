/**
 * T69 — board smoke: the Schedules view renders the list with computed next
 * run, and a scheduled mission's card carries the SCHEDULED tag. Fetch is
 * stubbed at the boundary; rendering is real.
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

const SCHEDULED_MISSION = {
  missionId: 'm-sched',
  state: 'PLANNING',
  title: 'Nightly audit',
  objective: 'demo',
  kind: 'code',
  repoPath: '/tmp/demo',
  deliverTo: null,
  scheduledBy: 'sch-1',
  riskLevel: 'low',
  createdAt: T0,
  updatedAt: T0,
  eventCount: 2,
};

const SCHEDULE = {
  id: 'sch-1',
  name: 'nightly-audit',
  cron: '0 3 * * *',
  template: {
    kind: 'code', title: 'Nightly audit', objective: 'demo',
    repoPath: '/tmp/demo', riskLevel: 'low',
  },
  enabled: true,
  createdAt: T0,
  updatedAt: T0,
  nextRunAt: '2026-06-13T03:00:00.000Z',
  lastOutcome: 'CREATED',
  lastFiredAt: T0,
};

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/approver/status')) return json({ registered: true });
      if (url.endsWith('/api/schedules')) return json({ schedules: [SCHEDULE] });
      if (/\/api\/missions\/[^/]+\/workers$/.test(url)) return json({ workers: [] });
      if (/\/api\/missions\/[^/]+$/.test(url)) return json({ mission: SCHEDULED_MISSION, events: [] });
      if (url.includes('/api/missions')) return json({ missions: [SCHEDULED_MISSION] });
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

async function render() {
  await act(async () => {
    root = createRoot(container);
    root.render(<App />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 25));
  });
}

describe('T69: schedules view + scheduled tag', () => {
  it('a scheduled mission card carries the SCHEDULED tag', async () => {
    await render();
    const tag = container.querySelector('[data-testid="scheduled-tag"]');
    expect(tag).toBeTruthy();
    expect(tag!.textContent).toContain('SCHEDULED');
  });

  it('the Schedules view renders the list with name, cron, and next run', async () => {
    await render();
    // click the Schedules nav button
    const navButtons = Array.from(container.querySelectorAll('.view-nav .linkish'));
    const schedulesBtn = navButtons.find((b) => b.textContent === 'Schedules') as HTMLButtonElement;
    expect(schedulesBtn).toBeTruthy();
    await act(async () => {
      schedulesBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });

    const table = container.querySelector('[data-testid="schedules-table"]');
    expect(table).toBeTruthy();
    const text = table!.textContent ?? '';
    expect(text).toContain('nightly-audit');
    expect(text).toContain('0 3 * * *');
    expect(text).toContain('2026-06-13T03:00:00Z'); // computed next run
  });
});
