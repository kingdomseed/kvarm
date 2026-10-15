/**
 * In-memory Artifacts for workerd tests. Objects are real git objects
 * (gitops builders), so hashes match what git computes for the same content.
 * Ref names are served through a fake protocol-v2 ls-refs endpoint on
 * `artifacts.invalid`, counted as subrequests like the real one.
 */

import * as zlib from 'node:zlib';
import {
  FLUSH_PKT,
  buildBlob,
  buildCommit,
  buildReportStatus,
  buildTree,
  concat,
  decode,
  gitOid,
  negotiatedSideband,
  parseReceivePackCommands,
  parseTree,
  pktLine,
  readPktLines,
  type TreeEntry,
} from '@kvarm/gitops';
import { countingFetch } from '../../src/cost/meter';

interface Obj {
  type: 'blob' | 'tree' | 'commit';
  content: Uint8Array;
}

export class FakeRepo {
  objects = new Map<string, Obj>();
  refs = new Map<string, string>();
  calls: string[] = [];
  /** Blob hashes whose next read throws once (simulated transient failure). */
  failBlobOnce = new Set<string>();
  /** Commits whose `log` throws NOT_FOUND, as the binding does for a missing commit. */
  logNotFound = new Set<string>();
  /** Blob hashes the binding refuses to buffer (ArtifactsError MEMORY_LIMIT). */
  memoryLimit = new Set<string>();
  /** Returned blobs not yet fully consumed, and the most held at once. */
  openBlobs = 0;
  maxOpenBlobs = 0;
  /** Bytes of the open blobs, and the most held at once. */
  openBytes = 0;
  maxOpenBytes = 0;
  /** Whole-blob materializations (arrayBuffer/bytes) by the caller. */
  materialized = 0;
  /** When set, receive-pack answers with this HTTP status and applies nothing. */
  receivePackStatus: number | null = null;
  /**
   * Awaited at a call, to interleave other work deterministically: before
   * readTree/readBlob/readCommit, inside a token mint (`createToken:<scope>`)
   * and before receive-pack applies anything, and after ls-refs has read the
   * refs it answers with (`lsRefs`).
   */
  hook: ((call: string) => Promise<void>) | null = null;

  count(prefix: string): number {
    return this.calls.filter((c) => c.startsWith(prefix)).length;
  }
}

/** Chunk size of the fake blob streams. */
export const FAKE_STREAM_CHUNK = 64 * 1024;

/**
 * A real Blob whose reads are tracked on the repo: it counts as open from
 * the readBlob reply until a full read (stream end, text or a
 * materialization), and stream() yields FAKE_STREAM_CHUNK slices.
 */
function trackedBlob(r: FakeRepo, content: Uint8Array): Blob {
  const blob = new Blob([content as Uint8Array<ArrayBuffer>]);
  r.openBlobs++;
  r.maxOpenBlobs = Math.max(r.maxOpenBlobs, r.openBlobs);
  r.openBytes += content.length;
  r.maxOpenBytes = Math.max(r.maxOpenBytes, r.openBytes);
  let open = true;
  const close = () => {
    if (open) {
      r.openBlobs--;
      r.openBytes -= content.length;
    }
    open = false;
  };
  return new Proxy(blob, {
    get(t, prop) {
      if (prop === 'arrayBuffer' || prop === 'bytes') {
        return async () => {
          r.materialized++;
          close();
          return prop === 'arrayBuffer' ? t.arrayBuffer() : new Uint8Array(await t.arrayBuffer());
        };
      }
      if (prop === 'text') {
        return async () => {
          close();
          return t.text();
        };
      }
      if (prop === 'stream') {
        return () => {
          let off = 0;
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              if (off >= content.length) {
                close();
                controller.close();
                return;
              }
              controller.enqueue(content.slice(off, off + FAKE_STREAM_CHUNK));
              off += FAKE_STREAM_CHUNK;
            },
          });
        };
      }
      const value: unknown = Reflect.get(t, prop);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value;
    },
  });
}

export const fakeRepos = new Map<string, FakeRepo>();

function entryType(mode: string): ArtifactsTreeEntryType {
  if (mode === '40000') return 'tree';
  if (mode === '120000') return 'symlink';
  if (mode === '160000') return 'gitlink';
  if (mode === '100755') return 'exec';
  return 'blob';
}

function parseCommit(content: Uint8Array, hash: string): ArtifactsCommitMetadata {
  const text = decode(content);
  const head = text.slice(0, text.indexOf('\n\n'));
  const tree = /^tree ([0-9a-f]{40})$/m.exec(head)![1]!;
  const parents = [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]!);
  const time = Number(/^committer .* (\d+) [+-]\d{4}$/m.exec(head)?.[1] ?? 0);
  const who = { name: 't', email: 't@kvarm.invalid' };
  const message = text.slice(text.indexOf('\n\n') + 2);
  return { hash, treeHash: tree, message, author: who, committer: who, parents, authoredAt: time, committedAt: time };
}

function handle(name: string): ArtifactsRepo {
  const r = fakeRepos.get(name);
  if (!r) throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
  return {
    async readTree(hash: string) {
      r.calls.push(`readTree:${hash}`);
      await r.hook?.(`readTree:${hash}`);
      const o = r.objects.get(hash);
      if (!o || o.type !== 'tree') return null;
      return parseTree(o.content).map((e) => ({ ...e, type: entryType(e.mode) }));
    },
    async readBlob(hash: string) {
      r.calls.push(`readBlob:${hash}`);
      await r.hook?.(`readBlob:${hash}`);
      if (r.failBlobOnce.delete(hash)) throw new Error('simulated transient readBlob failure');
      if (r.memoryLimit.has(hash)) {
        throw Object.assign(new Error('object cannot be buffered safely'), { name: 'ArtifactsError', code: 'MEMORY_LIMIT' });
      }
      const o = r.objects.get(hash);
      return o && o.type === 'blob' ? trackedBlob(r, o.content) : null;
    },
    async readCommit(hash: string) {
      r.calls.push(`readCommit:${hash}`);
      await r.hook?.(`readCommit:${hash}`);
      const o = r.objects.get(hash);
      return o && o.type === 'commit' ? parseCommit(o.content, hash) : null;
    },
    async log({ ref, limit = 50 }: { ref?: string; limit?: number } = {}) {
      r.calls.push(`log:${ref}`);
      if (ref && r.logNotFound.has(ref)) throw Object.assign(new Error('commit not found'), { code: 'NOT_FOUND' });
      let sha = ref && /^[0-9a-f]{40}$/.test(ref) ? ref : r.refs.get(`refs/heads/${ref}`);
      const out: ArtifactsCommitMetadata[] = [];
      while (sha && out.length < limit) {
        const o = r.objects.get(sha);
        if (!o || o.type !== 'commit') break;
        const c = parseCommit(o.content, sha);
        out.push(c);
        sha = c.parents[0];
      }
      return out;
    },
    async readFile({ ref, path }: { ref: string; path: string }) {
      r.calls.push(`readFile:${ref}:${path}`);
      await r.hook?.(`readFile:${ref}:${path}`);
      const sha = /^[0-9a-f]{40}$/.test(ref) ? ref : (r.refs.get(ref) ?? r.refs.get(`refs/heads/${ref}`) ?? r.refs.get(`refs/tags/${ref}`));
      const c = sha ? r.objects.get(sha) : undefined;
      if (!c || c.type !== 'commit') return null;
      let hash = parseCommit(c.content, sha!).treeHash;
      const parts = path.split('/').filter((p) => p.length > 0);
      for (let i = 0; i < parts.length; i++) {
        const t = r.objects.get(hash);
        if (!t || t.type !== 'tree') return null;
        const e = parseTree(t.content).find((x) => x.name === parts[i]);
        if (!e) return null;
        hash = e.hash;
      }
      const o = r.objects.get(hash);
      return o && o.type === 'blob' && parts.length > 0 ? new Blob([o.content as Uint8Array<ArrayBuffer>]) : null;
    },
    async createToken(scope: 'read' | 'write' = 'write', ttl = 86_400) {
      r.calls.push('createToken');
      await r.hook?.(`createToken:${scope}`);
      return { id: 't', plaintext: 'fake-token', scope, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
    },
    [Symbol.dispose]() {},
  } as unknown as ArtifactsRepo;
}

export const fakeArtifacts = {
  get: async (name: string) => handle(name),
  delete: async (name: string) => {
    fakeRepos.delete(name);
  },
} as unknown as Artifacts;

/** ls-refs over the fake refs, honoring ref-prefix like git upload-pack v2. */
function lsRefsResponse(repo: FakeRepo, body: Uint8Array): Response {
  const prefixes = readPktLines(body)
    .filter((p) => !p.flush && !p.delim && !p.responseEnd)
    .map((p) => decode(p.data).trim())
    .filter((l) => l.startsWith('ref-prefix '))
    .map((l) => l.slice('ref-prefix '.length));
  lsRefsPrefixes.push(prefixes);
  const lines = [...repo.refs]
    .filter(([n]) => prefixes.some((p) => n.startsWith(p)))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([n, oid]) => pktLine(`${oid} ${n}\n`));
  return new Response(concat(...lines, FLUSH_PKT), { headers: { 'content-type': 'application/x-git-upload-pack-result' } });
}

export const lsRefsCalls: string[] = [];
/** The ref-prefix lines of every ls-refs request, in request order. */
export const lsRefsPrefixes: string[][] = [];
const originalFetch = globalThis.fetch;

const PACK_TYPES: Record<number, Obj['type']> = { 1: 'commit', 2: 'tree', 3: 'blob' };

/** Objects of an undeltified pack (what the gitops pack writer produces). */
export function readPack(pack: Uint8Array): Array<{ type: Obj['type']; content: Uint8Array }> {
  if (pack.length < 32 || decode(pack.subarray(0, 4)) !== 'PACK') throw new Error('not a pack');
  const count = new DataView(pack.buffer, pack.byteOffset).getUint32(8);
  const out: Array<{ type: Obj['type']; content: Uint8Array }> = [];
  let off = 12;
  for (let i = 0; i < count; i++) {
    let byte = pack[off++]!;
    const type = PACK_TYPES[(byte >> 4) & 7];
    if (!type) throw new Error(`unsupported pack entry type ${(byte >> 4) & 7}`);
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[off++]!;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const r = zlib.inflateSync(pack.subarray(off), { info: true }) as unknown as { buffer: Uint8Array; engine: { bytesWritten: number } };
    if (r.buffer.length !== size) throw new Error('pack entry size mismatch');
    out.push({ type, content: new Uint8Array(r.buffer) });
    off += r.engine.bytesWritten;
  }
  return out;
}

/**
 * receive-pack on a fake repo: one compare-and-swap per command, the pack's
 * objects stored only when every command applies, report-status like git.
 */
async function receivePack(repo: FakeRepo, body: Uint8Array): Promise<Response> {
  const parsed = parseReceivePackCommands(body);
  if (parsed.status !== 'done') return new Response('bad request', { status: 400 });
  const call = `receivePack:${parsed.commands.map((c) => `${c.ref}:${c.oldOid}->${c.newOid}`).join(',')}`;
  repo.calls.push(call);
  await repo.hook?.(call);
  if (repo.receivePackStatus !== null) return new Response('unavailable', { status: repo.receivePackStatus });
  const stale = parsed.commands.filter((c) => (repo.refs.get(c.ref) ?? ZERO) !== c.oldOid);
  const results = parsed.commands.map((c) => ({ ref: c.ref, ok: stale.length === 0, ...(stale.includes(c) ? { reason: 'stale ref' } : {}) }));
  if (stale.length === 0) {
    const rest = body.subarray(parsed.end);
    for (const o of rest.length > 0 ? readPack(rest) : []) {
      repo.objects.set(await gitOid(o.type, o.content), o);
    }
    for (const c of parsed.commands) {
      if (/^0+$/.test(c.newOid)) repo.refs.delete(c.ref);
      else repo.refs.set(c.ref, c.newOid);
    }
  }
  return new Response(buildReportStatus(results, negotiatedSideband(parsed.capabilities)), {
    headers: { 'content-type': 'application/x-git-receive-pack-result' },
  });
}

const ZERO = '0'.repeat(40);

/** Routes artifacts.invalid upload-pack (ls-refs) and receive-pack requests to the fake repos. */
export function installFakeGitRemote(): void {
  globalThis.fetch = countingFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname !== 'artifacts.invalid') return originalFetch(input, init);
    if (!req.headers.get('authorization')?.startsWith('Bearer ')) return new Response('unauthorized', { status: 401 });
    const rp = /^\/git\/default\/(.+)\.git\/git-receive-pack$/.exec(url.pathname);
    if (rp) {
      const target = fakeRepos.get(rp[1]!);
      if (!target || req.method !== 'POST') return new Response('bad', { status: 404 });
      return receivePack(target, new Uint8Array(await req.arrayBuffer()));
    }
    const m = /^\/git\/default\/(.+)\.git\/git-upload-pack$/.exec(url.pathname);
    const repo = m ? fakeRepos.get(m[1]!) : undefined;
    if (!repo || req.headers.get('git-protocol') !== 'version=2') return new Response('bad', { status: 400 });
    lsRefsCalls.push(m![1]!);
    const res = lsRefsResponse(repo, new Uint8Array(await req.arrayBuffer()));
    await repo.hook?.('lsRefs');
    return res;
  }) as typeof fetch);
}

export function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// Repo builder
// ---------------------------------------------------------------------------

const enc = (s: string) => new TextEncoder().encode(s);
export type FileSpec = string | Uint8Array | { content: string | Uint8Array; mode: string };
export type Files = Record<string, FileSpec>;

export async function writeTree(repo: FakeRepo, files: Files): Promise<string> {
  const dirs = new Map<string, Files>();
  const entries: TreeEntry[] = [];
  for (const [path, spec] of Object.entries(files)) {
    const slash = path.indexOf('/');
    if (slash !== -1) {
      const dir = path.slice(0, slash);
      const sub = dirs.get(dir) ?? {};
      sub[path.slice(slash + 1)] = spec;
      dirs.set(dir, sub);
      continue;
    }
    const { content, mode } =
      typeof spec === 'string' || spec instanceof Uint8Array ? { content: spec, mode: '100644' } : spec;
    const bytes = typeof content === 'string' ? enc(content) : content;
    const blob = await buildBlob(bytes);
    repo.objects.set(blob.hash, { type: 'blob', content: bytes });
    entries.push({ mode, name: path, hash: blob.hash });
  }
  for (const [dir, sub] of dirs) entries.push({ mode: '40000', name: dir, hash: await writeTree(repo, sub) });
  const tree = await buildTree(entries);
  repo.objects.set(tree.hash, { type: 'tree', content: tree.raw.subarray(tree.raw.indexOf(0) + 1) });
  return tree.hash;
}

let clock = 1_700_000_000;
export async function commit(repo: FakeRepo, files: Files, parents: string[] = [], message?: string): Promise<{ sha: string; tree: string }> {
  const tree = await writeTree(repo, files);
  const who = { name: 't', email: 't@kvarm.invalid', time: clock++ };
  const c = await buildCommit({ tree, parents, author: who, committer: who, message: message ?? `c${clock}` });
  repo.objects.set(c.hash, { type: 'commit', content: c.raw.subarray(c.raw.indexOf(0) + 1) });
  return { sha: c.hash, tree };
}

/** Blob hash of a file's content, as git computes it. */
export async function blobHash(content: string | Uint8Array): Promise<string> {
  return (await buildBlob(typeof content === 'string' ? enc(content) : content)).hash;
}

// ---------------------------------------------------------------------------
// Minimal tar reader (ustar + pax) for checking archives inside workerd
// ---------------------------------------------------------------------------

export interface TarMember {
  path: string;
  type: 'file' | 'dir' | 'symlink';
  mode: number;
  data: Uint8Array;
  linkname: string;
}

function field(h: Uint8Array, off: number, len: number): string {
  const raw = h.subarray(off, off + len);
  const nul = raw.indexOf(0);
  return decode(nul === -1 ? raw : raw.subarray(0, nul));
}

function checksumOk(h: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  return parseInt(field(h, 148, 8).trim(), 8) === sum;
}

export function readTar(bytes: Uint8Array): TarMember[] {
  const out: TarMember[] = [];
  let off = 0;
  let pax: Record<string, string> = {};
  for (;;) {
    if (off + 512 > bytes.length) throw new Error('truncated tar');
    const h = bytes.subarray(off, off + 512);
    if (h.every((b) => b === 0)) {
      const next = bytes.subarray(off + 512, off + 1024);
      if (next.length !== 512 || !next.every((b) => b === 0)) throw new Error('missing end-of-archive blocks');
      if (off + 1024 !== bytes.length) throw new Error(`trailing bytes after end of archive: ${bytes.length - off - 1024}`);
      return out;
    }
    if (!checksumOk(h)) throw new Error(`bad header checksum at ${off}`);
    if (field(h, 257, 6) !== 'ustar') throw new Error(`not ustar at ${off}`);
    const flag = String.fromCharCode(h[156]!);
    let size = parseInt(field(h, 124, 12) || '0', 8);
    if (pax.size) size = Number(pax.size);
    const dataStart = off + 512;
    const data = bytes.subarray(dataStart, dataStart + size);
    off = dataStart + size + ((512 - (size % 512)) % 512);
    if (flag === 'x') {
      // Record lengths count bytes, so parse before decoding.
      pax = {};
      let i = 0;
      while (i < data.length) {
        const sp = data.indexOf(0x20, i);
        const len = Number(decode(data.subarray(i, sp)));
        const rec = decode(data.subarray(sp + 1, i + len - 1));
        const eq = rec.indexOf('=');
        pax[rec.slice(0, eq)] = rec.slice(eq + 1);
        i += len;
      }
      continue;
    }
    const prefix = field(h, 345, 155);
    let path = pax.path ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    const type = flag === '5' ? 'dir' : flag === '2' ? 'symlink' : 'file';
    if (type === 'dir') path = path.replace(/\/$/, '');
    out.push({
      path,
      type,
      mode: parseInt(field(h, 100, 8), 8),
      data: new Uint8Array(data),
      linkname: pax.linkpath ?? field(h, 157, 100),
    });
    pax = {};
  }
}
