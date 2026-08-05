import {argon2id, createHMAC, createSHA3} from 'hash-wasm';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {firstValueFrom, of} from 'rxjs';

const REFERENCE_COMMIT = '85eb264d7d7c5e177813f858db23cff117712fad';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = join(scriptDir, '..');
const referencePackage = join(scriptDir, 'auth-reference', 'package.json');
const referenceSource = join(packageDir, '../../.nocommit/rci-tools-core');
const outputDir = join(packageDir, 'backend', 'internal', 'auth', 'testdata');

interface ReferenceResponse {
  status: number;
  data: unknown;
  headers: Record<string, string>;
}

interface ReferenceTransport {
  get(url: string): ReturnType<typeof of<ReferenceResponse>>;
  post(url: string, data: unknown): ReturnType<typeof of<ReferenceResponse>>;
  delete(url: string): ReturnType<typeof of<ReferenceResponse>>;
  getHeader(response: ReferenceResponse, name: string): string;
  onAuthRequest(response: ReferenceResponse): void;
  clearAuthData(): void;
  sendQueryArray(url: string, query: unknown[]): ReturnType<typeof of<unknown[]>>;
}

interface ScramVector {
  generation: 'x-ndw4-interactive';
  credentials: {username: string; password: string};
  challenge: {clientNonce: string; combinedNonce: string; salt: string; iter: string; memcost: string};
  authMessage: string;
  saltedPassword: string;
  clientKey: string;
  storedKey: string;
  serverKey: string;
  proof: string;
  serverSignature: string;
  signatureProof: string;
}

interface LegacyVector {
  generation: 'x-ndw2-interactive';
  credentials: {username: string; password: string; realm: string; challenge: string};
  proof: string;
}

class Transcript implements ReferenceTransport {
  public readonly requests: Array<{method: string; url: string; data: unknown}> = [];
  private phase = 0;
  private readonly scram: {
    salt: string;
    iter: string;
    memcost: string;
    signature: string;
  } | null;

  public constructor(scram: Transcript['scram']) {
    this.scram = scram;
  }

  public get(url: string): ReturnType<typeof of<ReferenceResponse>> {
    this.requests.push({method: 'GET', url, data: undefined});

    return of({status: 200, data: {}, headers: {}});
  }

  public post(url: string, data: unknown): ReturnType<typeof of<ReferenceResponse>> {
    this.requests.push({method: 'POST', url, data});

    if (!this.scram) {
      return of({status: 200, data: {}, headers: {}});
    }

    if (this.phase === 0) {
      this.phase += 1;

      const request = data as {nonce: string};

      return of({
        status: 401,
        data: {},
        headers: {
          'X-NDM-Data': encodeJSON({salt: this.scram.salt, nonce: `${request.nonce}server`, iter: this.scram.iter,
            memcost: this.scram.memcost}),
        },
      });
    }

    if (this.phase === 1) {
      this.phase += 1;

      return of({status: 401, data: {}, headers: {'X-NDM-Data': encodeJSON({signature: this.scram.signature})}});
    }

    this.phase += 1;

    return of({status: 200, data: {}, headers: {}});
  }

  public delete(url: string): ReturnType<typeof of<ReferenceResponse>> {
    this.requests.push({method: 'DELETE', url, data: undefined});

    return of({status: 200, data: {}, headers: {}});
  }

  public getHeader(reply: ReferenceResponse, name: string): string {
    const entry = Object.entries(reply.headers).find(([key]) => key.toLowerCase() === name.toLowerCase());

    return entry?.[1] ?? '';
  }

  public onAuthRequest(_response: ReferenceResponse): void {}
  public clearAuthData(): void {}
  public sendQueryArray(_url: string, _query: unknown[]): ReturnType<typeof of<unknown[]>> {
    return of([]);
  }
}

async function verifyReference(): Promise<void> {
  const packageJSON = JSON.parse(await (await import('node:fs/promises')).readFile(referencePackage, 'utf8')) as {
    dependencies?: {'@rci-tools/core'?: string};
  };
  const expected = `github:Eralde/rci-tools#${REFERENCE_COMMIT}&path:/packages/core`;

  if (packageJSON.dependencies?.['@rci-tools/core'] !== expected) {
    throw new Error(`reference dependency is not pinned to ${REFERENCE_COMMIT}`);
  }

  const sourceJSON = JSON.parse(
    await (await import('node:fs/promises')).readFile(join(referenceSource, 'package.json'), 'utf8'),
  ) as {version?: string};

  if (sourceJSON.version !== '0.4.1') {
    throw new Error('pinned rci-tools source package is missing');
  }

  const {stat} = await import('node:fs/promises');

  await stat(
    join(referenceSource, 'src', 'session-manager', 'auth-protocol', 'x-ndw4-interactive', 'ndw4-auth.protocol.ts'),
  );

  const {spawnSync} = await import('node:child_process');
  const build = spawnSync('pnpm', ['--dir', join(packageDir, 'scripts', 'auth-reference'), 'run', 'build'], {
    stdio: 'inherit',
  });

  if (build.status !== 0) {
    throw new Error('failed to compile pinned @rci-tools/core auth source');
  }
}

async function generateLegacy(): Promise<LegacyVector> {
  const username = 'mndw-vector-user';
  const password = 'mndw-vector-password';
  const realm = 'mndw-vector-realm';
  const challenge = 'mndw-vector-challenge';
  const {Ndw2AuthProtocol} = await loadReference();
  const transport = new Transcript(null);
  const protocol = new Ndw2AuthProtocol('http://reference', transport as never);
  const initial = response(401, {'WWW-Authenticate': 'x-ndw2-interactive', 'X-NDM-Challenge': challenge,
    'X-NDM-Realm': realm});
  const authenticated = await firstValueFrom(
    protocol.authenticate(initial as never, context(transport), username, password),
  );

  if (!authenticated) {
    throw new Error('pinned x-ndw2 reference rejected its generated transcript');
  }

  const proof = requestField(transport, 'password');

  return {generation: 'x-ndw2-interactive', credentials: {username, password, realm, challenge}, proof};
}

async function generateScram(): Promise<ScramVector> {
  const username = 'mndw-scram-user';
  const password = 'mndw-scram-password';
  const saltBytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const salt = encodeBase64(saltBytes);
  const iter = '2';
  const memcost = '8';
  const originalCrypto = globalThis.crypto;
  const deterministicCrypto = {...originalCrypto, getRandomValues: (buffer: Uint8Array) => {
    buffer.set(saltBytes);

    return buffer;
  }};

  Object.defineProperty(globalThis, 'crypto', {configurable: true, value: deterministicCrypto});

  try {
    const {Ndw4AuthProtocol} = await loadReference();
    const initial = response(401, {'WWW-Authenticate': 'x-ndw4-interactive endpoint="/auth"'});
    const clientNonce = encodeBase64(saltBytes);
    const combinedNonce = `${clientNonce}server`;
    const authMessage =
      `login1=${username},nonce1=${clientNonce};iter2=${iter},memcost2=${memcost},nonce2=${combinedNonce},salt2=${salt};login3=${username},nonce3=${combinedNonce}`;
    const saltedPassword = await argon2id({password, salt: saltBytes, iterations: Number(iter), parallelism: 1,
      memorySize: Number(memcost), hashLength: 64, outputType: 'binary'});
    const clientKey = await hmacSHA3(saltedPassword, 'NDW4 Interactive Client Key');
    const storedKey = await sha3Digest(clientKey);
    const serverKey = await hmacSHA3(saltedPassword, 'NDW4 Interactive Server Key');
    const serverSignature = await hmacSHA3(serverKey, authMessage);
    const transcript = new Transcript({salt, iter, memcost, signature: encodeBase64(serverSignature)});
    const protocol = new Ndw4AuthProtocol('http://reference', transcript as never);
    const authenticated = await firstValueFrom(
      protocol.authenticate(initial as never, context(transcript), username, password),
    );

    if (!authenticated) {
      throw new Error('pinned x-ndw4 reference rejected its generated transcript');
    }

    const proof = requestField(transcript, 'proof');
    const signatureProof = requestField(transcript, 'signature-proof');

    return {
      generation: 'x-ndw4-interactive',
      credentials: {username, password},
      challenge: {clientNonce, combinedNonce, salt, iter, memcost},
      authMessage,
      saltedPassword: encodeBase64(saltedPassword),
      clientKey: encodeBase64(clientKey),
      storedKey: encodeBase64(storedKey),
      serverKey: encodeBase64(serverKey),
      proof,
      serverSignature: encodeBase64(serverSignature),
      signatureProof,
    };
  } finally {
    Object.defineProperty(globalThis, 'crypto', {configurable: true, value: originalCrypto});
  }
}

function context(
  transport: Transcript,
): {
  isAuthenticated: () => ReturnType<typeof of<ReferenceResponse>>;
  errorToResponse: (error: unknown) => unknown;
  logError: () => void;
} {
  return {isAuthenticated: () => transport.get('/auth'), errorToResponse: (error) => error, logError: () => {}};
}

function response(status: number, headers: Record<string, string>): ReferenceResponse {
  return {status, data: {}, headers};
}

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

function encodeJSON(value: unknown): string {
  return encodeBase64(new TextEncoder().encode(JSON.stringify(value)));
}

function requestField(transport: Transcript, field: string): string {
  for (const request of transport.requests) {
    if (request.method !== 'POST' || !request.data || typeof request.data !== 'object') {
      continue;
    }

    const value = (request.data as Record<string, unknown>)[field];

    if (typeof value === 'string') {
      return value;
    }
  }

  throw new Error(`reference transcript missing ${field}`);
}

async function hmacSHA3(key: Uint8Array | string, message: Uint8Array | string): Promise<Uint8Array> {
  const hasher = await createHMAC(createSHA3(512), key);

  return hasher.init().update(message)
    .digest('binary');
}
async function loadReference(): Promise<
  {Ndw2AuthProtocol: new(...args: never[]) => any; Ndw4AuthProtocol: new(...args: never[]) => any}
> {
  return await import('./auth-reference/generated/auth-protocol.mjs') as never;
}
async function sha3Digest(data: Uint8Array): Promise<Uint8Array> {
  const hasher = await createSHA3(512);

  return hasher.init().update(data)
    .digest('binary');
}

async function main(): Promise<void> {
  await verifyReference();
  await mkdir(outputDir, {recursive: true});

  const legacy = await generateLegacy();
  const scram = await generateScram();

  await writeFile(join(outputDir, 'legacy.json'), `${JSON.stringify(legacy, null, 2)}\n`);
  await writeFile(join(outputDir, 'scram.json'), `${JSON.stringify(scram, null, 2)}\n`);
}

if (process.argv.includes('--check-reference')) {
  verifyReference()
    .then(() => {
      console.log(`@rci-tools/core source compiled from ${REFERENCE_COMMIT}`);
    });
} else {
  void main();
}
