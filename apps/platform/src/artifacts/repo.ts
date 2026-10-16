/**
 * Content reads from Artifacts. Thin wrappers around the binding so pages
 * deal with resolved values, not repo handles. Ref listing goes through the
 * git protocol (info/refs) because the binding has no refs enumeration.
 */

import { parseRefAdvertisement, type GitRef } from '@kvarm/gitops';
import type { RepoRow } from '../db/repos';
import { artifactsAuthorization, getGitToken } from './tokens';

/** Scoped repo handle; auto-disposes (the capability is an RPC stub). */
export async function withRepo<T>(
  env: Env,
  artifactsName: string,
  fn: (repo: ArtifactsRepo) => Promise<T>,
): Promise<T> {
  const repo = await env.ARTIFACTS.get(artifactsName);
  try {
    return await fn(repo);
  } finally {
    try {
      repo[Symbol.dispose]();
    } catch {
      // disposal is best-effort
    }
  }
}

/**
 * A repo handle opened on first use and disposed by `withLazyRepo`, so fully
 * cached paths never pay for `ARTIFACTS.get`.
 */
export class LazyRepo {
  private handle: Promise<ArtifactsRepo> | undefined;

  constructor(
    private readonly env: Env,
    readonly artifactsName: string,
  ) {}

  get = (): Promise<ArtifactsRepo> => {
    this.handle ??= this.env.ARTIFACTS.get(this.artifactsName);
    return this.handle;
  };

  async dispose(): Promise<void> {
    if (!this.handle) return;
    try {
      (await this.handle)[Symbol.dispose]();
    } catch {
      // disposal is best-effort; a failed open has nothing to release
    }
  }
}

export async function withLazyRepo<T>(env: Env, artifactsName: string, fn: (repo: LazyRepo) => Promise<T>): Promise<T> {
  const repo = new LazyRepo(env, artifactsName);
  try {
    return await fn(repo);
  } finally {
    await repo.dispose();
  }
}

/** Commit list for a ref (branch/tag/sha). Newest first, first-parent chain. */
export function commitAt(
  env: Env,
  artifactsName: string,
  ref: string,
  limit = 50,
  offset = 0,
): Promise<ArtifactsCommitMetadata[]> {
  return withRepo(env, artifactsName, (h) => h.log({ ref, limit, offset }));
}

/** A single commit by SHA (or any ref the service resolves). */
export function readCommit(
  env: Env,
  artifactsName: string,
  sha: string,
): Promise<ArtifactsCommitMetadata | null> {
  return withRepo(env, artifactsName, (h) => h.readCommit(sha));
}

/**
 * Tree entries at a path: resolves ref -> commit -> root tree, then walks
 * path components. Returns null when the path does not exist or names a file.
 */
export async function readTreeAtPath(
  env: Env,
  artifactsName: string,
  ref: string,
  path: string,
): Promise<{ entries: ArtifactsTreeEntry[]; rootTreeHash: string; commit: ArtifactsCommitMetadata } | null> {
  return withRepo(env, artifactsName, async (h) => {
    const commits = await h.log({ ref, limit: 1 });
    const commit = commits?.[0];
    if (!commit) return null;
    const parts = path.split('/').filter((p) => p.length > 0 && p !== '.');
    let treeHash: string = commit.treeHash;
    let lastEntries: ArtifactsTreeEntry[] | null = null;
    for (let i = 0; i < parts.length; i++) {
      const entries = await h.readTree(treeHash);
      if (!entries) return null;
      const entry = entries.find((e) => e.name === parts[i]);
      if (!entry) return null;
      if (i === parts.length - 1) {
        if (entry.mode === '40000' || entry.type === 'tree') {
          const sub = await h.readTree(entry.hash);
          if (!sub) return null;
          lastEntries = sub;
        } else {
          return null; // path names a file, not a directory
        }
      } else {
        if (entry.mode !== '40000' && entry.type !== 'tree') return null;
        treeHash = entry.hash;
      }
    }
    const entries = lastEntries ?? (await h.readTree(commit.treeHash));
    if (!entries) return null;
    return { entries, rootTreeHash: commit.treeHash, commit };
  });
}

/** File at (ref, path) with MIME type; null when missing or a directory. */
export function readFileAt(
  env: Env,
  artifactsName: string,
  ref: string,
  path: string,
): Promise<Blob | null> {
  return withRepo(env, artifactsName, (h) => h.readFile({ ref, path }));
}

/** All refs via the v0 smart protocol advertisement. */
export async function listRefs(
  env: Env,
  repo: RepoRow,
): Promise<{ branches: GitRef[]; tags: GitRef[]; head: GitRef | null }> {
  const token = await getGitToken(env, repo.artifacts_name, 'read');
  const res = await fetch(`${repo.artifacts_remote}/info/refs?service=git-upload-pack`, {
    headers: { Authorization: artifactsAuthorization(token) },
  });
  if (!res.ok) throw new Error(`info/refs failed (${res.status})`);
  const body = new Uint8Array(await res.arrayBuffer());
  const { refs } = parseRefAdvertisement(body);
  return {
    branches: refs.filter((r) => r.name.startsWith('refs/heads/')),
    tags: refs.filter((r) => r.name.startsWith('refs/tags/')),
    head: refs.find((r) => r.name === 'HEAD') ?? null,
  };
}

/** True when the ref is a literal commit hash (immutable, long-cacheable). */
export function isCommitRef(ref: string): boolean {
  return /^[0-9a-f]{40}$/.test(ref);
}

export const README_CANDIDATES = [
  'README.md',
  'README.markdown',
  'README.mdx',
  'README',
  'readme.md',
];
