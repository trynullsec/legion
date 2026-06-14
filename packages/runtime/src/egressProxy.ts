/**
 * M7 — the per-worker egress chokepoint. seatbelt allows a worker outbound
 * only to this proxy on localhost; every request the worker makes (the LLM
 * control-plane call, and — for open workers — search/fetch) is routed here,
 * policy-checked, SSRF-filtered, and LOGGED as a NET_REQUEST worker_event.
 *
 * A request to a disallowed host fails closed and is recorded as blocked.
 */
import net from 'node:net';
import http from 'node:http';
import { lookup } from 'node:dns/promises';
import { NetworkPolicy } from '@legion/core';

export interface EgressLogEntry {
  host: string;
  port: number;
  method: string;
  allowed: boolean;
  reason: string;
}

export type EgressPolicy = (
  host: string,
  port: number,
) => Promise<{ allowed: boolean; reason: string }>;

/** True for loopback / private / link-local / CGNAT / ULA — SSRF targets. */
export function isBlockedIp(ip: string): boolean {
  const v = ip.startsWith('::ffff:') ? ip.slice(7) : ip; // unwrap mapped v4
  if (net.isIPv4(v)) {
    const o = v.split('.').map(Number);
    if (o[0] === 127) return true; // loopback
    if (o[0] === 10) return true; // private A
    if (o[0] === 172 && o[1]! >= 16 && o[1]! <= 31) return true; // private B
    if (o[0] === 192 && o[1] === 168) return true; // private C
    if (o[0] === 169 && o[1] === 254) return true; // link-local + 169.254.169.254 metadata
    if (o[0] === 0) return true; // "this host"
    if (o[0] === 100 && o[1]! >= 64 && o[1]! <= 127) return true; // CGNAT
    return false;
  }
  const lower = v.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
  return false;
}

/**
 * Build the per-role egress policy. The model host is always reachable (the
 * agent cannot reason otherwise). 'none' allows ONLY that host; 'allowlist'
 * additionally allows public web hosts (SSRF-filtered); 'open' is reserved.
 */
export function buildEgressPolicy(
  network: NetworkPolicy,
  modelHost: string,
): EgressPolicy {
  const modelAllowed = (host: string) =>
    host === modelHost || host.endsWith(`.${modelHost}`);

  return async (host: string) => {
    if (modelAllowed(host)) return { allowed: true, reason: 'model-endpoint' };
    if (network === 'none') {
      return { allowed: false, reason: 'net:none — only the model endpoint is reachable' };
    }
    // allowlist / open: resolve + SSRF-filter; literal private hosts blocked too
    let addrs: { address: string }[];
    try {
      addrs = await lookup(host, { all: true });
    } catch (e) {
      return { allowed: false, reason: `dns resolution failed: ${String(e)}` };
    }
    if (addrs.length === 0) return { allowed: false, reason: 'no addresses resolved' };
    for (const a of addrs) {
      if (isBlockedIp(a.address)) {
        return { allowed: false, reason: `SSRF blocked: ${host} → ${a.address}` };
      }
    }
    return { allowed: true, reason: 'public host' };
  };
}

export class EgressProxy {
  private server: http.Server | null = null;
  private _port = 0;

  constructor(
    private readonly policy: EgressPolicy,
    private readonly onRequest: (entry: EgressLogEntry) => void,
  ) {}

  get port(): number {
    return this._port;
  }

  async start(): Promise<number> {
    const server = http.createServer((req, res) => {
      // absolute-form HTTP proxying (http:// targets)
      void this.handleHttp(req, res);
    });
    server.on('connect', (req, clientSocket, head) => {
      void this.handleConnect(req, clientSocket as net.Socket, head);
    });
    await new Promise<void>((resolve) => {
      // bind to loopback only — nothing off-box can reach the proxy
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this._port = (server.address() as net.AddressInfo).port;
    return this._port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): Promise<void> {
    const [host, portStr] = (req.url ?? '').split(':');
    const port = Number(portStr) || 443;
    const decision = await this.policy(host ?? '', port);
    this.onRequest({ host: host ?? '', port, method: 'CONNECT', allowed: decision.allowed, reason: decision.reason });
    if (!decision.allowed) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.end();
      return;
    }
    const upstream = net.connect(port, host ?? '', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => {
      try {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      } catch {
        /* client gone */
      }
      clientSocket.end();
    });
    clientSocket.on('error', () => upstream.destroy());
  }

  private async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('proxy: absolute-form URL required');
      return;
    }
    const port = Number(target.port) || 80;
    const decision = await this.policy(target.hostname, port);
    this.onRequest({
      host: target.hostname,
      port,
      method: req.method ?? 'GET',
      allowed: decision.allowed,
      reason: decision.reason,
    });
    if (!decision.allowed) {
      res.writeHead(403).end(`proxy: ${decision.reason}`);
      return;
    }
    const upstream = http.request(
      {
        host: target.hostname,
        port,
        method: req.method,
        path: target.pathname + target.search,
        headers: req.headers,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end('proxy: upstream error');
    });
    req.pipe(upstream);
  }
}
