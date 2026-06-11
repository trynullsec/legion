/**
 * Software FIDO2 authenticator for tests — a REAL ES256 keypair with REAL
 * CBOR attestation/assertion construction. The entire @simplewebauthn server
 * verification path runs unmodified against it; only the key *store* is
 * software instead of a hardware secure element. There are no verification
 * bypass flags anywhere — this produces genuine signatures the server checks.
 */
import {
  createSign,
  createHash,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

// ---------- minimal CBOR encoder (only the types WebAuthn needs) ----------

function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

function cborInt(n: number): Buffer {
  return n >= 0 ? cborHead(0, n) : cborHead(1, -1 - n);
}
function cborBytes(buf: Buffer): Buffer {
  return Buffer.concat([cborHead(2, buf.length), buf]);
}
function cborText(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([cborHead(3, b.length), b]);
}
/** entries: [keyBuffer, valueBuffer][] already-encoded */
function cborMap(entries: Array<[Buffer, Buffer]>): Buffer {
  return Buffer.concat([
    cborHead(5, entries.length),
    ...entries.flatMap(([k, v]) => [k, v]),
  ]);
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function jwkCoord(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

const RP_DEFAULT = 'localhost';

export interface SoftKeyResponse {
  id: string;
  rawId: string;
  type: 'public-key';
  response: Record<string, unknown>;
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment: 'platform';
}

export class SoftKey {
  readonly credentialId: Buffer;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private counter = 0;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.credentialId = randomBytes(32);
  }

  /** COSE_Key (EC2/ES256/P-256) for the attested credential data. */
  private coseKey(): Buffer {
    const jwk = this.publicKey.export({ format: 'jwk' }) as {
      x: string;
      y: string;
    };
    return cborMap([
      [cborInt(1), cborInt(2)], // kty: EC2
      [cborInt(3), cborInt(-7)], // alg: ES256
      [cborInt(-1), cborInt(1)], // crv: P-256
      [cborInt(-2), cborBytes(jwkCoord(jwk.x))],
      [cborInt(-3), cborBytes(jwkCoord(jwk.y))],
    ]);
  }

  private rpIdHash(rpId: string): Buffer {
    return createHash('sha256').update(rpId).digest();
  }

  private clientDataJSON(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string): Buffer {
    // challenge is the base64url string straight from the options
    return Buffer.from(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
      'utf8',
    );
  }

  /** Registration ceremony (attestation, fmt "none"). */
  createRegistration(opts: {
    challenge: string;
    rpId?: string;
    origin: string;
  }): SoftKeyResponse {
    const rpId = opts.rpId ?? RP_DEFAULT;
    const aaguid = Buffer.alloc(16, 0);
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(this.credentialId.length, 0);
    const attestedCredentialData = Buffer.concat([
      aaguid,
      credIdLen,
      this.credentialId,
      this.coseKey(),
    ]);

    const flags = Buffer.from([0x45]); // UP | UV | AT
    const signCount = Buffer.alloc(4); // 0
    const authData = Buffer.concat([
      this.rpIdHash(rpId),
      flags,
      signCount,
      attestedCredentialData,
    ]);

    const attestationObject = cborMap([
      [cborText('fmt'), cborText('none')],
      [cborText('attStmt'), cborMap([])],
      [cborText('authData'), cborBytes(authData)],
    ]);

    const clientDataJSON = this.clientDataJSON('webauthn.create', opts.challenge, opts.origin);

    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** Authentication ceremony (assertion) — produces a real ES256 signature. */
  createAssertion(opts: {
    challenge: string;
    rpId?: string;
    origin: string;
  }): SoftKeyResponse {
    const rpId = opts.rpId ?? RP_DEFAULT;
    this.counter += 1;
    const flags = Buffer.from([0x05]); // UP | UV
    const signCount = Buffer.alloc(4);
    signCount.writeUInt32BE(this.counter, 0);
    const authenticatorData = Buffer.concat([
      this.rpIdHash(rpId),
      flags,
      signCount,
    ]);

    const clientDataJSON = this.clientDataJSON('webauthn.get', opts.challenge, opts.origin);
    const clientDataHash = createHash('sha256').update(clientDataJSON).digest();
    const signedData = Buffer.concat([authenticatorData, clientDataHash]);
    const signature = createSign('SHA256').update(signedData).sign(this.privateKey); // DER

    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
        userHandle: b64url(Buffer.from('legion-approver')),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
