/**
 * Server-side git writes (architecture invariant 1): GitPusher speaks
 * receive-pack to the repo's Artifacts remote with a repo-scoped write token.
 * Only a confirmed `ok <ref>` counts and moves the repo's view generation;
 * `ng` on HTTP 200 (a stale old OID) and unknown outcomes change nothing.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  buildBlob,
  buildCommit,
  buildReportStatus,
  buildTree,
  encode,
  pktLine,
  concat,
  readPktLines,
  ZERO_OID,
  type FetchLike,
} from '@kvarm/gitops';
import { refGeneration } from '../src/cache/compare';
import { internalKey, writeCachedJson } from '../src/cache/internal';
import type { RepoRow } from '../src/db/repos';
import { RefStoreUnavailable } from '../src/services/refs';
import { artifactsPusher } from '../src/services/gitwrite';
import { seedRepo as seedRepoBase } from './helpers/seed';

const seedRepo = async (name: string, tokens = true): Promise<RepoRow> => {
  const { id } = await seedRepoBase(baseEnv, name, { owner: 'gw-owner', visibility: 'private', pushedAt: 1000, register: false });
  if (tokens) {
    for (const scope of ['read', 'write'] as const) {
      await writeCachedJson(internalKey('gittoken', `gw-owner--${name}`, scope), { token: `${scope}-tok`, expiresAt: Date.now() + 86_400_000 }, 86_400);
    }
  }
  return (await baseEnv.DB.prepare('SELECT * FROM repos WHERE id = ?').bind(id).first<RepoRow>())!;
};

const baseEnv = cfEnv as unknown as Env;
const dec = new TextDecoder();

interface Seen {
  url: string;
  method: string;
  authorization: string | null;
  body: Uint8Array;
}

async function pushedAt(id: string): Promise<number | null> {
  return (await baseEnv.DB.prepare('SELECT pushed_at FROM repos WHERE id = ?').bind(id).first<{ pushed_at: number | null }>())!.pushed_at;
}

function fakeRemote(reply: () => Response): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    const h = new Headers(init.headers);
    const body = init.body == null ? new Uint8Array(0) : new Uint8Array(await new Response(init.body).arrayBuffer());
    seen.push({ url, method: init.method ?? 'GET', authorization: h.get('authorization'), body });
    return reply();
  };
  return { fetch, seen };
}

async function sampleCommit() {
  const blob = await buildBlob(encode('hello\n'));
  const tree = await buildTree([{ mode: '100644', name: 'a.txt', hash: blob.hash }]);
  const ident = { name: 'Kvarm', email: 'kvarm@kvarm.invalid', time: 1_790_000_000 };
  const commit = await buildCommit({ tree: tree.hash, parents: [], author: ident, committer: ident, message: 'm' });
  return { commit, objects: [commit, tree, blob] };
}

const WRITE_AUTH = 'Bearer write-tok';

describe('artifactsPusher', () => {
  it('pushes one ref with the write token and a pack of the given objects; ok moves the view generation', async () => {
    const repo = await seedRepo('gw-ok');
    const { commit, objects } = await sampleCommit();
    const remote = fakeRemote(() => new Response(buildReportStatus([{ ref: 'refs/heads/main', ok: true }], 'side-band-64k')));
    const genBefore = await refGeneration(repo.id);

    const r = await artifactsPusher(baseEnv, repo, { fetch: remote.fetch }).updateRef(
      { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: commit.hash },
      objects,
    );

    expect(r).toEqual({ status: 'ok', httpStatus: 200 });
    expect(remote.seen).toHaveLength(1);
    const req = remote.seen[0]!;
    expect(req.url).toBe(`${repo.artifacts_remote}/git-receive-pack`);
    expect(req.method).toBe('POST');
    expect(req.authorization).toBe(WRITE_AUTH);
    // One command pkt-line, then the flush, then the pack.
    const flushAt = parseInt(dec.decode(req.body.subarray(0, 4)), 16);
    const [line, flush] = readPktLines(req.body.subarray(0, flushAt + 4));
    expect(dec.decode(line!.data).startsWith(`${ZERO_OID} ${commit.hash} refs/heads/main\0`)).toBe(true);
    expect(flush!.flush).toBe(true);
    const packAt = flushAt + 4;
    expect(dec.decode(req.body.subarray(packAt, packAt + 4))).toBe('PACK');
    expect(new DataView(req.body.buffer, req.body.byteOffset + packAt + 8, 4).getUint32(0)).toBe(3);

    expect(await pushedAt(repo.id)).toBeGreaterThan(1000);
    expect(await refGeneration(repo.id)).not.toBe(genBefore);
  });

  it('allows the platform direct writer to stage a reserved CI ref', async () => {
    const repo = await seedRepo('gw-ci-stage');
    const { commit, objects } = await sampleCommit();
    const ref = 'refs/heads/kvarm-ci/run-1';
    const remote = fakeRemote(() => new Response(buildReportStatus([{ ref, ok: true }], 'none')));

    const result = await artifactsPusher(baseEnv, repo, { fetch: remote.fetch }).updateRef(
      { ref, oldOid: ZERO_OID, newOid: commit.hash },
      objects,
    );

    expect(result).toEqual({ status: 'ok', httpStatus: 200 });
    expect(dec.decode(remote.seen[0]!.body)).toContain(`${ZERO_OID} ${commit.hash} ${ref}\0`);
  });

  it('one-ref CAS: ng stale ref on HTTP 200 is a stale outcome and records nothing', async () => {
    const repo = await seedRepo('gw-stale');
    const body = concat(pktLine('unpack ok\n'), pktLine('ng refs/heads/main stale ref\n'), encode('0000'));
    const remote = fakeRemote(() => new Response(body, { status: 200 }));
    const genBefore = await refGeneration(repo.id);

    const r = await artifactsPusher(baseEnv, repo, { fetch: remote.fetch }).updateRef({
      ref: 'refs/heads/main',
      oldOid: 'a'.repeat(40),
      newOid: 'b'.repeat(40),
    });

    expect(r).toEqual({ status: 'stale', reason: 'stale ref', httpStatus: 200 });
    expect(await pushedAt(repo.id)).toBe(1000);
    expect(await refGeneration(repo.id)).toBe(genBefore);
  });

  it('an unknown outcome (server error) is reported as unknown and records nothing', async () => {
    const repo = await seedRepo('gw-unknown');
    const remote = fakeRemote(() => new Response('upstream error', { status: 502 }));
    const r = await artifactsPusher(baseEnv, repo, { fetch: remote.fetch }).updateRef({
      ref: 'refs/heads/x',
      oldOid: 'a'.repeat(40),
      newOid: ZERO_OID,
    });
    expect(r).toMatchObject({ status: 'unknown', httpStatus: 502 });
    expect(await pushedAt(repo.id)).toBe(1000);
  });

  it('lists refs from the receive-pack advertisement', async () => {
    const repo = await seedRepo('gw-list');
    const oid = 'c'.repeat(40);
    const adv = concat(
      pktLine('# service=git-receive-pack\n'),
      encode('0000'),
      pktLine(`${oid} refs/heads/main\0report-status delete-refs ofs-delta\n`),
      pktLine(`${oid} refs/heads/agents/w1/x\n`),
      encode('0000'),
    );
    const remote = fakeRemote(
      () => new Response(adv, { headers: { 'content-type': 'application/x-git-receive-pack-advertisement' } }),
    );
    const refs = await artifactsPusher(baseEnv, repo, { fetch: remote.fetch }).listRefs();
    expect(Object.fromEntries(refs)).toEqual({ 'refs/heads/main': oid, 'refs/heads/agents/w1/x': oid });
    expect(remote.seen[0]!.url).toBe(`${repo.artifacts_remote}/info/refs?service=git-receive-pack`);
    expect(remote.seen[0]!.authorization).toBe(WRITE_AUTH);
  });

  it('a write-token mint failure surfaces as RefStoreUnavailable before any request', async () => {
    const repo = await seedRepo('gw-mint', false);
    const env = {
      ...baseEnv,
      ARTIFACTS: {
        get: async () => {
          throw new Error('repo still creating');
        },
      } as unknown as Artifacts,
    } as Env;
    const remote = fakeRemote(() => new Response('unreachable', { status: 500 }));
    await expect(
      artifactsPusher(env, repo, { fetch: remote.fetch }).updateRef({ ref: 'refs/heads/x', oldOid: ZERO_OID, newOid: 'd'.repeat(40) }),
    ).rejects.toBeInstanceOf(RefStoreUnavailable);
    expect(remote.seen).toHaveLength(0);
  });
});
