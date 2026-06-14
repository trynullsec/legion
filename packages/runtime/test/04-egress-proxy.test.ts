/**
 * M7 egress proxy + SSRF unit tests — runnable anywhere (no seatbelt needed;
 * this is the proxy logic the OS layer routes through). Covers the SSRF
 * classifier, the per-role policy, and real proxied requests through a live
 * EgressProxy against a local origin server.
 */
import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildEgressPolicy,
  EgressProxy,
  isBlockedIp,
  type EgressLogEntry,
} from '../src/egressProxy.js';

describe('isBlockedIp — SSRF ranges', () => {
  it('blocks loopback, private, link-local/metadata, CGNAT, ULA', () => {
    for (const ip of [
      '127.0.0.1', '127.1.2.3',
      '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '0.0.0.0', '100.64.0.1',
      '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1',
      '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1::1']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });
});

describe('buildEgressPolicy — per-role allowlist', () => {
  const model = 'openrouter.ai';

  it('net:none allows ONLY the model host', async () => {
    const p = buildEgressPolicy('none', model);
    expect((await p('openrouter.ai', 443)).allowed).toBe(true);
    expect((await p('api.openrouter.ai', 443)).allowed).toBe(true); // subdomain
    expect((await p('example.com', 443)).allowed).toBe(false);
    expect((await p('127.0.0.1', 80)).allowed).toBe(false);
  });

  it('allowlist allows the model + public web, blocks SSRF targets', async () => {
    const p = buildEgressPolicy('allowlist', model);
    expect((await p('openrouter.ai', 443)).allowed).toBe(true);
    // numeric public IPs resolve without a DNS query (offline-deterministic)
    expect((await p('8.8.8.8', 443)).allowed).toBe(true);
    expect((await p('1.1.1.1', 443)).allowed).toBe(true);
    // literal private/metadata hosts fail closed
    expect((await p('127.0.0.1', 80)).allowed).toBe(false);
    expect((await p('169.254.169.254', 80)).allowed).toBe(false);
    expect((await p('10.0.0.1', 80)).allowed).toBe(false);
    const blocked = await p('192.168.1.1', 80);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/SSRF/);
  });
});

// ---- live proxy against a local origin (HTTP absolute-form path) ----

let origin: http.Server;
let originPort = 0;
const log: EgressLogEntry[] = [];

beforeAll(async () => {
  origin = http.createServer((_req, res) => res.end('origin-ok'));
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', () => r()));
  originPort = (origin.address() as net.AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => origin.close(() => r()));
});

/** A policy that allows our local origin by host:port but nothing else. */
function localOriginPolicy() {
  return async (host: string, port: number) =>
    host === '127.0.0.1' && port === originPort
      ? { allowed: true, reason: 'test-origin' }
      : { allowed: false, reason: 'blocked' };
}

describe('EgressProxy — real proxying + logging', () => {
  it('forwards an allowed HTTP request and logs NET_REQUEST', async () => {
    const proxy = new EgressProxy(localOriginPolicy(), (e) => log.push(e));
    const port = await proxy.start();
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'GET',
            path: `http://127.0.0.1:${originPort}/x`, // absolute-form → proxy
            headers: { host: `127.0.0.1:${originPort}` },
          },
          (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => resolve(d));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(body).toBe('origin-ok');
      const entry = log.find((e) => e.port === originPort);
      expect(entry).toBeTruthy();
      expect(entry!.allowed).toBe(true);
      expect(entry!.method).toBe('GET');
    } finally {
      await proxy.stop();
    }
  });

  it('a disallowed host fails closed with 403 and is logged as blocked', async () => {
    const blockedLog: EgressLogEntry[] = [];
    const proxy = new EgressProxy(localOriginPolicy(), (e) => blockedLog.push(e));
    const port = await proxy.start();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'GET',
            path: 'http://example.com/secret',
            headers: { host: 'example.com' },
          },
          (res) => resolve(res.statusCode ?? 0),
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(403);
      const entry = blockedLog.find((e) => e.host === 'example.com');
      expect(entry?.allowed).toBe(false);
    } finally {
      await proxy.stop();
    }
  });
});
