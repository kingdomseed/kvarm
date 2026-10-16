/**
 * How the git gate authenticates to Artifacts, and what git sees when
 * Artifacts refuses the platform's token.
 *
 * Artifacts takes a repo token (`art_v1_<40 hex>?expires=<unix>`) either whole
 * as a Bearer credential or, without the `?expires=` suffix, as the Basic
 * password (https://developers.cloudflare.com/artifacts/api/git-protocol/#authentication).
 * The fake upstream enforces exactly that. A refusal reaches a caller Kvarm
 * has already authorized, so it must not read as a credential challenge:
 * git would prompt and then erase the user's working PAT.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mintPAT } from '../src/auth/pat';
import { send } from './helpers/http';
import { seedRepo, seedUser } from './helpers/seed';

const OWNER = 'upa-owner';
const originalFetch = globalThis.fetch;
let pat = '';
let mints = 0;
/** Status the fake upstream answers with regardless of credentials; null enforces the documented contract. */
let forced: 401 | 403 | null = null;
let seen: string[] = [];

const env = {
  ...(cfEnv as unknown as Env),
  ARTIFACTS: {
    get: async () => ({
      async createToken(_scope: 'read' | 'write', ttl: number) {
        mints++;
        const expires = Math.floor(Date.now() / 1000) + ttl;
        return { plaintext: `art_v1_${mints.toString(16).padStart(40, '0')}?expires=${expires}`, expiresAt: new Date(expires * 1000).toISOString() };
      },
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts,
} as Env;

function documentedCredential(authorization: string): boolean {
  if (/^Bearer art_v1_[0-9a-f]{40}\?expires=\d+$/.test(authorization)) return true;
  const basic = /^Basic (.+)$/.exec(authorization);
  return basic !== null && /^[^:]*:art_v1_[0-9a-f]{40}$/.test(atob(basic[1]!));
}

function infoRefs(repo: string, authorization?: string) {
  return send(
    env,
    new Request(`https://kvarm.test/${OWNER}/${repo}.git/info/refs?service=git-upload-pack`, {
      headers: authorization ? { Authorization: authorization } : {},
    }),
  );
}

const basicPat = () => `Basic ${btoa(`x:${pat}`)}`;

beforeAll(async () => {
  const userId = await seedUser(env, OWNER);
  pat = (await mintPAT(env, userId, 'upa', ['read'])).token;
  for (const name of ['pub-ok', 'pub-401', 'pub-403', 'priv-401', 'priv-403', 'pub-evict']) {
    await seedRepo(env, name, { owner: OWNER, visibility: name.startsWith('priv') ? 'private' : 'public', register: false });
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'artifacts.invalid') return originalFetch(input, init);
    const authorization = new Headers(init?.headers).get('authorization') ?? '';
    seen.push(authorization);
    const status = forced ?? (documentedCredential(authorization) ? 200 : 401);
    if (status !== 200) {
      return new Response('unauthorized\n', { status, headers: { 'WWW-Authenticate': 'Basic realm="artifacts"' } });
    }
    return new Response('0000', { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  forced = null;
  seen = [];
});

describe('git gate upstream authentication', () => {
  it('sends Artifacts the full repo token as a Bearer credential', async () => {
    const res = await infoRefs('pub-ok');
    expect(res.status, res.text).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^Bearer art_v1_[0-9a-f]{40}\?expires=\d+$/);
  });

  for (const status of [401, 403] as const) {
    it(`answers an anonymous public read refused upstream with ${status} as 502 without a challenge`, async () => {
      forced = status;
      const res = await infoRefs(`pub-${status}`);
      expect(res.status).toBe(502);
      expect(res.headers.get('WWW-Authenticate')).toBeNull();
    });

    it(`answers an authorized private read refused upstream with ${status} as 502 without a challenge`, async () => {
      forced = status;
      const res = await infoRefs(`priv-${status}`, basicPat());
      expect(res.status).toBe(502);
      expect(res.headers.get('WWW-Authenticate')).toBeNull();
    });
  }

  it('mints a new token for the request after an upstream 401', async () => {
    forced = 401;
    expect((await infoRefs('pub-evict')).status).toBe(502);
    forced = null;
    const res = await infoRefs('pub-evict');
    expect(res.status, res.text).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toBe(seen[0]);
  });
});
