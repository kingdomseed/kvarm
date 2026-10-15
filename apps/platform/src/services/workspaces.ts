/**
 * Agent workspaces (architecture §4 services/workspaces.ts, §9).
 *
 * A workspace is a row in `workspaces` plus its ref
 * `refs/heads/agents/<id>/<slug>`, created server-side through GitPusher at
 * the base head when the workspace is created, so the ref exists before any
 * push. Agents push to it with ordinary git; the push dispatcher's head
 * refresh moves a linked change set, because the change's head branch is the
 * workspace branch. Lifecycle: `active` → `merged` (its change set merged;
 * the merge path flips the row in its merged batch) or `abandoned` (explicit
 * abandon deletes the ref). Nothing is ever deleted automatically.
 *
 * Agent tokens are bound to workspace ownership at the git gate: a ref below
 * `refs/heads/agents/<id>/` is writable by an agent token only while
 * workspace `<id>` exists in that repo, is active, and is either the
 * agent's own or a person's workspace the token's ref patterns grant.
 */

import { isSafeRefName, isZeroOid, type RefCommand } from '@kvarm/gitops';
import { withLazyRepo } from '../artifacts/repo';
import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import { WORKSPACE_REF_PREFIX } from './agentMeta';
export { WORKSPACE_REF_PREFIX };
import { fail, guarded as baseGuarded, objectBody } from './result';
import { credentialMayUpdateRef, type Actor } from './authz';
import type { BranchRule } from './branchRules';
import { createChange, normalizeBranch, type CreatedChangeDetail } from './changes';
import { RESOLVE_CONFLICT } from './conflicts';
import { artifactsPusher, type GitPusher } from './gitwrite';
import { RefStoreUnavailable, lsRefs, type ResolveContext } from './refs';
import { normalizeDeclaration, type Declaration } from './intents/paths';
import { declaredInsertStatement, repoShareCleanup, repoSignalCleanup, workspaceSignalCleanup } from './intents/store';
import { actorName, openIssueExists, workspaceIssueStatement } from './issues';


export const WORKSPACE_STATUSES = ['active', 'merged', 'abandoned'] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export const WORKSPACE_LIMITS = {
  taskMax: 500,
  agentMax: 100,
  slugMax: 40,
  pageDefault: 50,
  pageMax: 100,
};

const ZERO_SHA = '0000000000000000000000000000000000000000';
export const WORKSPACE_ID_RE = /^[0-9a-z]{1,64}$/;
const ID_RE = WORKSPACE_ID_RE;

// ---------------------------------------------------------------------------
// Rows and views
// ---------------------------------------------------------------------------

export interface WorkspaceRow {
  id: string;
  task: string | null;
  agent: string | null;
  agent_id: string | null;
  status: WorkspaceStatus;
  ref: string | null;
  base_ref: string | null;
  base_sha: string | null;
  head_sha: string | null;
  change_set_id: string | null;
  change_number: number | null;
  /** The linked change's publication base, which may differ from the workspace's creation base. */
  change_base_ref: string | null;
  created_by_login: string | null;
  /** The ref position from push events (repo_refs); may lag a push by seconds. */
  ref_sha: string | null;
  created_at: number;
  updated_at: number | null;
  abandoned_at: number | null;
  merged_at: number | null;
  intent_paths: string | null;
  arena_id: string | null;
  seq: number;
}

export const WORKSPACE_SELECT = `SELECT w.id, w.task, w.agent, w.agent_id, w.status, w.ref, w.base_ref, w.base_sha, w.head_sha,
       w.change_set_id, c.number AS change_number, c.base_ref AS change_base_ref, u.login AS created_by_login, f.sha AS ref_sha,
       w.created_at, w.updated_at, w.abandoned_at, w.merged_at, w.intent_paths, w.arena_id, w.rowid AS seq
  FROM workspaces w
  LEFT JOIN change_sets c ON c.id = w.change_set_id
  LEFT JOIN users u ON u.id = w.created_by
  LEFT JOIN repo_refs f ON f.repo_id = w.repo_id AND f.ref = w.ref`;

export interface WorkspaceView {
  id: string;
  task: string | null;
  agent: string | null;
  /** The owning agent principal; null for a workspace a person created. */
  agentId: string | null;
  status: WorkspaceStatus;
  ref: string | null;
  branch: string | null;
  pushUrl: string;
  base: string | null;
  baseSha: string | null;
  headSha: string | null;
  /** Number of the change set opened from this workspace. */
  changeSet: number | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  abandonedAt: string | null;
  mergedAt: string | null;
  /** The declared intent (normalized paths; a trailing `/` is a prefix), advisory only. */
  declaredPaths: string[];
  /** The arena the workspace was created for, if any. */
  arena: string | null;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function recordedHead(row: WorkspaceRow): string | null {
  if (row.status !== 'active') return row.head_sha;
  const pushed = row.ref_sha && row.ref_sha !== ZERO_SHA ? row.ref_sha : null;
  return pushed ?? row.head_sha ?? row.base_sha;
}

export function workspaceView(row: WorkspaceRow, repo: RepoRow, origin: string, headSha = recordedHead(row)): WorkspaceView {
  return {
    id: row.id,
    task: row.task,
    agent: row.agent,
    agentId: row.agent_id,
    status: row.status,
    ref: row.ref,
    branch: row.ref?.startsWith('refs/heads/') ? row.ref.slice('refs/heads/'.length) : null,
    pushUrl: `${origin}/${repo.owner_login}/${repo.name}.git`,
    base: row.base_ref,
    baseSha: row.base_sha,
    headSha,
    changeSet: row.change_number,
    createdBy: row.created_by_login,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at ?? row.created_at)!,
    abandonedAt: iso(row.abandoned_at),
    mergedAt: iso(row.merged_at),
    declaredPaths: row.intent_paths ? (JSON.parse(row.intent_paths) as string[]) : [],
    arena: row.arena_id,
  };
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface WorkspaceContext {
  env: Env;
  repo: RepoRow;
  actor: Actor | null;
  /** Origin of the request, for the push URL (`https://host`). */
  origin: string;
  branchRules?: BranchRule[];
  waitUntil(p: Promise<unknown>): void;
}

export interface WorkspaceDeps {
  pusher(env: Env, repo: RepoRow): GitPusher;
}

export const defaultWorkspaceDeps: WorkspaceDeps = { pusher: (env, repo) => artifactsPusher(env, repo) };


const guarded = <T>(fn: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> => baseGuarded('workspacesRefStore', fn);

/** Fresh ref positions (one ls-refs round trip, never cached). */
export function liveRefs(cx: Pick<WorkspaceContext, 'env' | 'repo' | 'waitUntil'>, names: string[]): Promise<Map<string, string | null>> {
  return withLazyRepo(cx.env, cx.repo.artifacts_name, (artifacts) => {
    const ctx: ResolveContext = { env: cx.env, repo: cx.repo, artifacts, bypass: false, waitUntil: cx.waitUntil };
    return lsRefs(ctx, names);
  });
}

function readRow(env: Env, repoId: string, id: string): Promise<WorkspaceRow | null> {
  return env.DB.prepare(`${WORKSPACE_SELECT} WHERE w.repo_id = ? AND w.id = ?`).bind(repoId, id).first<WorkspaceRow>();
}

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function workspaceSlug(task: string): string {
  const slug = task
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, WORKSPACE_LIMITS.slugMax)
    .replace(/-+$/, '');
  return slug || 'work';
}

/** The workspace id a ref belongs to (`refs/heads/agents/<id>/<rest>`), else null. */
export function workspaceIdOf(ref: string): string | null {
  if (!ref.startsWith(WORKSPACE_REF_PREFIX)) return null;
  const rest = ref.slice(WORKSPACE_REF_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  const id = rest.slice(0, slash);
  return ID_RE.test(id) ? id : null;
}

/**
 * Why an agent actor may not act on the workspace (null: it may): an
 * agent-owned workspace belongs to that agent only, and in every case the
 * token's ref patterns must grant the workspace ref. Ownership narrows the
 * token's ceiling; it never widens it.
 */
export function agentOwnershipDenial(actor: Actor | null, row: Pick<WorkspaceRow, 'agent_id' | 'ref'>): string | null {
  if (!actor?.agent) return null;
  if (row.agent_id !== null && row.agent_id !== actor.agent.agentId) return 'workspace owned by another agent';
  return row.ref && credentialMayUpdateRef(actor, row.ref) ? null : 'workspace outside agent token grant';
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

interface CreateInput {
  task: string;
  agent: string;
  base: string;
  intent: Declaration | null;
  /** The issue the workspace is created to resolve; its change closes the issue on merge. */
  issue: number | null;
}

function parseCreate(cx: WorkspaceContext, input: unknown): ServiceResult<CreateInput> {
  const parsed = objectBody(input);
  if (!parsed.ok) return parsed;
  const b = parsed.value;
  const task = typeof b.task === 'string' ? b.task.trim() : '';
  if (task.length === 0 || task.length > WORKSPACE_LIMITS.taskMax) {
    return fail(422, `task is required (1-${WORKSPACE_LIMITS.taskMax} characters)`, 'INVALID_TASK');
  }
  let agent: string;
  if (b.agent === undefined || b.agent === null) {
    agent = cx.actor?.agent?.agentName ?? cx.actor?.user.login ?? 'unknown';
  } else if (typeof b.agent === 'string' && b.agent.trim().length > 0 && b.agent.trim().length <= WORKSPACE_LIMITS.agentMax) {
    agent = b.agent.trim();
  } else {
    return fail(422, `agent must be a string of 1-${WORKSPACE_LIMITS.agentMax} characters`, 'INVALID_AGENT');
  }
  const base = b.base === undefined || b.base === null ? cx.repo.default_branch : normalizeBranch(b.base);
  if (base === null) return fail(422, 'base must be a branch name', 'INVALID_REF');
  let intent: Declaration | null = null;
  if (b.intent !== undefined && b.intent !== null) {
    const d = normalizeDeclaration(b.intent);
    if (!d.ok) return fail(422, d.error, 'INVALID_INTENT');
    intent = d.value;
  }
  let issue: number | null = null;
  if (b.issue !== undefined && b.issue !== null) {
    if (typeof b.issue !== 'number' || !Number.isInteger(b.issue) || b.issue < 1) return fail(422, 'issue must be an issue number', 'INVALID_ISSUE');
    issue = b.issue;
  }
  return { ok: true, value: { task, agent, base, intent, issue } };
}

export interface WorkspaceSpec {
  id: string;
  ref: string;
  task: string;
  agent: string;
  base: string;
  baseSha: string;
  arenaId?: string | null;
  /**
   * The commit the ref was created at when it is not the base head (a
   * composition). Recorded so the view reports it before the ref's push event
   * reaches repo_refs.
   */
  headSha?: string | null;
}

/**
 * The INSERT for a new active workspace row. The observed set starts empty
 * at the base head; push reconciliation replaces it, also for a workspace
 * whose ref was created past the base (a composition).
 */
export function workspaceInsertStatement(
  cx: Pick<WorkspaceContext, 'env' | 'repo' | 'actor'>,
  w: WorkspaceSpec,
  now: number,
  intentJson: string | null = null,
  expiresAt: number | null = null,
  /** A condition the insert requires, with its parameters bound from ?17 on. */
  guard: { where: string; params: unknown[] } | null = null,
): D1PreparedStatement {
  const values = `?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12, ?13, ?14, '[]', ?8, ?8, ?11, ?15, ?16`;
  return cx.env.DB.prepare(
    `INSERT INTO workspaces (id, repo_id, artifacts_name, task, agent, status, ref, base_ref, base_sha, created_by, agent_id,
       created_at, updated_at, intent_paths, intent_updated_at, intent_expires_at,
       observed_paths, observed_base_sha, observed_head_sha, observed_at, arena_id, head_sha)
     ${guard ? `SELECT ${values} WHERE ${guard.where}` : `VALUES (${values})`}`,
  ).bind(
    w.id,
    cx.repo.id,
    cx.repo.artifacts_name,
    w.task,
    w.agent,
    w.ref,
    w.base,
    w.baseSha,
    cx.actor?.user.id ?? null,
    cx.actor?.agent?.agentId ?? null,
    now,
    intentJson,
    intentJson ? now : null,
    expiresAt,
    w.arenaId ?? null,
    w.headSha ?? null,
    ...(guard?.params ?? []),
  );
}

/** Rows (with views' joins) for the given workspace ids, in one statement. */
export function workspaceRowsStatement(db: D1Database, repoId: string, ids: readonly string[]): D1PreparedStatement {
  return db.prepare(`${WORKSPACE_SELECT} WHERE w.repo_id = ?1 AND w.id IN (SELECT value FROM json_each(?2))`).bind(repoId, JSON.stringify([...ids]));
}

/** An arena's workspaces in creation order. */
export function arenaWorkspacesStatement(db: D1Database, repoId: string, arenaId: string): D1PreparedStatement {
  return db.prepare(`${WORKSPACE_SELECT} WHERE w.repo_id = ?1 AND w.arena_id = ?2 ORDER BY w.created_at, w.rowid`).bind(repoId, arenaId);
}

/** The workspace ref for a new workspace id and its task. */
export function workspaceRef(id: string, task: string): string {
  return `${WORKSPACE_REF_PREFIX}${id}/${workspaceSlug(task)}`;
}

/**
 * POST workspaces. The ref is created at the base head before the row is
 * written (an orphan ref from a failed insert is harmless: no row, so no
 * agent can push to it), then one batch inserts and reads the row back.
 */
export function createWorkspace(
  cx: WorkspaceContext,
  input: unknown,
  deps: WorkspaceDeps = defaultWorkspaceDeps,
): Promise<ServiceResult<WorkspaceView>> {
  return guarded(async () => {
    const parsed = parseCreate(cx, input);
    if (!parsed.ok) return parsed;
    const p = parsed.value;
    const id = newId();
    const ref = workspaceRef(id, p.task);
    if (!isSafeRefName(ref)) return fail(422, 'task does not yield a valid ref name', 'INVALID_TASK');
    if (cx.actor?.agent && !credentialMayUpdateRef(cx.actor, ref)) {
      return fail(403, `this agent token may not create ${WORKSPACE_REF_PREFIX}<id>/ refs`, 'AGENT_REF_FORBIDDEN');
    }
    if (p.issue !== null && !(await openIssueExists(cx.env, cx.repo.id, p.issue))) {
      return fail(422, `no open issue #${p.issue}`, 'ISSUE_NOT_OPEN');
    }
    const baseRef = `refs/heads/${p.base}`;
    const baseSha = (await liveRefs(cx, [baseRef])).get(baseRef) ?? null;
    if (!baseSha) return fail(422, `base branch not found: ${p.base}`, 'REF_NOT_FOUND', { ref: p.base });

    const pushed = await deps.pusher(cx.env, cx.repo).updateRef({ ref, oldOid: ZERO_SHA, newOid: baseSha });
    let created = pushed.status === 'ok';
    if (pushed.status === 'unknown') created = (await liveRefs(cx, [ref])).get(ref) === baseSha;
    if (!created) {
      return fail(502, `the workspace ref could not be created (${pushed.status}${pushed.reason ? `: ${pushed.reason}` : ''})`, 'REF_CREATE_FAILED');
    }

    const now = Date.now();
    const intentJson = p.intent ? JSON.stringify(p.intent.paths) : null;
    const expiresAt = p.intent?.ttlSeconds ? now + p.intent.ttlSeconds * 1000 : null;
    const results = await cx.env.DB.batch([
      workspaceInsertStatement(cx, { id, ref, task: p.task, agent: p.agent, base: p.base, baseSha }, now, intentJson, expiresAt),
      ...(intentJson ? [declaredInsertStatement(cx.env.DB, cx.repo.id, id, intentJson)] : []),
      ...(p.issue !== null ? [workspaceIssueStatement(cx.env.DB, cx.repo.id, id, p.issue, actorName(cx.actor), now)] : []),
      cx.env.DB.prepare(`${WORKSPACE_SELECT} WHERE w.id = ?`).bind(id),
    ]);
    const read = results[results.length - 1];
    const row = (read?.results as WorkspaceRow[] | undefined)?.[0];
    if (!row) return fail(500, 'workspace could not be created', 'CREATE_FAILED');
    return { ok: true, value: workspaceView(row, cx.repo, cx.origin, baseSha) };
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** GET workspaces/:id. An active workspace's head is read live from the ref. */
export function getWorkspace(cx: WorkspaceContext, id: string): Promise<ServiceResult<WorkspaceView>> {
  return guarded(async () => {
    const row = ID_RE.test(id) ? await readRow(cx.env, cx.repo.id, id) : null;
    if (!row) return fail(404, 'workspace not found', 'WORKSPACE_NOT_FOUND');
    if (row.status !== 'active' || !row.ref) return { ok: true, value: workspaceView(row, cx.repo, cx.origin) };
    let head: string | null;
    try {
      head = (await liveRefs(cx, [row.ref])).get(row.ref) ?? null;
    } catch (err) {
      if (!(err instanceof RefStoreUnavailable)) throw err;
      head = recordedHead(row);
    }
    return { ok: true, value: workspaceView(row, cx.repo, cx.origin, head) };
  });
}

export interface WorkspacePage {
  workspaces: WorkspaceView[];
  nextCursor: string | null;
}

/**
 * GET workspaces: one indexed query, newest first. The head of an active
 * workspace in a list comes from push events (repo_refs) and may trail a
 * push by seconds; GET workspaces/:id reads it live.
 */
export async function listWorkspaces(
  env: Env,
  repo: RepoRow,
  origin: string,
  q: { status?: string; limit?: string; cursor?: string },
): Promise<ServiceResult<WorkspacePage>> {
  const status = q.status ?? 'all';
  if (status !== 'all' && !(WORKSPACE_STATUSES as readonly string[]).includes(status)) {
    return fail(400, `status must be one of ${[...WORKSPACE_STATUSES, 'all'].join(', ')}`, 'INVALID_STATUS');
  }
  const limit = q.limit === undefined ? WORKSPACE_LIMITS.pageDefault : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > WORKSPACE_LIMITS.pageMax) {
    return fail(400, `limit must be an integer 1-${WORKSPACE_LIMITS.pageMax}`, 'INVALID_LIMIT');
  }
  let cursor: { at: number; seq: number } | null = null;
  if (q.cursor !== undefined) {
    const m = /^(\d{1,15})\.(\d{1,15})$/.exec(q.cursor);
    if (!m) return fail(400, 'cursor is invalid', 'INVALID_CURSOR');
    cursor = { at: Number(m[1]), seq: Number(m[2]) };
  }
  const where = ['w.repo_id = ?'];
  const args: unknown[] = [repo.id];
  if (status !== 'all') {
    where.push('w.status = ?');
    args.push(status);
  }
  if (cursor) {
    where.push('(w.created_at < ? OR (w.created_at = ? AND w.rowid < ?))');
    args.push(cursor.at, cursor.at, cursor.seq);
  }
  const rows =
    (
      await env.DB.prepare(`${WORKSPACE_SELECT} WHERE ${where.join(' AND ')} ORDER BY w.created_at DESC, w.rowid DESC LIMIT ${limit + 1}`)
        .bind(...args)
        .all<WorkspaceRow>()
    ).results ?? [];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    ok: true,
    value: {
      workspaces: page.map((r) => workspaceView(r, repo, origin)),
      nextCursor: rows.length > limit && last ? `${last.created_at}.${last.seq}` : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Change set
// ---------------------------------------------------------------------------

/**
 * POST workspaces/:id/change-set {title, body?, base?, mergePolicy?}: opens
 * a change from the workspace branch into `base` (default: the repo's
 * default branch) with the policy as given (default `review`), through
 * services/changes.ts, and links it in one batch right after the change row
 * is written, before an `auto` change may merge. A concurrent second call
 * loses the link and its change is closed in that same batch, unpublished;
 * the merge's send-time check re-reads the workspace admission.
 */
export function openChangeSet(
  cx: WorkspaceContext,
  id: string,
  input: unknown,
  /** Told the internal id of the change once the workspace link is won. */
  onLinked?: (change: { id: string; number: number }) => void,
): Promise<ServiceResult<CreatedChangeDetail & { workspace: string }>> {
  return guarded(async () => {
    const parsed = objectBody(input);
    if (!parsed.ok) return parsed;
    const b = parsed.value;
    const row = ID_RE.test(id) ? await readRow(cx.env, cx.repo.id, id) : null;
    if (!row) return fail(404, 'workspace not found', 'WORKSPACE_NOT_FOUND');
    const denied = agentOwnershipDenial(cx.actor, row);
    if (denied) return fail(403, denied, 'WORKSPACE_NOT_OWNED');
    if (row.status !== 'active' || !row.ref) return fail(409, `the workspace is ${row.status}`, 'WORKSPACE_NOT_ACTIVE', { workspaceStatus: row.status });
    if (row.change_set_id) {
      return fail(409, `the workspace already has change set #${row.change_number}`, 'CHANGE_SET_EXISTS', { changeSet: row.change_number });
    }
    // The link is won before an `auto` change may publish; a change that loses it is closed unpublished.
    const admit = async (change: { id: string; number: number }) => {
      const now = Date.now();
      const [link] = await cx.env.DB.batch([
        cx.env.DB.prepare(
          `UPDATE workspaces SET change_set_id = ?3, updated_at = ?4
            WHERE repo_id = ?1 AND id = ?2 AND change_set_id IS NULL AND status = 'active'`,
        ).bind(cx.repo.id, row.id, change.id, now),
        cx.env.DB.prepare(
          `UPDATE change_sets SET state = 'closed', updated_at = ?4
            WHERE repo_id = ?1 AND id = ?3 AND state IN ('open', 'conflicted')
              AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.repo_id = ?1 AND w.id = ?2 AND w.change_set_id = change_sets.id)`,
        ).bind(cx.repo.id, row.id, change.id, now),
        retireClosedChangeTask(cx.env.DB, '?2', [change.id], now),
      ]);
      if (link?.meta.changes) {
        onLinked?.(change);
        return null;
      }
      return fail(409, 'the workspace got a change set or left active meanwhile; this change was closed', 'CHANGE_SET_EXISTS', {
        closedChange: change.number,
      });
    };
    const created = await createChange(
      { env: cx.env, repo: cx.repo, actor: cx.actor, branchRules: cx.branchRules ?? [], waitUntil: cx.waitUntil },
      {
        title: b.title,
        ...(b.body !== undefined ? { body: b.body } : {}),
        base: b.base ?? cx.repo.default_branch,
        head: row.ref,
        ...(b.mergePolicy !== undefined ? { mergePolicy: b.mergePolicy } : {}),
      },
      { admit },
    );
    if (!created.ok) return created;
    return { ok: true, value: { ...created.value, workspace: row.id } };
  });
}

// ---------------------------------------------------------------------------
// Abandon
// ---------------------------------------------------------------------------

/**
 * Retires the live (open or claimed) resolve-conflict task of the change
 * `changeIdExpr` names once that change is closed; a completed task is kept.
 * `changeIdExpr` is interpolated into the statement text, so callers pass a
 * SQL expression over parameters ?2... ('?2' for a bound id, or a subquery)
 * plus the matching `params` — never a bare change id.
 */
function retireClosedChangeTask(db: D1Database, changeIdExpr: string, params: unknown[], now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE agent_tasks SET status = 'obsolete', updated_at = ?1
        WHERE kind = '${RESOLVE_CONFLICT}' AND status IN ('open', 'claimed') AND change_set_id = ${changeIdExpr}
          AND EXISTS (SELECT 1 FROM change_sets c WHERE c.id = agent_tasks.change_set_id AND c.state = 'closed')`,
    )
    .bind(now, ...params);
}

/**
 * POST workspaces/:id/abandon. The row turns `abandoned` first (so the git
 * gate stops agent pushes to it) and an open linked change set is closed in
 * the same batch; then the ref is deleted with its current head as expected
 * old value. Repeating abandon retries a ref deletion that failed.
 */
export function abandonWorkspace(
  cx: WorkspaceContext,
  id: string,
  deps: WorkspaceDeps = defaultWorkspaceDeps,
): Promise<ServiceResult<WorkspaceView>> {
  return guarded(async () => {
    let row = ID_RE.test(id) ? await readRow(cx.env, cx.repo.id, id) : null;
    if (!row) return fail(404, 'workspace not found', 'WORKSPACE_NOT_FOUND');
    const denied = agentOwnershipDenial(cx.actor, row);
    if (denied) return fail(403, denied, 'WORKSPACE_NOT_OWNED');
    if (row.status === 'merged') return fail(409, 'a merged workspace cannot be abandoned', 'WORKSPACE_MERGED');
    const ref = row.ref;
    let head = ref ? ((await liveRefs(cx, [ref])).get(ref) ?? null) : null;

    if (row.status === 'active') {
      const now = Date.now();
      const [, , , , read] = await cx.env.DB.batch([
        cx.env.DB.prepare(
          `UPDATE workspaces SET status = 'abandoned', abandoned_at = ?3, updated_at = ?3, head_sha = COALESCE(?4, head_sha, base_sha)
            WHERE repo_id = ?1 AND id = ?2 AND status = 'active'`,
        ).bind(cx.repo.id, row.id, now, head),
        cx.env.DB.prepare(
          `UPDATE change_sets SET state = 'closed', updated_at = ?3
            WHERE repo_id = ?1 AND state IN ('open', 'conflicted')
              AND id = (SELECT w.change_set_id FROM workspaces w WHERE w.repo_id = ?1 AND w.id = ?2 AND w.status = 'abandoned')`,
        ).bind(cx.repo.id, row.id, now),
        retireClosedChangeTask(cx.env.DB, `(SELECT w.change_set_id FROM workspaces w WHERE w.repo_id = ?2 AND w.id = ?3 AND w.status = 'abandoned')`, [cx.repo.id, row.id], now),
        // The intent signal leaves the active index; the declaration and observed set stay on the row.
        workspaceSignalCleanup(cx.env.DB, cx.repo.id, row.id),
        cx.env.DB.prepare(`${WORKSPACE_SELECT} WHERE w.repo_id = ? AND w.id = ?`).bind(cx.repo.id, row.id),
      ]);
      row = (read?.results as WorkspaceRow[] | undefined)?.[0] ?? row;
      if (row.status === 'merged') return fail(409, 'a merged workspace cannot be abandoned', 'WORKSPACE_MERGED');
    }

    const pusher = deps.pusher(cx.env, cx.repo);
    for (let attempt = 0; ref && head && attempt < 2; attempt++) {
      const r = await pusher.updateRef({ ref, oldOid: head, newOid: ZERO_SHA });
      if (r.status === 'ok') {
        head = null;
        break;
      }
      // Someone moved (or deleted) the ref meanwhile: re-read and try once more.
      const now = (await liveRefs(cx, [ref])).get(ref) ?? null;
      if (r.status === 'unknown' && now === null) {
        head = null;
        break;
      }
      head = now;
    }
    if (ref && head) {
      return fail(503, 'the workspace is abandoned but its ref could not be deleted; repeat abandon to retry', 'REF_DELETE_FAILED', {
        ref,
      });
    }
    return { ok: true, value: workspaceView(row, cx.repo, cx.origin) };
  });
}

// ---------------------------------------------------------------------------
// Git gate binding and repo cleanup
// ---------------------------------------------------------------------------

export interface WorkspaceOwner {
  ref: string | null;
  status: WorkspaceStatus;
  agent_id: string | null;
}

/** One query for every workspace a push names; nothing when no command is in the namespace. */
export async function workspaceOwners(env: Env, repoId: string, commands: readonly RefCommand[]): Promise<Map<string, WorkspaceOwner>> {
  const stmt = workspaceOwnersSelect(env.DB, repoId, commands);
  if (!stmt) return new Map();
  return workspaceOwnersFrom((await stmt.all()).results);
}

/** The `workspaceOwners` query, for a caller's batch; null when no command is in the namespace. */
export function workspaceOwnersSelect(db: D1Database, repoId: string, commands: readonly RefCommand[]): D1PreparedStatement | null {
  const ids = [...new Set(commands.map((c) => workspaceIdOf(c.ref)).filter((x): x is string => x !== null))];
  if (ids.length === 0) return null;
  return db
    .prepare(`SELECT id, ref, status, agent_id FROM workspaces WHERE repo_id = ? AND id IN (SELECT value FROM json_each(?))`)
    .bind(repoId, JSON.stringify(ids));
}

export function workspaceOwnersFrom(results: unknown[] | undefined): Map<string, WorkspaceOwner> {
  return new Map(((results ?? []) as (WorkspaceOwner & { id: string })[]).map((r) => [r.id, r]));
}

/** The `ng` reason for an agent token's command on a workspace-namespace ref, or null when allowed. */
export function agentWorkspaceDenial(actor: Actor, cmd: RefCommand, owners: Map<string, WorkspaceOwner>): string | null {
  if (!actor.agent || !cmd.ref.startsWith(WORKSPACE_REF_PREFIX)) return null;
  const id = workspaceIdOf(cmd.ref);
  const ws = id ? owners.get(id) : undefined;
  if (!ws || !ws.ref) return 'no such workspace';
  if (ws.status !== 'active') return `workspace ${ws.status}`;
  const denied = agentOwnershipDenial(actor, ws);
  if (denied) return denied;
  if (cmd.ref === ws.ref && isZeroOid(cmd.newOid)) return 'abandon the workspace to delete its ref';
  return null;
}

/** Statements that remove a repo's workspaces and the sandboxes that reference them, for the repo DELETE batch (before its change sets). */
export function workspaceCleanupStatements(db: D1Database, repoId: string): D1PreparedStatement[] {
  return [
    repoSignalCleanup(db, repoId),
    repoShareCleanup(db, repoId),
    db.prepare('DELETE FROM workspace_dependencies WHERE repo_id = ?').bind(repoId),
    db.prepare('DELETE FROM sandboxes WHERE repo_id = ?').bind(repoId),
    db.prepare('DELETE FROM workspaces WHERE repo_id = ?').bind(repoId),
  ];
}
