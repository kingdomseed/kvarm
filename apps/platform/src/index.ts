import { Hono } from 'hono';
import { GIT_PATH_RE, handleGitRequest } from './routes/git';
import { authRoutes } from './routes/auth';
import { api, persistSessionCookies } from './routes/api';
import { getSessionInfo } from './auth/workos';
import { agentDocs } from './routes/agentDocs';
import { discoveryLinkHeader, notFoundMarkdown, prefersMarkdown } from './services/agentDiscovery';
import { layout } from './web/render';
import { html } from '@kvarm/ui';
import { sessionCsrf } from './routes/pageCsrf';
import { tenancyApi } from './routes/api/tenancy';
import { agentsApi } from './routes/api/agents';
import { branchRulesApi } from './routes/api/branchRules';
import { compareApi } from './routes/api/compare';
import { contentsApi } from './routes/api/contents';
import { eventsApi } from './routes/api/events';
import { historyApi } from './routes/api/history';
import { snapshotsApi } from './routes/api/snapshots';
import { changesApi } from './routes/api/changes';
import { reviewsApi } from './routes/api/reviews';
import { intentsApi } from './routes/api/intents';
import { candidatesApi } from './routes/api/candidates';
import { workspacesApi } from './routes/api/workspaces';
import { dependenciesApi } from './routes/api/dependencies';
import { attributionApi } from './routes/api/attribution';
import { issuesApi } from './routes/api/issues';
import { checksApi } from './routes/api/checks';
import { ciApi } from './routes/api/ci';
import { revertsApi } from './routes/api/reverts';
import { containerRunnerApi } from './routes/api/containerRunner';
import { fleetApi } from './routes/api/fleet';
import { webhooksApi } from './routes/api/webhooks';
import { handleEventBatch } from './services/events';
import { dispatchScheduled } from './scheduled';
import { handleMcp } from './mcp/server';
import { web } from './routes/web';
import { repoPages } from './routes/repoPages';
import { fleetPages, fleetRepoPages } from './routes/fleetPages';
import { issuePages } from './routes/issuePages';
import { coordinationPages } from './routes/coordinationPages';
import { comparePages } from './routes/comparePages';
import { changePages } from './routes/changePages';
import { inboxPages, reviewPages } from './routes/reviewPages';
import { installFetchMeter, serveMetered } from './cost/meter';
import { presentsCredential, withPrivateCacheControl } from './cache/scope';

export { TokenCache, RateLimiter, MergeLock, RepoEvents, PathHistory } from './do';
export { SnapshotBuilder, CiPipeline, MergeWorkflow, RepoImport } from './workflows';
export { EnvironmentBuild } from './workflows/environmentBuild';
export { CiRunnerSandbox } from './containers/ciRunnerSandbox';
export { EnvironmentBuilder } from './containers/environmentBuilder';
export { AgentSandbox } from './containers/agentSandbox';
export { SandboxEgress } from './containers/sandboxEgress';

installFetchMeter();

/**
 * Percent-decodes one path capture once. A malformed encoding stays as sent,
 * so it misses the repo lookup like any other unknown name. A decoded slash
 * or other invalid name character cannot match a stored name either.
 */
function decodePathComponent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const app = new Hono<{ Bindings: Env }>();

// Git smart HTTP gate. Mounted before every other route: paths like
// /{owner}/{repo}(.git)/info/refs are unambiguously git traffic; everything
// else falls through to web/API routes.
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const m = url.pathname.match(GIT_PATH_RE);
  if (m) {
    const [, owner, name, subpath] = m as unknown as [string, string, string, string];
    return handleGitRequest(c, decodePathComponent(owner), decodePathComponent(name), subpath);
  }
  return next();
});

app.get('/healthz', (c) => c.text('ok'));

// Static assets are served ahead of web routes (web's /:owner/:repo
// catch-all would otherwise swallow /assets/*).
app.use('/assets/*', async (c, next) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status !== 404) return res;
  return next();
});

// Refreshed or cleared session cookies reach every response, whichever
// route resolved the session (routes/api.ts requestSession).
app.use('*', persistSessionCookies);

// Every session form post carries its CSRF token (architecture §11.1). Ahead
// of every router, so a page route mounted anywhere later is covered; only
// routes/pageCsrf.ts csrfExempt paths skip it.
app.use('*', sessionCsrf);

// Every HTML page points agents at the discovery files (RFC 8288), so they
// learn about llms.txt and the API contract before parsing a page.
app.use('*', async (c, next) => {
  await next();
  if (c.res.headers.get('content-type')?.startsWith('text/html') && !c.res.headers.has('link')) {
    c.res.headers.set('link', discoveryLinkHeader());
  }
});

app.route('/', agentDocs);

app.route('/auth', authRoutes);
app.route('/api/v1', api);
app.route('/api/v1', tenancyApi);
app.route('/api/v1', agentsApi);
app.route('/api/v1', branchRulesApi);
app.route('/api/v1', compareApi);
app.route('/api/v1', contentsApi);
app.route('/api/v1', eventsApi);
app.route('/api/v1', historyApi);
app.route('/api/v1', snapshotsApi);
app.route('/api/v1', changesApi);
app.route('/api/v1', reviewsApi);
// Before workspacesApi: `workspaces/overlap` would otherwise match `workspaces/:id`.
app.route('/api/v1', intentsApi);
app.route('/api/v1', dependenciesApi);
app.route('/api/v1', workspacesApi);
app.route('/api/v1', candidatesApi);
app.route('/api/v1', attributionApi);
app.route('/api/v1', issuesApi);
app.route('/api/v1', checksApi);
app.route('/api/v1', ciApi);
app.route('/api/v1', revertsApi);
app.route('/api/v1', containerRunnerApi);
app.route('/api/v1', fleetApi);
app.route('/api/v1', webhooksApi);
// MCP tool calls are dispatched back through this router to their REST routes.
app.all('/mcp', (c) => handleMcp(c.req.raw, c.env, async (req) => app.fetch(req, c.env, c.executionCtx)));
app.route('/fleet', fleetPages);
app.route('/inbox', inboxPages);
app.route('/', web);
// Repo pages mount after the generic web routes: /new-repo, /import-repo and
// /settings/tokens are two-segment paths that must win over /:owner/:repo.
app.route('/:owner/:repo', fleetRepoPages);
// The issues, coordination and compare pages are further /:owner/:repo views;
// their paths (/issues, /activity, /train, /arenas, /candidates, /compare)
// collide with none of the pages above.
app.route('/:owner/:repo', issuePages);
app.route('/:owner/:repo', repoPages);
app.route('/:owner/:repo', coordinationPages);
app.route('/:owner/:repo', comparePages);
app.route('/:owner/:repo', changePages);
// Escalation resolution remains in reviewPages; change page and review posts live in changePages.
app.route('/:owner/:repo', reviewPages);

// Static assets (public/*) as the final fallback.
app.all('*', async (c) => {
  // sessionCsrf may already have read a form post's body; assets never need it.
  const req = c.req.raw.bodyUsed ? new Request(c.req.url, { method: c.req.method, headers: c.req.raw.headers }) : c.req.raw;
  const res = await c.env.ASSETS.fetch(req);
  if (res.status !== 404) return res;
  // A miss is a real 404: JSON under the API, a page for browsers, Markdown for agents.
  const path = new URL(c.req.url).pathname;
  if (path === '/api/v1' || path.startsWith('/api/v1/')) return c.json({ error: 'not found', code: 'NOT_FOUND' }, 404);
  const accept = c.req.header('accept') ?? '';
  if (accept.includes('text/html') && !prefersMarkdown(accept)) {
    // No refresh: a rotated session cookie could not reach this response.
    const { session } = await getSessionInfo(c.req.raw, c.env, { refresh: false });
    const body = html`<section class="panel"><div class="panel-head hud"><b>404 · Not found</b></div>
      <div class="k-panel-body"><p class="muted">Nothing is published at <code>${path}</code>.</p>
      <p><a class="btn btn-primary" href="/">Home</a> <a class="btn" href="/llms.txt">llms.txt</a></p></div></section>`;
    return new Response(layout(c.env, { title: 'Not found', userLogin: session?.user.login ?? null }, body), {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8', vary: 'Accept' },
    });
  }
  return new Response(notFoundMarkdown(c.env, path), {
    status: 404,
    headers: { 'content-type': 'text/markdown; charset=utf-8', vary: 'Accept' },
  });
});

/** Every mounted route, for the page CSRF coverage test (routes/pageCsrf.ts). */
export function platformRoutes(): ReadonlyArray<{ method: string; path: string; handler: unknown }> {
  return app.routes.map(({ method, path, handler }) => ({ method, path, handler }));
}

export function dispatchPlatformRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return serveMetered(request, env, ctx, async (req, e, cx) => {
    const response = await app.fetch(req, e, cx);
    return presentsCredential(req) ? withPrivateCacheControl(response) : response;
  });
}

export default {
  // Every response carries x-kvarm-cost (src/cost/meter.ts). Responses to a
  // presented credential are never shared-cacheable, on every transport.
  fetch: (request, env, ctx) =>
    dispatchPlatformRequest(request, env, ctx),
  // Artifacts push events, through the account-level event subscription
  // (services/events.ts).
  queue: (batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext) => handleEventBatch(batch, env),
  // One job per cron expression (cron.ts, scheduled.ts).
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    dispatchScheduled(controller.cron, env, ctx);
  },
} satisfies ExportedHandler<Env>;
