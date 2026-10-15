/**
 * Git smart-HTTP proxy: the fastest possible clone path on Artifacts.
 *
 * Design (see docs/architecture.md §1.1):
 *  - Platform auth happens here (PATs or anonymous public reads); storage is
 *    Cloudflare Artifacts, reached same-network over the Worker fetch API.
 *  - The proxy streams both directions and buffers nothing, so clones and
 *    pushes add ~1-3ms and flat memory/CPU regardless of repo size.
 *  - Anonymous and authenticated reads share a per-repo read-only Artifacts
 *    token minted through the binding and cached in the Cache API
 *    (platform authorization has already happened by then).
 *  - info/refs advertisements for public repos are edge-cached briefly so
 *    bursty CI clones skip the backend hop. The cache is checked after
 *    authorization and before any token mint or upstream fetch, keyed by the
 *    repo view generation that a confirmed push moves before its reply ends.
 *  - No Durable Object on this path: rate limits use the Workers Rate
 *    Limiting bindings and tokens come from the Cache API.
 */

import type { Context } from 'hono';
import type { RepoRow } from '../db/repos';
import { parseBasicAuth } from '../auth/pat';
import { artifactsAuthorization, getGitToken, purgeGitTokens } from '../artifacts/tokens';
import { gitRateLimit } from '../ratelimit';
import { markCache } from '../cost/meter';
import { withPrivateCacheControl } from '../cache/scope';
import { resolveRepoAccess, type AccessDenyCode } from '../services/access';
import { credentialMayUpdateRef, type Actor } from '../services/authz';
import { gateReceivePack } from '../services/receivePackGate';
import { WORKSPACE_REF_PREFIX, agentWorkspaceDenial, workspaceOwners, type WorkspaceOwner } from '../services/workspaces';
import { agentReservedRefDenial, directHumanPushDenial, directPushDenial, INVALID_REF_REASON, type BranchRule } from '../services/branchRules';
import { isSafeRefName, type RefCommand } from '@kvarm/gitops';
import { recordConfirmedPush, relayReceivePackReply, repoViewGeneration } from '../services/pushFreshness';
import { recordPushAudit } from '../services/audit';
import { branchPushUpdates, dispatchConfirmedPush } from '../services/pushFastPath';

/** /{owner}/{repo}(.git)/{git subpath} — mounted before all web routes. */
export const GIT_PATH_RE =
  /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack|HEAD|objects\/[^/]+\/[^/]+)$/;

function unauthorized(): Response {
  return new Response(null, {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="kvarm", charset="UTF-8"' },
  });
}

function rateLimited(): Response {
  return new Response('rate limit exceeded, slow down\n', {
    status: 429,
    headers: { 'Retry-After': '60' },
  });
}

function denied(status: 401 | 403 | 404 | 429, code: AccessDenyCode): Response {
  if (status === 401) return unauthorized();
  if (status === 429) return rateLimited();
  if (status === 404) return new Response('repository not found\n', { status: 404 });
  return new Response(
    code === 'INSUFFICIENT_SCOPE' ? 'insufficient token scope\n' : 'permission denied\n',
    { status: 403 },
  );
}

/** Upstream headers relayed to git clients; everything else stays server-side. */
const RELAYED_HEADERS = ['content-type', 'cache-control', 'expires', 'pragma', 'content-encoding'];

function relay(upstream: Response): Response {
  const headers = new Headers();
  for (const h of RELAYED_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

/** Agent tokens get only the request shapes git itself sends. */
function agentMethodAllowed(subpath: string, method: string): boolean {
  if (subpath === 'git-upload-pack' || subpath === 'git-receive-pack') return method === 'POST';
  return method === 'GET' || method === 'HEAD';
}

/**
 * git gzips upload-pack request bodies over 1024 bytes (fetches naming many
 * refs) but Artifacts reads only plain pkt-lines, so the proxy decodes them
 * as a stream. Encodings git never sends are refused before any upstream work.
 */
function decodedRequestBody(
  request: Request,
): { ok: true; body: ReadableStream<Uint8Array> | null } | { ok: false; response: Response } {
  const encoding = (request.headers.get('content-encoding') ?? '').trim().toLowerCase();
  if (encoding === '' || encoding === 'identity') return { ok: true, body: request.body };
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    return { ok: true, body: request.body?.pipeThrough(new DecompressionStream('gzip')) ?? null };
  }
  return { ok: false, response: new Response('unsupported request content-encoding\n', { status: 415 }) };
}

function operation(subpath: string, service: string | null): 'read' | 'write' {
  if (subpath === 'git-receive-pack') return 'write';
  if (subpath === 'info/refs' && service === 'git-receive-pack') return 'write';
  return 'read';
}

/**
 * Edge-cache key for a public info/refs advertisement. v0 and v2
 * advertisements differ for the same URL, so the key includes Git-Protocol;
 * the repo view generation retires it on a confirmed push.
 */
export function infoRefsCacheKey(
  artifactsRemote: string,
  search: string,
  gitProtocol: string | null,
  generation: string,
): Request {
  const keyUrl = new URL(`${artifactsRemote}/info/refs`);
  keyUrl.search = search;
  keyUrl.searchParams.set('kvarm-git-protocol', gitProtocol ?? '');
  keyUrl.searchParams.set('kvarm-gen', generation);
  return new Request(keyUrl.toString(), { method: 'GET' });
}

export type GitAccess =
  | { ok: true; repo: RepoRow; actor: Actor | null; op: 'read' | 'write'; branchRules: BranchRule[] }
  | { ok: false; response: Response };

/** Authenticates and authorizes one git request; nothing upstream is touched. */
export async function authorizeGitRequest(
  env: Env,
  request: Request,
  owner: string,
  name: string,
  subpath: string,
): Promise<GitAccess> {
  const op = operation(subpath, new URL(request.url).searchParams.get('service'));

  const basic = parseBasicAuth(request.headers.get('Authorization') ?? undefined);

  // Anonymous writes never need a repo lookup; challenge before touching D1.
  if (op === 'write' && !basic) return { ok: false, response: unauthorized() };

  const access = await resolveRepoAccess(env, {
    owner,
    name,
    need: op,
    transport: 'git',
    credential: basic ? { kind: 'pat', token: basic.password } : { kind: 'anonymous' },
    clientIp: request.headers.get('CF-Connecting-IP'),
    branchRules: subpath === 'git-receive-pack',
  });
  if (!access.ok) return { ok: false, response: denied(access.status, access.code) };
  return { ok: true, repo: access.repo, actor: access.actor, op, branchRules: access.branchRules ?? [] };
}

export async function handleGitRequest(
  c: Context<{ Bindings: Env }>,
  owner: string,
  name: string,
  subpath: string,
): Promise<Response> {
  const env = c.env;
  const url = new URL(c.req.url);
  const access = await authorizeGitRequest(env, c.req.raw, owner, name, subpath);
  if (!access.ok) return access.response;
  const { repo, actor, op, branchRules } = access;
  const isPublic = repo.visibility === 'public';
  const scoped = (res: Response): Response => (isPublic && !actor ? res : withPrivateCacheControl(res));

  // Rate limit by PAT id (or client IP for anonymous public reads).
  const identity = actor?.patId ?? `ip:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`;
  if (!(await gitRateLimit(env, op, identity))) return rateLimited();

  if (actor?.agent && !agentMethodAllowed(subpath, c.req.method)) {
    return new Response('method not allowed\n', { status: 405 });
  }

  let uploadBody: ReadableStream<Uint8Array> | null = null;
  if (subpath === 'git-upload-pack' && c.req.method === 'POST') {
    const decoded = decodedRequestBody(c.req.raw);
    if (!decoded.ok) return decoded.response;
    uploadBody = decoded.body;
  }

  // Agent tokens are confined to their granted refs (workspace refs also to
  // an active workspace the agent may use), protected refs refuse direct
  // pushes from everyone (instance admin included), and human credentials
  // cannot write platform-reserved namespaces. Every command's ref name is
  // validated before any grant check, so a malformed name is rejected up
  // front and never echoed back into a report-status line. The push command
  // list is checked before any upstream token mint or byte of the pack is
  // forwarded.
  let pushBody: ReadableStream<Uint8Array> | null = null;
  let pushCommands: RefCommand[] = [];
  if (subpath === 'git-receive-pack') {
    let owners: Promise<Map<string, WorkspaceOwner>> | null = null;
    const gate = await gateReceivePack(c.req.raw, async (cmd, commands) => {
      if (!isSafeRefName(cmd.ref)) return INVALID_REF_REASON;
      if (actor?.agent) {
        if (!credentialMayUpdateRef(actor, cmd.ref)) return 'ref outside agent token grant';
        if (cmd.ref.startsWith(WORKSPACE_REF_PREFIX)) {
          owners ??= workspaceOwners(env, repo.id, commands);
          const denied = agentWorkspaceDenial(actor, cmd, await owners);
          if (denied) return denied;
        } else {
          const reserved = agentReservedRefDenial(cmd.ref);
          if (reserved) return reserved;
        }
        return directPushDenial(branchRules, cmd.ref);
      }
      return directHumanPushDenial(branchRules, cmd.ref);
    });
    if (!gate.ok) return gate.response;
    pushBody = gate.body;
    pushCommands = gate.commands;
  }

  // Warm public advertisements are served before any token mint or upstream
  // fetch; authorization above already ran on the current repo state.
  const cacheKey =
    op === 'read' && isPublic && subpath === 'info/refs' && c.req.method === 'GET'
      ? infoRefsCacheKey(
          repo.artifacts_remote,
          url.search,
          c.req.header('git-protocol') ?? null,
          await repoViewGeneration(repo),
        )
      : null;
  if (cacheKey) {
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      markCache('hit');
      return scoped(cached);
    }
    markCache('miss');
  }

  // Mint (or reuse) a short-lived repo-scoped Artifacts token upstream.
  let artifactsToken: string;
  try {
    artifactsToken = await getGitToken(env, repo.artifacts_name, op);
  } catch (err) {
    // Most common cause: repo is still importing/creating upstream. Upstream
    // detail stays in logs, never in the client response.
    console.warn(JSON.stringify({ gitTokenMintFailed: String(err).slice(0, 200) }));
    return new Response('repository storage is warming up, retry shortly\n', {
      status: 503,
      headers: { 'Retry-After': '5' },
    });
  }

  const upstream = new URL(`${repo.artifacts_remote}/${subpath}`);
  upstream.search = url.search;

  const headers = new Headers();
  headers.set('Authorization', artifactsAuthorization(artifactsToken));
  for (const h of ['content-type', 'accept', 'git-protocol', 'user-agent']) {
    const v = c.req.raw.headers.get(h);
    if (v) headers.set(h, v);
  }

  const init: RequestInit = { method: c.req.method, headers };
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    init.body = pushBody ?? uploadBody ?? c.req.raw.body;
  }
  const upstreamRes = await fetch(upstream.toString(), init);

  // The caller is already authorized, so a refusal is the platform token's
  // fault. Relayed as 401, git would prompt and then erase the user's PAT.
  // Dropping the cached token lets the next request mint a fresh one.
  if (upstreamRes.status === 401 || upstreamRes.status === 403) {
    await upstreamRes.body?.cancel();
    console.warn(JSON.stringify({ gitUpstreamRefused: upstreamRes.status, subpath }));
    await purgeGitTokens(repo.artifacts_name);
    return new Response('repository storage refused the request, retry shortly\n', { status: 502 });
  }

  // Briefly edge-cache public clone bootstrapping.
  if (cacheKey && upstreamRes.status === 200) {
    const res = relay(upstreamRes);
    res.headers.set('Cache-Control', 'public, max-age=30');
    try {
      c.executionCtx.waitUntil(caches.default.put(cacheKey, res.clone()).catch(() => undefined));
    } catch {
      // cache.put can race on streaming bodies; never fail a clone over it.
    }
    return scoped(res);
  }

  if (subpath === 'git-receive-pack' && upstreamRes.ok && upstreamRes.body) {
    // The client's push completes only after a confirmed update has moved the
    // view generation, so the next read cannot be served a pre-push entry.
    const body = relayReceivePackReply(upstreamRes.body, {
      // The audit ledger records who moved which confirmed refs (services/audit.ts), and the push-side fast path
      // (services/pushFastPath.ts) starts the guard and CI dispatch from the push the gate itself confirmed, both
      // in the background: the reply waits only for the freshness writes.
      onConfirmed: async (refs) => {
        c.executionCtx.waitUntil(recordPushAudit(env, repo.id, actor, pushCommands, refs));
        await recordConfirmedPush(env, repo.id);
        // The guard and CI dispatch start here instead of waiting seconds for
        // the Artifacts event. Background work only: the reply is already
        // complete, and the event remains the reliable, idempotent path for
        // every effect.
        const updates = branchPushUpdates(pushCommands, refs);
        if (updates.length > 0) {
          c.executionCtx.waitUntil(
            dispatchConfirmedPush(env, repo.id, updates).catch((err: unknown) =>
              console.warn(JSON.stringify({ pushFastPathFailed: String(err).slice(0, 200) })),
            ),
          );
        }
      },
      waitUntil: (p) => c.executionCtx.waitUntil(p),
    });
    return scoped(relay(new Response(body, upstreamRes)));
  }

  return scoped(relay(upstreamRes));
}
