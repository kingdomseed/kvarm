/**
 * Request encodings at the git proxy: body encodings, the Basic scheme
 * spelling and percent-encoded path components.
 *
 * git gzips upload-pack request bodies larger than 1024 bytes (a fetch or
 * clone naming many refs) and labels them `Content-Encoding: gzip`. Artifacts
 * only reads plain pkt-lines, so the proxy hands upstream the decoded body;
 * forwarding the compressed bytes unlabeled made every such clone fail with
 * HTTP 500.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { internalKey, writeCachedJson } from '../src/cache/internal';
import worker from '../src/index';
import { seedRepo as seedRepoBase, seedUser as seedUserBase } from './helpers/seed';

const env = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const OWNER = 'enc-owner';
const REPO = 'many-refs';
const ARTIFACTS_NAME = `${OWNER}--${REPO}`;
const PUBLIC_REPO = 'pub';
const PUBLIC_REMOTE = `https://artifacts.invalid/git/default/${OWNER}--${PUBLIC_REPO}.git`;
const REMOTE = `https://artifacts.invalid/git/default/${ARTIFACTS_NAME}.git`;
const FULL: Scope[] = ['read', 'write', 'api'];
const enc = new TextEncoder();
const dec = new TextDecoder();
const originalFetch = globalThis.fetch;
let token = '';

interface Upstream {
  path: string;
  headers: Headers;
  body: string;
}
let upstream: Upstream[] = [];

function pkt(line: string): string {
  return (line.length + 4).toString(16).padStart(4, '0') + line;
}

/** A protocol-v2 fetch request naming `wants` objects: > 1024 bytes for 25. */
function fetchRequest(wants: number): string {
  const lines = ['command=fetch\n', 'agent=git/2.54.0\n', 'object-format=sha1\n'].map(pkt).join('');
  let args = ['thin-pack\n', 'no-progress\n', 'ofs-delta\n'].map(pkt).join('');
  for (let i = 0; i < wants; i++) args += pkt(`want ${i.toString(16).padStart(40, '0')}\n`);
  return `${lines}0001${args}${pkt('done\n')}0000`;
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Response(enc.encode(text)).body!.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function uploadPack(body: BodyInit, encoding?: string): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {
    Authorization: `Basic ${btoa(`x:${token}`)}`,
    'content-type': 'application/x-git-upload-pack-request',
    accept: 'application/x-git-upload-pack-result',
    'git-protocol': 'version=2',
  };
  if (encoding) headers['content-encoding'] = encoding;
  const ctx = createExecutionContext();
  const req = new Request(`${ORIGIN}/${OWNER}/${REPO}.git/git-upload-pack`, { method: 'POST', headers, body });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const text = dec.decode(await res.arrayBuffer());
  await waitOnExecutionContext(ctx);
  return { status: res.status, text };
}

beforeAll(async () => {
  const userId = await seedUserBase(env, OWNER);
  token = (await mintPAT(env, userId, 'enc', FULL)).token;
  await seedRepoBase(env, REPO, { owner: OWNER, visibility: 'private', artifactsName: ARTIFACTS_NAME, artifactsRemote: REMOTE, register: false });
  await seedRepoBase(env, PUBLIC_REPO, { owner: OWNER, visibility: 'public', artifactsRemote: PUBLIC_REMOTE, register: false });
  await writeCachedJson(internalKey('gittoken', ARTIFACTS_NAME, 'read'), { token: 'fake', expiresAt: Date.now() + 86_400_000 }, 86_400);
  await writeCachedJson(internalKey('gittoken', `${OWNER}--${PUBLIC_REPO}`, 'read'), { token: 'fake', expiresAt: Date.now() + 86_400_000 }, 86_400);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'artifacts.invalid') return originalFetch(input, init);
    const body = init?.body ? dec.decode(await new Response(init.body).arrayBuffer()) : '';
    upstream.push({ path: url.pathname, headers: new Headers(init?.headers), body });
    if (url.pathname.endsWith('/info/refs')) {
      return new Response(`${pkt('# service=git-upload-pack\n')}0000`, {
        headers: { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' },
      });
    }
    // Like Artifacts: anything but plain pkt-lines is an internal error.
    if (!/^[0-9a-f]{4}command=/.test(body)) return new Response('Internal Server Error', { status: 500 });
    return new Response(`${pkt('packfile\n')}0000`, {
      headers: { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' },
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  upstream = [];
});

describe('git upload-pack request encodings', () => {
  it('decodes a gzip request body before it reaches upstream', async () => {
    const plain = fetchRequest(25);
    expect(plain.length).toBeGreaterThan(1024);
    const res = await uploadPack(await gzip(plain), 'gzip');
    expect(res.status, res.text).toBe(200);
    expect(res.text).toContain('packfile');
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.body).toBe(plain);
    expect(upstream[0]!.headers.get('content-encoding')).toBeNull();
  });

  it('relays a plain request body unchanged', async () => {
    const plain = fetchRequest(2);
    const res = await uploadPack(plain);
    expect(res.status, res.text).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.body).toBe(plain);
  });

  it('refuses an encoding it cannot decode without calling upstream', async () => {
    const res = await uploadPack(fetchRequest(2), 'br');
    expect(res.status).toBe(415);
    expect(upstream).toHaveLength(0);
  });
});

describe('git gate request parsing', () => {
  const ADVERTISE = '?service=git-upload-pack';

  async function advertise(path: string, authorization?: string): Promise<{ status: number; text: string }> {
    const headers: Record<string, string> = authorization ? { Authorization: authorization } : {};
    const ctx = createExecutionContext();
    const req = new Request(`${ORIGIN}${path}${ADVERTISE}`, { headers });
    const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
    const text = dec.decode(await res.arrayBuffer());
    await waitOnExecutionContext(ctx);
    return { status: res.status, text };
  }

  it('accepts the Basic scheme in any letter case', async () => {
    for (const scheme of ['Basic', 'basic', 'BASIC']) {
      const res = await advertise(`/${OWNER}/${REPO}.git/info/refs`, `${scheme} ${btoa(`x:${token}`)}`);
      expect(res.status, scheme).toBe(200);
    }
    expect((await advertise(`/${OWNER}/${REPO}.git/info/refs`)).status).toBe(401);
  });

  it('serves a percent-encoded repo name like the plain one', async () => {
    const plain = await advertise(`/${OWNER}/${PUBLIC_REPO}.git/info/refs`);
    expect(plain.status).toBe(200);
    const encoded = await advertise(`/${OWNER}/p%75b.git/info/refs`);
    expect(encoded).toEqual(plain);
    const encodedOwner = await advertise(`/enc%2Downer/${PUBLIC_REPO}.git/info/refs`);
    expect(encodedOwner).toEqual(plain);
  });

  it('answers a malformed or slash-bearing encoding as an unknown repo without touching upstream', async () => {
    const auth = `Basic ${btoa(`x:${token}`)}`;
    const missing = await advertise(`/${OWNER}/no-such-repo.git/info/refs`, auth);
    expect(missing.status).toBe(404);
    upstream = [];
    for (const name of ['p%E0%A4%A', `${OWNER}%2F${PUBLIC_REPO}`, 'pub%2F..%2Fmany-refs']) {
      expect(await advertise(`/${OWNER}/${name}.git/info/refs`, auth), name).toEqual(missing);
      expect((await advertise(`/${OWNER}/${name}.git/info/refs`)).status, name).toBe(401);
    }
    expect(upstream).toHaveLength(0);
  });
});
