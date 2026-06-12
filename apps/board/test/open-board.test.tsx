/**
 * T76 (M6d) — board smoke: the OPEN kind selector creates an open mission,
 * and the deliverable preview renders the markdown report with a clickable
 * citation link. Fetch is stubbed at the boundary; rendering is real.
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

const OPEN_MISSION = {
  missionId: 'm-open',
  state: 'AWAITING_MERGE_APPROVAL',
  title: 'Research mission',
  objective: 'research and cite',
  kind: 'open',
  repoPath: null,
  deliverTo: null,
  scheduledBy: null,
  riskLevel: 'open-readonly',
  createdAt: T0,
  updatedAt: T0,
  eventCount: 8,
};

const REPORT_PREVIEW = {
  archive: false,
  sha256: 'abc123',
  files: [
    {
      name: 'report.md',
      sha256: 'def456',
      content:
        '# Findings\n\nSQLite is a small SQL engine.\n\nSources:\n- [SQLite homepage](https://sqlite.org/index.html)\n',
      truncated: false,
    },
  ],
};

let created: unknown[] = [];

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/api/auth/approver/status')) return json({ registered: true });
      if (method === 'POST' && url.endsWith('/api/missions')) {
        created.push(JSON.parse(String(init?.body)));
        return json({ mission: OPEN_MISSION }, 201);
      }
      if (/\/api\/missions\/[^/]+\/workers$/.test(url)) return json({ workers: [] });
      if (/\/api\/missions\/[^/]+\/scan$/.test(url)) return json({ scan: null });
      if (/\/api\/missions\/[^/]+\/artifacts$/.test(url)) return json({ artifacts: [] });
      if (/\/api\/missions\/[^/]+\/approval$/.test(url)) {
        return json({ approvals: [], hashes: { diff: 'abc123', sarif: 'fff' } });
      }
      if (/\/api\/missions\/[^/]+\/deliverable$/.test(url)) {
        return json({ deliverable: REPORT_PREVIEW });
      }
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
  created = [];
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

async function tick() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 25));
  });
}

describe('T76: open missions on the board', () => {
  it('the OPEN selector creates an open mission (no repoPath in the payload)', async () => {
    await render();

    // open the form
    const toggle = container.querySelector<HTMLButtonElement>('.new-mission-toggle');
    await act(async () => toggle!.click());
    await tick();

    // pick OPEN
    const openBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.kind-toggle .btn'),
    ).find((b) => b.textContent?.trim() === 'Open');
    expect(openBtn).toBeTruthy();
    await act(async () => openBtn!.click());
    await tick();

    // no repo-path field is shown for open missions
    expect(container.textContent).not.toContain('repo path');

    // fill and submit
    const inputs = container.querySelectorAll<HTMLInputElement>('.new-mission input');
    const textarea = container.querySelector<HTMLTextAreaElement>('.new-mission textarea');
    await act(async () => {
      const set = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
        const proto = el instanceof HTMLInputElement
          ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(inputs[0]!, 'Research mission');
      set(textarea!, 'research and cite sources');
    });
    const submit = container.querySelector<HTMLButtonElement>('.new-mission button[type="submit"]');
    await act(async () => submit!.click());
    await tick();

    expect(created).toHaveLength(1);
    const payload = created[0] as Record<string, unknown>;
    expect(payload.kind).toBe('open');
    expect(payload.repoPath).toBeUndefined();
  });

  it('the report preview renders markdown with a clickable citation', async () => {
    await render();
    const card = container.querySelector<HTMLButtonElement>('.card');
    await act(async () => card!.click());
    await tick();

    // kind tag OPEN appears on the detail
    expect(container.querySelector('.kind-tag.kind-open')).toBeTruthy();

    // the markdown preview rendered with a clickable source link
    const link = container.querySelector<HTMLAnchorElement>(
      '.deliverable-preview a[href="https://sqlite.org/index.html"]',
    );
    expect(link).toBeTruthy();
    expect(link!.textContent).toContain('SQLite homepage');
    expect(link!.target).toBe('_blank');
  });
});
