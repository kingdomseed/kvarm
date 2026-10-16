/**
 * Repo web pages: tree browser, file view, raw files, commit history, commit
 * detail, branch list, settings. SSR HTML, zero client JS except the copy
 * button. Public anonymous views are edge-cached; mutable-ref keys carry the
 * repo view generation that a confirmed push moves.
 *
 * Speed choices baked in:
 *  - No last-commit-message per tree row (that needs a history walk per path,
 *    which is the slowest part of GitHub's file browser). Rows are O(entries).
 *  - Huge files render in line windows instead of one giant DOM.
 *  - README HTML is cached content-addressed by blob SHA: render once ever.
 *
 * Escaping convention: user data is interpolated bare into html`` (escaped
 * once); composed fragments and pre-encoded URLs go through raw(). Never
 * pre-escape a value that html`` will interpolate.
 */

import { Hono, type Context } from 'hono';
import { escapeHtml, formatBytes, highlightLines, html, raw, timeAgo } from '@kvarm/ui';
import type { RepoRow } from '../db/repos';
import { clientIp, requestCredential, requestSession, type ApiActor, type App } from './api';
import { csrfTokenValid } from '../auth/workos';
import { csrfInput, layout } from '../web/render';
import { CSRF_REFUSED } from './pageCsrf';
import { repoPage } from '../render/repoShell';
import {
  commitAt,
  isCommitRef,
  listRefs,
  readFileAt,
  readCommit,
  readTreeAtPath,
  README_CANDIDATES,
  withLazyRepo,
} from '../artifacts/repo';
import { renderMarkdown } from '../render/markdown';
import { edgeCachedPage } from '../cache/edge';
import { readFileImmutable } from '../cache/content';
import { PRIVATE_CACHE_CONTROL } from '../cache/scope';
import * as svc from '../repos/service';
import type { RepoNeed, RepoRole } from '../services/authz';
import { resolveRepoAccess } from '../services/access';
import { repoViewGeneration } from '../services/pushFreshness';
import { readCommitInfo } from '../services/refs';
import { commitProvenance } from '../services/provenancePanel';
import { provenancePanel } from '../render/provenance';

export const repoPages = new Hono<App>();

const MAX_RENDER_LINES = 1500;
const WINDOW_LINES = 1000;

interface Resolved {
  repo: RepoRow;
  viewer: ApiActor | null;
  role: RepoRole;
}

/** Pass-through kept for call sites; session cookies are persisted by persistSessionCookies (routes/api.ts). */
function finish(_c: Context<App>, res: Response): Response {
  return res;
}

/** Percent-encode each path segment, keeping the slashes. */
function encodePath(path: string): string {
  return path
    .split('/')
    .filter((p) => p.length > 0)
    .map((p) => encodeURIComponent(p))
    .join('/');
}

/**
 * Owner/name -> repo row + permission check. 404 when invisible. A rejected
 * Bearer token on a page is treated as an anonymous view.
 */
async function resolveRepo(c: Context<App>, need: RepoNeed = 'read'): Promise<Resolved | null> {
  const owner = c.req.param('owner');
  const name = c.req.param('repo');
  if (!owner || !name) return null;
  const access = await resolveRepoAccess(c.env, {
    owner,
    name,
    need,
    transport: 'page',
    credential: await requestCredential(c),
    clientIp: clientIp(c),
    rejectedCredentialAsAnonymous: true,
  });
  if (!access.ok) return null;
  return { repo: access.repo, viewer: access.actor, role: access.role };
}

/** The resolve/finish/not-found helpers, shared by the coordination and compare page routers. */
export { finish, notFound, resolveRepo };
export type { Resolved };

/** Settings pages are concealed from viewers without admin on the repo. */
function canAdminister(resolved: Resolved): resolved is Resolved & { viewer: ApiActor } {
  return resolved.viewer !== null && resolved.role === 'admin';
}

/** Segments after /{owner}/{repo}/{marker}/..., with ref and path decoded. */
function refAndRest(c: Context<App>, marker: string): { ref: string; rest: string } | null {
  const segs = new URL(c.req.url).pathname.split('/').filter(Boolean);
  // [owner, repo, marker, ref, ...rest]
  if (segs.length < 4 || segs[2] !== marker) return null;
  try {
    const ref = decodeURIComponent(segs[3]!);
    const rest = segs.slice(4).map((s) => decodeURIComponent(s)).join('/');
    return { ref, rest };
  } catch {
    return null; // malformed percent-encoding
  }
}

function notFound(_c: Context<App>): Response {
  return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

/** Artifacts can 404 while an import is still warming up. */
function warmingPage(c: Context<App>, repo: RepoRow, viewerLogin: string | null): Response {
  return finish(
    c,
    new Response(
      layout(
        c.env,
        { title: `${repo.owner_login}/${repo.name}`, userLogin: viewerLogin },
        `<div class="card"><p>This repository is still being imported upstream.</p>
         <p class="muted">Content will appear here once the import completes.</p></div>`,
      ),
      { status: 202, headers: { 'content-type': 'text/html; charset=utf-8', refresh: '10' } },
    ),
  );
}

function isWarming(err: unknown): boolean {
  return /NOT_FOUND|not exist|not ready|importing/i.test(String(err));
}

/** How long a young row may read as an import still settling: its Artifacts
 * handle can 404 briefly after the import call returns. */
const IMPORT_SETTLING_MS = 10 * 60 * 1000;

/** True when the read failed because the repo's Artifacts storage is gone. */
function isStorageMissing(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'NOT_FOUND' || /not found|no such|does not exist/i.test(String(err));
}

/** A content read failed: warming keeps waiting, a row that outlived its
 * storage says so instead of 500ing (the leftover a failed delete leaves),
 * anything else rethrows. */
function storageReadFailed(c: Context<App>, repo: RepoRow, viewerLogin: string | null, err: unknown): Response {
  if (isWarming(err)) return warmingPage(c, repo, viewerLogin);
  if (isStorageMissing(err)) {
    if (Date.now() - repo.created_at < IMPORT_SETTLING_MS) return warmingPage(c, repo, viewerLogin);
    console.log(JSON.stringify({ repoStorageMissing: `${repo.owner_login}/${repo.name}`, id: repo.id, error: String(err).slice(0, 120) }));
    return finish(
      c,
      new Response(
        layout(
          c.env,
          { title: `${repo.owner_login}/${repo.name}`, userLogin: viewerLogin },
          `<div class="card"><p>This repository's content is no longer available.</p>
           <p class="muted">Its git storage was removed while its registry entry remained behind. An owner can delete the repository from its settings page.</p></div>`,
        ),
        { status: 410, headers: { 'content-type': 'text/html; charset=utf-8' } },
      ),
    );
  }
  throw err;
}

/** Anonymous public view cache; mutable refs are keyed by the repo view generation. */
async function cachedView(
  c: Context<App>,
  resolved: Resolved,
  ref: string,
  render: () => Promise<Response>,
): Promise<Response> {
  if (isCommitRef(ref)) {
    // Pinned views hold year-long colo entries, so their keys must be bounded:
    // a query string makes one per variant (and on the repo home it even
    // selects the content via ?ref=). Queried requests render uncached.
    if (new URL(c.req.url).search === '') return edgeCachedPage(c, 31536000, null, render);
    return render();
  }
  return edgeCachedPage(c, 60, await repoViewGeneration(resolved.repo), render);
}

async function defaultRef(c: Context<App>, repo: RepoRow): Promise<string> {
  const q = c.req.query('ref');
  if (q) return q;
  return repo.default_branch || 'main';
}

// ---------------------------------------------------------------------------
// Repo home + tree
// ---------------------------------------------------------------------------

async function renderTreeView(
  c: Context<App>,
  resolved: Resolved,
  ref: string,
  path: string,
  viewerLogin: string | null,
): Promise<Response> {
  let tree: {
    entries: ArtifactsTreeEntry[];
    rootTreeHash: string;
    commit: ArtifactsCommitMetadata;
  } | null;
  try {
    tree = await readTreeAtPath(c.env, resolved.repo.artifacts_name, ref, path);
  } catch (err) {
    return storageReadFailed(c, resolved.repo, viewerLogin, err);
  }
  if (!tree) return notFound(c);

  const headInfo = await withLazyRepo(c.env, resolved.repo.artifacts_name, (artifacts) =>
    readCommitInfo(
      {
        env: c.env,
        repo: resolved.repo,
        artifacts,
        bypass: false,
        waitUntil: (p) => c.executionCtx.waitUntil(p),
      },
      tree.commit.hash,
    ).catch(() => null),
  );
  const refs = await listRefs(c.env, resolved.repo).catch(() => null);
  const sorted = [...tree.entries].sort((a, b) => {
    const aDir = a.mode === '40000' ? 0 : 1;
    const bDir = b.mode === '40000' ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name < b.name ? -1 : 1;
  });

  const base = `/${resolved.repo.owner_login}/${resolved.repo.name}`;
  const encRef = encodeURIComponent(ref);
  const dirPrefix = path ? `${encodePath(path)}/` : '';
  const rows = sorted
    .map((e) => {
      const isDir = e.mode === '40000' || e.type === 'tree';
      const kind = isDir ? 'directory' : e.mode === '160000' ? 'submodule' : 'file';
      const href = `${base}/${isDir ? 'tree' : 'blob'}/${encRef}/${dirPrefix}${encodeURIComponent(e.name)}`;
      const icon = isDir
        ? '<svg aria-hidden="true" viewBox="0 0 16 16"><path d="M1.5 4.5h5l1.5 1.5h6.5v7.5h-13z"/><path d="M1.5 4.5v-1h5l1.5 1.5"/></svg>'
        : '<svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3 1.5h7l3 3v10H3z"/><path d="M10 1.5v3h3M5 8h6M5 10.5h6M5 13h4"/></svg>';
      return html`<tr>
        <td class="repo-file-name"><a href="${raw(href)}"><span class="repo-file-icon ${isDir ? 'directory' : 'file'}">${raw(icon)}</span><span>${e.name}</span></a></td>
        <td class="repo-file-type hud">${kind}</td>
      </tr>`;
    })
    .join('');

  const upHref = path
    ? `${base}/tree/${encRef}${path.includes('/') ? `/${encodePath(path.split('/').slice(0, -1).join('/'))}` : ''}`
    : '';
  const upRow = upHref
    ? html`<tr class="repo-file-up"><td colspan="2"><a href="${raw(upHref)}"><span class="repo-file-icon directory" aria-hidden="true">↑</span>..</a></td></tr>`
    : '';

  // README below the tree, rendered once per blob content and cached by SHA.
  let readmeHtml = '';
  for (const candidate of README_CANDIDATES) {
    const entry = sorted.find((e) => e.name.toLowerCase() === candidate.toLowerCase());
    if (!entry) continue;
    const cache = caches.default;
    // Versioned like every derived-output cache key (cache/compare.ts), so a
    // renderer change advances the segment instead of serving year-old HTML.
    const mdKey = new Request(`https://kvarm.internal/md/v1/${entry.hash}`, { method: 'GET' });
    let rendered = await cache.match(mdKey);
    if (!rendered) {
      // Read at the commit the tree was read from, never the moving ref: the
      // key names this entry's blob, and a push landing between the two reads
      // would otherwise cache the new README under the old blob's hash.
      const blob = await readFileAt(
        c.env,
        resolved.repo.artifacts_name,
        tree.commit.hash,
        path ? `${path}/${entry.name}` : entry.name,
      );
      if (!blob) continue;
      const text = await blob.text();
      rendered = new Response(renderMarkdown(text), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=31536000, immutable',
        },
      });
      c.executionCtx.waitUntil(cache.put(mdKey, rendered.clone()).catch(() => undefined));
    }
    readmeHtml = html`
      <section class="card readme-doc">
        <div class="readme-head hud ident">${entry.name}</div>
        <article class="md readme-body">${raw(await rendered.text())}</article>
      </section>
    `;
    break;
  }

  const subject = tree.commit.message.split('\n', 1)[0] ?? '';
  const author = tree.commit.author.name || tree.commit.committer.name;
  const branchCount = refs?.branches.length;
  const commitHref = `${base}/commit/${headInfo?.sha ?? tree.commit.hash}`;
  const body = html`
    <div class="repo-overview">
      <main class="repo-overview-main">
        <section class="card repo-files-panel">
          <div class="repo-head-commit">
            <span class="repo-head-author">${author}</span>
            <a class="repo-head-subject" href="${raw(commitHref)}">${subject}</a>
            <a class="repo-head-sha mono" href="${raw(commitHref)}">${(headInfo?.sha ?? tree.commit.hash).slice(0, 7)}</a>
            <span class="repo-head-meta hud">${timeAgo(tree.commit.authoredAt * 1000)}</span>
            <a class="repo-head-history hud" href="${raw(`${base}/commits?ref=${encRef}`)}">History</a>
          </div>
          <div class="repo-file-scroll">
            <table class="repo-file-table"><tbody>
              ${raw(upRow)}
              ${raw(rows || '<tr><td colspan="2" class="muted">empty directory</td></tr>')}
            </tbody></table>
          </div>
        </section>
        ${raw(readmeHtml)}
      </main>
      <aside class="repo-overview-side">
        <section class="card repo-about">
          <h2>About</h2>
          ${resolved.repo.description ? raw(html`<p>${resolved.repo.description}</p>`) : raw('<p class="muted">No description.</p>')}
          <dl class="repo-facts">
            <div><dt class="hud">Default branch</dt><dd><code>${resolved.repo.default_branch || 'main'}</code></dd></div>
            <div><dt class="hud">Branches</dt><dd>${branchCount === undefined ? 'Unavailable' : raw(html`<a href="${raw(`${base}/branches`)}">${branchCount}</a>`)}</dd></div>
            <div><dt class="hud">Visibility</dt><dd>${resolved.repo.visibility}</dd></div>
            <div><dt class="hud">Entries here</dt><dd>${sorted.length}</dd></div>
          </dl>
        </section>
      </aside>
    </div>
  `;

  const page = repoPage(
    c.env,
    { repo: resolved.repo, ref, path, tab: 'code', branches: refs?.branches },
    viewerLogin,
    body,
    c.req.url,
  );
  return finish(
    c,
    new Response(page, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  );
}

repoPages.get('/', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  const ref = await defaultRef(c, resolved.repo);
  const cacheable =
    resolved.repo.visibility === 'public' &&
    !c.req.header('cookie')?.includes('wos-session');
  if (cacheable) {
    const render = () => renderTreeView(c, resolved, ref, '', null);
    return cachedView(c, resolved, ref, render);
  }
  const viewerLogin = resolved.viewer?.user.login ?? null;
  return renderTreeView(c, resolved, ref, '', viewerLogin);
});

repoPages.get('/tree/:ref{.+}', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  const parsed = refAndRest(c, 'tree');
  if (!parsed) return notFound(c);
  const cacheable =
    resolved.repo.visibility === 'public' &&
    !c.req.header('cookie')?.includes('wos-session');
  if (cacheable) {
    const render = () => renderTreeView(c, resolved, parsed.ref, parsed.rest, null);
    return cachedView(c, resolved, parsed.ref, render);
  }
  const viewerLogin = resolved.viewer?.user.login ?? null;
  return renderTreeView(c, resolved, parsed.ref, parsed.rest, viewerLogin);
});

// ---------------------------------------------------------------------------
// Blob + raw
// ---------------------------------------------------------------------------

async function renderBlob(
  c: Context<App>,
  resolved: Resolved,
  ref: string,
  path: string,
  viewerLogin: string | null,
  contentCache: boolean,
): Promise<Response> {
  let blob: Blob | null;
  try {
    blob = contentCache
      ? await readFileImmutable(c.env, c.executionCtx, resolved.repo, ref, path)
      : await readFileAt(c.env, resolved.repo.artifacts_name, ref, path);
  } catch (err) {
    return storageReadFailed(c, resolved.repo, viewerLogin, err);
  }
  if (!blob) return notFound(c);

  const name = path.split('/').pop() ?? '';
  const isImage = blob.type.startsWith('image/');
  const isMarkdown = /\.(md|markdown|mdx)$/i.test(name);
  const rawBase = `/${resolved.repo.owner_login}/${resolved.repo.name}/raw/${encodeURIComponent(ref)}/${encodePath(path)}`;
  const headers = { 'content-type': 'text/html; charset=utf-8' };
  const fileHeader = (size: number) => html`
    <div class="blob-head">
      <code class="blob-path">${path}</code>
      <span class="hud">${formatBytes(size)}</span>
      <a class="btn" href="${raw(rawBase)}">Raw</a>
    </div>
  `;

  if (isImage) {
    const body = html`<section class="card blob-card">${raw(fileHeader(blob.size))}<img src="${rawBase}" alt="${name}" style="max-width:100%"></section>`;
    return finish(
      c,
      new Response(
        repoPage(c.env, { repo: resolved.repo, ref, path, tab: 'code' }, viewerLogin, body, c.req.url),
        { status: 200, headers },
      ),
    );
  }

  const buf = new Uint8Array(await blob.arrayBuffer());
  const binary = buf.slice(0, 8000).includes(0);
  if (binary) {
    const body = html`
      <div class="card blob-card">
        ${raw(fileHeader(buf.length))}
        <p>This file is binary (${formatBytes(buf.length)}).</p>
      </div>
    `;
    return finish(
      c,
      new Response(
        repoPage(c.env, { repo: resolved.repo, ref, path, tab: 'code' }, viewerLogin, body, c.req.url),
        { status: 200, headers },
      ),
    );
  }

  const text = new TextDecoder().decode(buf);
  const totalLines = text.length === 0 ? 1 : text.split('\n').length;
  const fromParam = Number(c.req.query('from') ?? 1);
  const from = Math.max(1, Math.min(totalLines, Number.isFinite(fromParam) ? fromParam : 1));
  const needsWindow = totalLines > MAX_RENDER_LINES;
  const to = needsWindow ? Math.min(totalLines, from + WINDOW_LINES - 1) : totalLines;
  const lines = needsWindow ? text.split('\n').slice(from - 1, to) : text.split('\n');

  let contentHtml: string;
  if (isMarkdown && !needsWindow) {
    contentHtml = renderMarkdown(text);
  } else {
    // One HTML string per line: token spans from the language highlighter,
    // everything escaped. A window highlights only its slice, so a block
    // comment opened before the window renders plain — the honest price of
    // the line budget. `path` names the file, so the language follows the
    // extension; over-budget text degrades to escaped plain lines inside.
    const lineHtml = highlightLines(path, lines.join('\n'));
    const rows = lineHtml
      .map((line, i) => {
        const no = from + i;
        return `<div class="code-row" id="L${no}"><span class="ln">${no}</span><span class="code-line">${line}</span></div>`;
      })
      .join('');
    contentHtml = `<div class="codeview">${rows}</div>`;
  }

  const pagerHtml = needsWindow
    ? html`
        <div class="pager">
          ${from > 1 ? raw(`<a class="btn" href="?from=${Math.max(1, from - WINDOW_LINES)}">Previous</a>`) : ''}
          <span class="muted">lines ${from}–${to} of ${totalLines}</span>
          ${to < totalLines ? raw(`<a class="btn" href="?from=${to + 1}">Next</a>`) : ''}
        </div>
      `
    : '';

  const body = html`
    <div class="card blob-card">
      ${raw(fileHeader(buf.length))}
      ${raw(pagerHtml)}
      ${raw(contentHtml)}
    </div>
  `;
  return finish(
    c,
    new Response(
      repoPage(c.env, { repo: resolved.repo, ref, path, tab: 'code' }, viewerLogin, body, c.req.url),
      { status: 200, headers },
    ),
  );
}

repoPages.get('/blob/:ref{.+}', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  const parsed = refAndRest(c, 'blob');
  if (!parsed) return notFound(c);
  const cacheable =
    resolved.repo.visibility === 'public' &&
    !c.req.header('cookie')?.includes('wos-session');
  if (cacheable) {
    const render = () => renderBlob(c, resolved, parsed.ref, parsed.rest, null, false);
    return cachedView(c, resolved, parsed.ref, render);
  }
  const viewerLogin = resolved.viewer?.user.login ?? null;
  return renderBlob(c, resolved, parsed.ref, parsed.rest, viewerLogin, true);
});

repoPages.get('/raw/:ref{.+}', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  const parsed = refAndRest(c, 'raw');
  if (!parsed) return notFound(c);
  const cacheable =
    resolved.repo.visibility === 'public' &&
    !c.req.header('cookie')?.includes('wos-session');
  const shared = resolved.repo.visibility === 'public' && resolved.viewer === null;
  const render = async (): Promise<Response> => {
    try {
      const blob = cacheable
        ? await readFileAt(c.env, resolved.repo.artifacts_name, parsed.ref, parsed.rest)
        : await readFileImmutable(c.env, c.executionCtx, resolved.repo, parsed.ref, parsed.rest);
      if (!blob) return notFound(c);
      const headers = new Headers();
      headers.set('content-type', blob.type || 'application/octet-stream');
      if (!shared) {
        headers.set('cache-control', PRIVATE_CACHE_CONTROL);
      } else if (isCommitRef(parsed.ref)) {
        headers.set('cache-control', 'public, max-age=31536000, immutable');
      } else {
        headers.set('cache-control', 'public, max-age=60');
      }
      return finish(c, new Response(blob, { headers }));
    } catch (err) {
      return storageReadFailed(c, resolved.repo, null, err);
    }
  };
  if (cacheable) return cachedView(c, resolved, parsed.ref, render);
  return render();
});

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

repoPages.get('/commits', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  const ref = await defaultRef(c, resolved.repo);
  const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
  const LIMIT = 30;
  let commits: ArtifactsCommitMetadata[];
  try {
    commits = await commitAt(c.env, resolved.repo.artifacts_name, ref, LIMIT, (page - 1) * LIMIT);
  } catch (err) {
    return storageReadFailed(c, resolved.repo, resolved.viewer?.user.login ?? null, err);
  }
  const base = `/${resolved.repo.owner_login}/${resolved.repo.name}`;
  const rows = commits
    .map((cm) => {
      const title = cm.message.split('\n')[0] ?? '';
      return html`
        <div class="commit-row">
          <div>
            <a href="${base}/commit/${cm.hash}"><strong>${title}</strong></a>
            <div class="muted">${cm.author.name} committed ${timeAgo(cm.committedAt * 1000)}</div>
          </div>
          <code>${cm.hash.slice(0, 10)}</code>
        </div>
      `;
    })
    .join('');
  const viewerLogin = resolved.viewer?.user.login ?? null;
  const body = html`
    <div class="card">
      <div class="card-title">Commits on <code>${ref}</code></div>
      ${raw(rows || '<p class="muted">no commits yet</p>')}
      <div class="pager">
        ${page > 1 ? raw(`<a class="btn" href="?ref=${encodeURIComponent(ref)}&page=${page - 1}">Newer</a>`) : ''}
        ${commits.length === LIMIT ? raw(`<a class="btn" href="?ref=${encodeURIComponent(ref)}&page=${page + 1}">Older</a>`) : ''}
      </div>
    </div>
  `;
  return finish(
    c,
    new Response(
      repoPage(c.env, { repo: resolved.repo, ref, tab: 'commits' }, viewerLogin, body, c.req.url),
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    ),
  );
});

repoPages.get('/commit/:sha', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  const sha = c.req.param('sha');
  // Provenance and decisions (issue #8): a full SHA lets the D1 read overlap the Artifacts one.
  const admin = resolved.role === 'admin';
  const early = /^[0-9a-f]{40}$/.test(sha) ? commitProvenance(c.env, resolved.repo, sha, { admin }) : null;
  // Paths that return before awaiting it (404, warming) must not leave a rejection unhandled.
  early?.catch(() => undefined);
  let commit: ArtifactsCommitMetadata | null;
  try {
    commit = await readCommit(c.env, resolved.repo.artifacts_name, sha);
  } catch (err) {
    return storageReadFailed(c, resolved.repo, resolved.viewer?.user.login ?? null, err);
  }
  if (!commit) return notFound(c);
  const viewerLogin = resolved.viewer?.user.login ?? null;
  const base = `/${resolved.repo.owner_login}/${resolved.repo.name}`;
  // The panel renders nothing when the commit has neither attribution nor decisions.
  // An optional panel: a failed read leaves the commit page as it was rather than failing it.
  const panel = provenancePanel(
    (await (early ?? commitProvenance(c.env, resolved.repo, commit.hash, { admin })).catch(() => null)) ?? { attribution: null, decisions: [], decisionsTruncated: false },
  );
  const body = html`
    <div class="card">
      <div class="card-title">
        <strong>${commit.message.split('\n')[0] ?? ''}</strong>
      </div>
      <p class="muted">
        ${commit.author.name} &lt;${commit.author.email}&gt;
        committed ${timeAgo(commit.committedAt * 1000)}
      </p>
      <pre><code>${commit.message}</code></pre>
      <p>
        commit <code>${commit.hash}</code> ·
        tree <code>${commit.treeHash.slice(0, 10)}</code>
        ${commit.parents.map((p) => raw(html` · parent <a href="${base}/commit/${p}"><code>${p.slice(0, 10)}</code></a>`))}
      </p>
      <p><a class="btn" href="${base}/tree/${commit.hash}">Browse tree at this commit</a></p>
    </div>
    ${raw(panel)}
  `;
  return finish(
    c,
    new Response(
      repoPage(
        c.env,
        {
          repo: resolved.repo,
          ref: commit.hash.slice(0, 10),
          tab: 'commits',
          title: commit.message.split('\n')[0] ?? '',
          // The panel is drawn from the brand tokens (docs/brand.md), which this older shell does not load.
        },
        viewerLogin,
        body,
        c.req.url,
      ),
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    ),
  );
});

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

repoPages.get('/branches', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  let refs: Awaited<ReturnType<typeof listRefs>>;
  try {
    refs = await listRefs(c.env, resolved.repo);
  } catch (err) {
    return storageReadFailed(c, resolved.repo, resolved.viewer?.user.login ?? null, err);
  }
  const base = `/${resolved.repo.owner_login}/${resolved.repo.name}`;
  const defaultRef = resolved.repo.default_branch || 'main';
  const rows = refs.branches
    .map((b) => {
      const short = b.name.replace('refs/heads/', '');
      const href = `${base}/tree/${encodeURIComponent(short)}`;
      const compareHref = short !== defaultRef ? `${base}/compare/${encodeURIComponent(`${defaultRef}...${short}`)}` : '';
      return html`
        <div class="commit-row">
          <div>
            <a href="${raw(href)}"><strong>${short}</strong></a>
            ${short !== defaultRef ? raw(` <a class="muted" href="${compareHref}">compare with ${escapeHtml(defaultRef)}</a>`) : ''}
          </div>
        </div>
      `;
    })
    .join('');
  const viewerLogin = resolved.viewer?.user.login ?? null;
  const body = html`<div class="card"><div class="card-title">Branches</div>${raw(rows || '<p class="muted">no branches</p>')}</div>`;
  return finish(
    c,
    new Response(
      repoPage(
        c.env,
        {
          repo: resolved.repo,
          ref: resolved.repo.default_branch,
          tab: 'branches',
          branches: refs.branches,
        },
        viewerLogin,
        body,
        c.req.url,
      ),
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    ),
  );
});

// ---------------------------------------------------------------------------
// Settings (owner only)
// ---------------------------------------------------------------------------

repoPages.get('/settings', async (c) => {
  const resolved = await resolveRepo(c, 'admin');
  if (!resolved) return notFound(c);
  if (!canAdminister(resolved)) return notFound(c);
  const repo = resolved.repo;
  const viewerLogin = resolved.viewer.user.login;
  const csrf = raw(csrfInput((await requestSession(c))?.csrfToken));
  const body = html`
    <div class="card">
      <div class="card-title">Repository settings</div>
      <form method="post" action="/${repo.owner_login}/${repo.name}/settings">
        ${csrf}
        <label for="description">Description</label>
        <input id="description" name="description" type="text" value="${repo.description ?? ''}" />
        <label for="visibility">Visibility</label>
        <select id="visibility" name="visibility">
          <option value="private" ${repo.visibility === 'private' ? 'selected' : ''}>private</option>
          <option value="public" ${repo.visibility === 'public' ? 'selected' : ''}>public</option>
        </select>
        <p><button class="btn primary" type="submit">Save</button></p>
      </form>
    </div>
    <div class="card">
      <div class="card-title">Danger zone</div>
      <form method="post" action="/${repo.owner_login}/${repo.name}/delete"
            onsubmit="return confirm('Delete this repository permanently?')">
        ${csrf}
        <button class="btn" type="submit">Delete repository</button>
      </form>
    </div>
  `;
  return finish(
    c,
    new Response(
      repoPage(c.env, { repo, ref: repo.default_branch, tab: 'settings' }, viewerLogin, body, c.req.url),
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    ),
  );
});

/**
 * Form posts authenticated by the session cookie must carry its CSRF token;
 * requestCredential has already refused cross-origin session posts. Bearer
 * credentials are not ambient and need none.
 */
export async function sessionFormRefused(c: Context<App>, viewer: ApiActor, form: Record<string, unknown>): Promise<Response | null> {
  if (viewer.via !== 'session') return null;
  const session = await requestSession(c);
  if (session && csrfTokenValid(session, form._csrf)) return null;
  return c.text(CSRF_REFUSED, 403);
}

repoPages.post('/settings', async (c) => {
  const resolved = await resolveRepo(c, 'admin');
  if (!resolved) return notFound(c);
  if (!canAdminister(resolved)) return notFound(c);
  const form = await c.req.parseBody();
  const refused = await sessionFormRefused(c, resolved.viewer, form);
  if (refused) return refused;
  const updated = await svc.updateRepo(c.env, resolved.repo, {
    description: String(form.description ?? ''),
    visibility: form.visibility === 'public' ? 'public' : 'private',
  });
  return finish(c, c.redirect(`/${updated.owner_login}/${updated.name}/settings`));
});

repoPages.post('/delete', async (c) => {
  const resolved = await resolveRepo(c, 'admin');
  if (!resolved) return notFound(c);
  if (!canAdminister(resolved)) return notFound(c);
  const refused = await sessionFormRefused(c, resolved.viewer, await c.req.parseBody());
  if (refused) return refused;
  await svc.deleteRepo(c.env, resolved.repo);
  return finish(c, c.redirect('/'));
});
