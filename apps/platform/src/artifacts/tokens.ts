/**
 * Repo-scoped Artifacts git tokens, cached per (repo, scope) in the Cache API.
 * A miss mints through the Artifacts binding directly, so the git gate never
 * calls a Durable Object (git-gate budget do=0); the cost is one mint per colo
 * per refresh window. Anonymous public reads and PAT-authenticated reads share
 * the read token because platform authorization has already happened.
 */

import { deleteCached, internalKey, readCachedJson, writeCachedJson } from '../cache/internal';

const TTL_SECONDS: Record<'read' | 'write', number> = {
  read: 3600, // 1 hour
  write: 21600, // 6 hours
};

interface CachedToken {
  token: string;
  expiresAt: number;
}

function tokenKey(artifactsName: string, scope: 'read' | 'write'): Request {
  return internalKey('gittoken', artifactsName, scope);
}

/**
 * `handle` lets a caller that already holds (or lazily opens) the repo
 * capability mint through it instead of opening a second one; the caller
 * then owns its disposal.
 */
export async function getGitToken(
  env: Env,
  artifactsName: string,
  scope: 'read' | 'write',
  handle?: () => Promise<ArtifactsRepo>,
): Promise<string> {
  const ttl = TTL_SECONDS[scope];
  // Tokens are refreshed once less than a quarter of their lifetime remains.
  const refreshMarginMs = (ttl * 1000) / 4;
  const key = tokenKey(artifactsName, scope);
  const now = Date.now();
  const cached = await readCachedJson<CachedToken>(key);
  if (cached && cached.expiresAt - now > refreshMarginMs) return cached.token;

  let minted: ArtifactsCreateTokenResult;
  if (handle) {
    minted = await (await handle()).createToken(scope, ttl);
  } else {
    const repo = await env.ARTIFACTS.get(artifactsName);
    try {
      minted = await repo.createToken(scope, ttl);
    } finally {
      try {
        repo[Symbol.dispose]();
      } catch {
        // disposal is best-effort
      }
    }
  }
  const parsed = minted.expiresAt ? Date.parse(minted.expiresAt) : NaN;
  const expiresAt = Number.isNaN(parsed) ? now + ttl * 1000 : parsed;
  await writeCachedJson(key, { token: minted.plaintext, expiresAt } satisfies CachedToken, (expiresAt - now - refreshMarginMs) / 1000);
  return minted.plaintext;
}

/**
 * A token that can read the repo over the git protocol. Write tokens are
 * read-capable (Artifacts serves upload-pack to them), so a copy warmed by a
 * push is reused before minting a read token.
 */
export async function getReadCapableToken(
  env: Env,
  artifactsName: string,
  handle?: () => Promise<ArtifactsRepo>,
): Promise<string> {
  const now = Date.now();
  const [read, write] = await Promise.all([
    readCachedJson<CachedToken>(tokenKey(artifactsName, 'read')),
    readCachedJson<CachedToken>(tokenKey(artifactsName, 'write')),
  ]);
  for (const [cached, scope] of [
    [read, 'read'],
    [write, 'write'],
  ] as const) {
    if (cached && cached.expiresAt - now > (TTL_SECONDS[scope] * 1000) / 4) return cached.token;
  }
  return getGitToken(env, artifactsName, 'read', handle);
}

/**
 * Artifacts accepts the full token, `?expires=` suffix included, only as a
 * Bearer credential (https://developers.cloudflare.com/artifacts/api/git-protocol/#authentication).
 */
export function artifactsAuthorization(token: string): string {
  return `Bearer ${token}`;
}

/** Drops this colo's token copies, e.g. when the repo is deleted or Artifacts refuses one. */
export async function purgeGitTokens(artifactsName: string): Promise<void> {
  await Promise.all([deleteCached(tokenKey(artifactsName, 'read')), deleteCached(tokenKey(artifactsName, 'write'))]);
}
