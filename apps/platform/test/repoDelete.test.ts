/**
 * Repo deletion: the DELETE batch is one D1 transaction whose end state must
 * hold no row still referencing a deleted parent (change review requests and
 * carried review files cascade off nothing, forks off nothing), and a repo
 * row whose Artifacts storage is already gone — the half-deleted leftover a
 * failed delete leaves — must purge cleanly and render a clear page.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { fakeArtifacts, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';
import { call } from './helpers/http';
import { seedRepo, seedRepoWithCommit, seedUser } from './helpers/seed';

const env = { ...(cfEnv as unknown as Env), ARTIFACTS: fakeArtifacts } as Env;
const OWNER = 'del-owner';
const FULL: Scope[] = ['read', 'write', 'api'];
const tok: Record<string, string> = {};
let ownerId = '';

beforeAll(async () => {
  ownerId = await seedUser(env, OWNER);
  tok.owner = (await mintPAT(env, ownerId, 'owner', FULL)).token;
  installFakeGitRemote();
});

afterAll(() => restoreFetch());

describe('repo deletion', () => {
  it('deletes a repo whose changes still carry review requests and files, storage already gone', async () => {
    const reviewer = await seedUser(env, 'del-reviewer');
    const { id, main } = await seedRepoWithCommit(env, 'harness', { owner: OWNER, visibility: 'private' });
    const changeSet = crypto.randomUUID();
    const review = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO change_sets (id, repo_id, number, title, base_ref, head_ref, head_sha, state, author_id, created_at)
         VALUES (?, ?, 1, 'Add a token-bucket rate limit', 'refs/heads/main', 'refs/heads/agents/ws1/atlas', ?, 'open', ?, ?)`,
      ).bind(changeSet, id, main, reviewer, now),
      env.DB.prepare(
        `INSERT INTO change_reviews (id, repo_id, change_set_id, head_sha, principal, user_id, user_login, verdict, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'del-reviewer', 'approve', ?, ?)`,
      ).bind(review, id, changeSet, main, `user:${reviewer}`, reviewer, now, now),
      env.DB.prepare('INSERT INTO change_review_files (review_id, path, old_hash, new_hash) VALUES (?, ?, ?, ?)').bind(
        review,
        'src/util.js',
        'f'.repeat(40),
        'e'.repeat(40),
      ),
      env.DB.prepare('INSERT INTO change_review_requests (change_set_id, principal, requested_by, requested_at) VALUES (?, ?, ?, ?)').bind(
        changeSet,
        `user:${reviewer}`,
        reviewer,
        now,
      ),
    ]);
    // Storage already removed, as it is for every leftover a failed delete left.
    await env.ARTIFACTS.delete(`${OWNER}--harness`);
    const del = await call(env, 'DELETE', `/api/v1/repos/${OWNER}/harness`, { token: tok.owner });
    expect(del.status).toBe(200);
    expect(await env.DB.prepare('SELECT id FROM repos WHERE id = ?').bind(id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM change_sets WHERE repo_id = ?').bind(id).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM change_reviews WHERE repo_id = ?').bind(id).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM change_review_files WHERE review_id = ?').bind(review).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM change_review_requests WHERE change_set_id = ?').bind(changeSet).first()).toEqual({ n: 0 });
  });

  it('deletes a repo that once had a stopped sandbox with its approvals and commands', async () => {
    const { id: repoId } = await seedRepoWithCommit(env, 'had-sandbox', { owner: OWNER, visibility: 'private' });
    const now = Date.now();
    const agentId = crypto.randomUUID();
    const environmentId = crypto.randomUUID();
    const buildId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const sandboxId = crypto.randomUUID();
    const approvalId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agents (id, owner_kind, owner_id, owner_login, name, created_by, created_at) VALUES (?, 'user', ?, ?, 'bot', ?, ?)`,
      ).bind(agentId, ownerId, OWNER, ownerId, now),
      env.DB.prepare(
        `INSERT INTO environments (id, repo_id, name, os, base_ref, instance, allowed_hosts, command_policy, config_hash,
           ready_build_id, created_by, created_at, updated_at)
         VALUES (?, ?, 'env', 'linux', 'main', 'standard-1', '[]', '{"deny":[],"approve":[]}', 'config', ?, ?, ?, ?)`,
      ).bind(environmentId, repoId, buildId, ownerId, now, now),
      env.DB.prepare(
        `INSERT INTO environment_builds (id, environment_id, repo_id, seq, status, reason, config_hash, snapshot_id, phases, output_tail, created_at, finished_at)
         VALUES (?, ?, ?, 1, 'ready', 'create', 'config', 'snap', '{}', '', ?, ?)`,
      ).bind(buildId, environmentId, repoId, now, now),
      env.DB.prepare(
        `INSERT INTO workspaces (id, repo_id, artifacts_name, task, agent, status, created_at, ref, created_by, agent_id)
         VALUES (?, ?, ?, 'task', 'agent', 'active', ?, ?, ?, ?)`,
      ).bind(workspaceId, repoId, `${OWNER}--had-sandbox`, now, `refs/heads/agents/${workspaceId}/x`, ownerId, agentId),
      env.DB.prepare(
        `INSERT INTO sandboxes (id, repo_id, environment_id, build_id, workspace_id, owner_user_id, agent_id, token_id, status,
           task, last_active_at, expires_at, run_expires_at, sleep_snapshot_id, created_at, stopped_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'stopped', 'task', ?, ?, ?, NULL, ?, ?)`,
      ).bind(sandboxId, repoId, environmentId, buildId, workspaceId, ownerId, agentId, now, now + 86400_000, now + 86400_000, now, now),
      env.DB.prepare(
        `INSERT INTO sandbox_approvals (id, sandbox_id, repo_id, command, requested_by, status, created_at, expires_at)
         VALUES (?, ?, ?, 'npm install', ?, 'used', ?, ?)`,
      ).bind(approvalId, sandboxId, repoId, ownerId, now, now + 3600_000),
      env.DB.prepare(
        `INSERT INTO sandbox_commands (id, sandbox_id, actor, command, exit_code, duration_ms, policy, approval_id, created_at)
         VALUES (?, ?, ?, 'npm install', 0, 10, 'approved', ?, ?)`,
      ).bind(commandId, sandboxId, `user:${ownerId}`, approvalId, now),
    ]);

    const del = await call(env, 'DELETE', `/api/v1/repos/${OWNER}/had-sandbox`, { token: tok.owner });

    const count = async (table: string, id: string) =>
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`).bind(id).first<{ n: number }>())!.n;
    expect({
      status: del.status,
      body: del.text,
      repos: await count('repos', repoId),
      workspaces: await count('workspaces', workspaceId),
      sandboxes: await count('sandboxes', sandboxId),
      approvals: await count('sandbox_approvals', approvalId),
      commands: await count('sandbox_commands', commandId),
    }).toEqual({ status: 200, body: '{"deleted":true}', repos: 0, workspaces: 0, sandboxes: 0, approvals: 0, commands: 0 });
  });

  it('deleting a forked parent detaches the forks instead of failing whole', async () => {
    const { id } = await seedRepoWithCommit(env, 'parent', { owner: OWNER, visibility: 'private' });
    const { id: forkId } = await seedRepo(env, 'child-fork', { owner: OWNER, visibility: 'private' });
    await env.DB.prepare('UPDATE repos SET fork_parent_id = ? WHERE id = ?').bind(id, forkId).run();
    const del = await call(env, 'DELETE', `/api/v1/repos/${OWNER}/parent`, { token: tok.owner });
    expect(del.status).toBe(200);
    expect(await env.DB.prepare('SELECT id FROM repos WHERE id = ?').bind(id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT fork_parent_id FROM repos WHERE id = ?').bind(forkId).first()).toEqual({ fork_parent_id: null });
  });
});

describe('a repo whose storage is gone', () => {
  it('renders a clear page, not a 500', async () => {
    const { id } = await seedRepoWithCommit(env, 'gone', { owner: OWNER, visibility: 'public' });
    await env.DB.prepare('UPDATE repos SET created_at = created_at - 3600000 WHERE id = ?').bind(id).run();
    await env.ARTIFACTS.delete(`${OWNER}--gone`);
    const res = await call(env, 'GET', `/${OWNER}/gone`);
    expect(res.status).toBe(410);
    expect(res.text).toContain('no longer available');
  });

  it('still shows the warming page while a fresh row could be an import settling', async () => {
    await seedRepoWithCommit(env, 'warming', { owner: OWNER, visibility: 'public' });
    await env.ARTIFACTS.delete(`${OWNER}--warming`);
    const res = await call(env, 'GET', `/${OWNER}/warming`);
    expect(res.status).toBe(202);
    expect(res.text).toContain('still being imported');
  });
});
