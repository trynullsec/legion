/**
 * UI smoke (M5 fix): with zero approvers, the board root must surface a
 * persistent REGISTER APPROVER button in the header. The status endpoint is
 * stubbed at the fetch boundary; everything else renders for real.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('register button renders when no approver exists', () => {
  it('header shows REGISTER APPROVER when /status reports registered=false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/auth/approver/status')) {
          return jsonResponse({ registered: false });
        }
        if (url.includes('/api/missions')) {
          return jsonResponse({ missions: [] });
        }
        return jsonResponse({});
      }),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      createRoot(container).render(<App />);
    });
    // let the status fetch resolve and state land
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const header = container.querySelector('header');
    expect(header?.textContent ?? '').toContain('Register approver');

    document.body.removeChild(container);
  });

  it('header shows no register button when an approver exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/auth/approver/status')) {
          return jsonResponse({ registered: true });
        }
        if (url.includes('/api/missions')) {
          return jsonResponse({ missions: [] });
        }
        return jsonResponse({});
      }),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      createRoot(container).render(<App />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(
      container.querySelector('header')?.textContent ?? '',
    ).not.toContain('Register approver');

    document.body.removeChild(container);
  });
});
