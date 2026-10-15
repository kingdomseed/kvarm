/**
 * Platform personal access tokens (PATs) for git-over-HTTPS, REST, and MCP.
 * Human sign-in is WorkOS AuthKit (see auth/workos.ts); PATs exist because
 * git clients need basic-auth credentials tied to a user. Tokens are stored
 * SHA-256-hashed; the plaintext is shown exactly once at mint time.
 */

import { sha256Hex } from '@kvarm/gitops';
import { toUserRow, type UserRow } from '../db/users';
import { deleteCached, internalKey, readCachedJson, writeCachedJson } from '../cache/internal';
import type { AgentGrant } from './agentTokens';

export type Scope = 'read' | 'write' | 'api' | 'ci';

export const SCOPES: readonly Scope[] = ['read', 'write', 'api', 'ci'];

/** Well-formed tokens only; anything else is rejected without touching D1. */
export const PAT_PATTERN = /^kvarm_pat_[0-9a-f]{64}$/;

/** Reusable verification metadata lifetime in the Cache API. */
export const PAT_CACHE_TTL_SECONDS = 60;

/** At most one last_used_at write per PAT per window. */
export const PAT_STAMP_INTERVAL_MS = 10 * 60_000;

export interface PATInfo {
  id: string;
  userId: string;
  scopes: Scope[];
  user: UserRow;
  expiresAt: number | null;
  lastUsedAt: number | null;
  /**
   * Set for agent tokens (auth/agentTokens.ts). `user` is then the minting
   * human, whose current role on the repo caps the token.
   */
  agent?: AgentGrant;
}

/** write implies read for git operations. */
export function scopesAllow(scopes: string[], needed: Scope): boolean {
  if (scopes.includes(needed)) return true;
  return needed === 'read' && scopes.includes('write');
}

function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const b of buf) s += b.toString(16).padStart(2, '0');
  return s;
}

export function parseBasicAuth(
  header: string | undefined,
): { username: string; password: string } | null {
  // Auth scheme names are case-insensitive (RFC 9110 section 11.1).
  if (!header || header.slice(0, 6).toLowerCase() !== 'basic ') return null;
  try {
    const decoded = atob(header.slice(6));
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

export async function mintPAT(
  env: Env,
  userId: string,
  name: string,
  scopes: Scope[],
  expiresAt: number | null = null,
): Promise<{ id: string; token: string; prefix: string }> {
  const token = `kvarm_pat_${randomHex(32)}`;
  const hash = await sha256Hex(token);
  const id = crypto.randomUUID();
  const prefix = token.slice(0, 18);
  await env.DB.prepare(
    'INSERT INTO pat (id, user_id, name, prefix, hash, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, userId, name, prefix, hash, JSON.stringify(scopes), Date.now(), expiresAt)
    .run();
  return { id, token, prefix };
}

/**
 * Deletes the PAT row and drops this colo's cached verification. Other colos
 * may keep reusable metadata for up to PAT_CACHE_TTL_SECONDS, which is why
 * private and write decisions always re-check D1 (services/access.ts).
 */
export async function revokePAT(env: Env, id: string, userId: string): Promise<boolean> {
  const row = await env.DB.prepare('DELETE FROM pat WHERE id = ? AND user_id = ? RETURNING hash')
    .bind(id, userId)
    .first<{ hash: string }>();
  if (!row) return false;
  await deleteCached(patCacheKey(row.hash));
  return true;
}

export function patHash(token: string): Promise<string> {
  return sha256Hex(token);
}

/** One `pat JOIN users` lookup; a missing user row fails closed. */
export function patSelect(db: D1Database, hash: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT p.id AS pat_id, p.scopes AS pat_scopes, p.expires_at AS pat_expires_at,
              p.last_used_at AS pat_last_used_at, u.*
         FROM pat p JOIN users u ON u.id = p.user_id
        WHERE p.hash = ?`,
    )
    .bind(hash);
}

/** Stamps last_used_at only when the stored value is older than the throttle window. */
export interface PatListRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
}

/** The token list for the API and the settings page (routes/api.ts, routes/web.ts). */
export function patListStatement(db: D1Database, userId: string, limit?: number): D1PreparedStatement {
  return limit === undefined
    ? db.prepare('SELECT id, name, prefix, scopes, created_at, last_used_at FROM pat WHERE user_id = ? ORDER BY created_at DESC').bind(userId)
    : db.prepare('SELECT id, name, prefix, scopes, created_at, last_used_at FROM pat WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').bind(userId, limit);
}

export function patStamp(db: D1Database, hash: string, now: number): D1PreparedStatement {
  return db
    .prepare('UPDATE pat SET last_used_at = ?1 WHERE hash = ?2 AND (last_used_at IS NULL OR last_used_at < ?3)')
    .bind(now, hash, now - PAT_STAMP_INTERVAL_MS);
}

export type PatRow = Omit<UserRow, 'is_admin'> & {
  is_admin: unknown;
  pat_id: string;
  pat_scopes: string;
  pat_expires_at: number | null;
  pat_last_used_at: number | null;
};

/** Stored scopes, keeping only known ones; malformed values grant nothing. */
export function parseScopes(json: string): Scope[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((s): s is Scope => SCOPES.includes(s as Scope)) : [];
  } catch {
    return [];
  }
}

export function patFromRow(row: PatRow | null | undefined, now: number): PATInfo | null {
  if (!row) return null;
  if (row.pat_expires_at !== null && row.pat_expires_at < now) return null;
  const scopes = parseScopes(row.pat_scopes);
  const { pat_id, pat_scopes: _s, pat_expires_at, pat_last_used_at, ...user } = row;
  return {
    id: pat_id,
    userId: user.id,
    scopes,
    user: toUserRow(user),
    expiresAt: pat_expires_at,
    lastUsedAt: pat_last_used_at,
  };
}

/** True when a use at `now` should stamp last_used_at again. */
export function patNeedsStamp(pat: PATInfo | null | undefined, now: number): boolean {
  return !pat || pat.lastUsedAt === null || now - pat.lastUsedAt >= PAT_STAMP_INTERVAL_MS;
}

// ---------------------------------------------------------------------------
// Cache API copy of verification results, keyed by token hash
// ---------------------------------------------------------------------------

type PatCacheEntry = { valid: true; pat: PATInfo } | { valid: true; seen: true } | { valid: false };

/**
 * A cached verification result: the PAT, 'invalid' for a cached rejection,
 * 'seen' for a recently valid agent token (which only exempts it from the
 * preauth throttle; authorization still reads D1), or undefined on a miss.
 */
export type PatCacheResult = PATInfo | 'invalid' | 'seen' | undefined;

export function patCacheKey(hash: string): Request {
  return internalKey('pat', hash);
}

export async function readPatCache(hash: string, now: number): Promise<PatCacheResult> {
  const entry = await readCachedJson<PatCacheEntry>(patCacheKey(hash));
  if (!entry) return undefined;
  if (!entry.valid) return 'invalid';
  if ('seen' in entry) return 'seen';
  if (entry.pat.agent) return undefined;
  if (entry.pat.expiresAt !== null && entry.pat.expiresAt < now) return 'invalid';
  return entry.pat;
}

/** Agent tokens never get a reusable positive entry; their checks always go to D1. */
export async function writePatCache(hash: string, pat: PATInfo | null, now: number): Promise<void> {
  if (!pat) {
    await writeCachedJson(patCacheKey(hash), { valid: false } satisfies PatCacheEntry, PAT_CACHE_TTL_SECONDS);
    return;
  }
  if (pat.agent) {
    const ttl = pat.expiresAt === null ? PAT_CACHE_TTL_SECONDS : Math.min(PAT_CACHE_TTL_SECONDS, (pat.expiresAt - now) / 1000);
    await writeCachedJson(patCacheKey(hash), { valid: true, seen: true } satisfies PatCacheEntry, ttl);
    return;
  }
  const ttl =
    pat.expiresAt === null
      ? PAT_CACHE_TTL_SECONDS
      : Math.min(PAT_CACHE_TTL_SECONDS, (pat.expiresAt - now) / 1000);
  await writeCachedJson(patCacheKey(hash), { valid: true, pat } satisfies PatCacheEntry, ttl);
}
