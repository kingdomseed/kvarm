/** Repo page chrome: header, tabs, branch selector, breadcrumbs, clone box. */

import { escapeHtml, html, raw } from '@kvarm/ui';
import type { RepoRow } from '../db/repos';
import { layout, requestOrigin, type PageOptions } from '../web/render';
import type { GitRef } from '@kvarm/gitops';

const COPY_JS = `document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(!b)return;navigator.clipboard.writeText(b.dataset.copy).then(()=>{const o=b.textContent;b.textContent='copied';setTimeout(()=>b.textContent=o,1200)})});`;

export type RepoTab = 'code' | 'changes' | 'commits' | 'branches' | 'issues' | 'environments' | 'compare' | 'activity' | 'train' | 'settings';

/** Tab text where the route name is not self-explanatory. */
const TAB_LABEL: Partial<Record<RepoTab, string>> = { train: 'merge queue' };

export interface ShellOptions extends Pick<PageOptions, 'active' | 'needsYouCount' | 'inboxCount' | 'runningCount'> {
  repo: RepoRow;
  ref: string;
  path?: string;
  tab?: RepoTab;
  branches?: GitRef[];
  title?: string;
  /** Extra <head> content (a module script for pages with a client). */
  head?: string;
  showClone?: boolean;
}

export function repoTabHref(repo: RepoRow, tab: RepoTab, ref: string): string {
  const base = `/${repo.owner_login}/${repo.name}`;
  switch (tab) {
    case 'changes':
      return `${base}/changes`;
    case 'commits':
      return `${base}/commits?ref=${encodeURIComponent(ref)}`;
    case 'branches':
      return `${base}/branches`;
    case 'issues':
      return `${base}/issues`;
    case 'environments':
      return `${base}/environments`;
    case 'compare':
      return `${base}/compare`;
    case 'activity':
      return `${base}/activity`;
    case 'train':
      return `${base}/train`;
    case 'settings':
      return `${base}/settings`;
    default:
      return `${base}/tree/${encodeURIComponent(ref)}`;
  }
}

/** Breadcrumb links: path segments are percent-encoded in hrefs, escaped as text. */
function breadcrumbs(repo: RepoRow, ref: string, path: string): string {
  const base = `/${repo.owner_login}/${repo.name}/tree/${encodeURIComponent(ref)}`;
  const parts = path.split('/').filter(Boolean);
  let acc = '';
  const crumbs = parts.map((p) => {
    acc = acc ? `${acc}/${p}` : p;
    return `<a href="${base}/${encodeURIComponent(acc)}">${escapeHtml(p)}</a>`;
  });
  return [
    `<a href="${base}">${escapeHtml(repo.name)}</a>`,
    ...crumbs,
  ].join(' <span class="muted">/</span> ');
}

export function cloneBox(env: Env, requestUrl: string, repo: RepoRow, ref: string, id?: string): string {
  const cloneCommand = `git clone ${requestOrigin(env, requestUrl)}/${repo.owner_login}/${repo.name}.git`;
  const checkoutCommand = `kvarm checkout ${repo.owner_login}/${repo.name} ${ref} <dir>`;
  return html`<div class="clone-box">
    <code ${raw(id ? `id="${escapeHtml(id)}"` : '')}>${cloneCommand}</code>
    <button class="btn" type="button" data-copy="${cloneCommand}">Copy</button>
    <code class="clone-cli m-agent">${checkoutCommand}</code>
  </div>`;
}

/**
 * A repository whose description opens with the word "Demo" is the
 * deployment's example repository; the header says so with a badge. The
 * description is the only owner-editable surface that can carry the mark,
 * so it is the convention.
 */
export function isDemoRepo(description: string | null | undefined): boolean {
  return /^demo\b/i.test((description ?? '').trim());
}

export function repoPage(env: Env, opts: ShellOptions, userLogin: string | null, body: string, requestUrl: string): string {
  const { repo } = opts;
  const ref = opts.ref;
  const branchList = (opts.branches ?? [])
    .map((b) => {
      const short = b.name.replace('refs/heads/', '');
      return `<li><a href="/${repo.owner_login}/${repo.name}/tree/${encodeURIComponent(short)}">${escapeHtml(short)}</a></li>`;
    })
    .join('');

  // Day-to-day views first; coordination and admin views after a divider.
  const primary: RepoTab[] = ['code', 'changes', 'issues', 'commits', 'branches'];
  const secondary: RepoTab[] = ['compare', 'activity', 'train'];
  if (userLogin) secondary.push('environments');
  if (userLogin === repo.owner_login) secondary.push('settings');
  const tabLink = (t: RepoTab) =>
    `<a class="tab ${opts.tab === t ? 'active' : ''}" href="${repoTabHref(repo, t, ref)}"${opts.tab === t ? ' aria-current="page"' : ''}>${TAB_LABEL[t] ?? t}</a>`;
  const tabHtml = `${primary.map(tabLink).join('')}<span class="tab-sep" aria-hidden="true"></span>${secondary.map(tabLink).join('')}`;

  const description = repo.description ? html`<p class="lede">${repo.description}</p>` : '';
  // The repository root needs no breadcrumb: the header already names it.
  const crumbs =
    opts.path && opts.tab !== 'settings' && opts.tab !== 'environments'
      ? `<div class="crumbs hud">${breadcrumbs(repo, ref, opts.path)}</div>`
      : '';
  const clone = opts.showClone === false
    ? ''
    : cloneBox(env, requestUrl, repo, ref, 'clone-url');

  const shellBody = html`
<header class="k-head repo-page-head">
  <div class="k-head-copy">
    <p class="hud k-head-hud"><a href="/${repo.owner_login}">${repo.owner_login}</a><span aria-hidden="true">/</span></p>
    <div class="repo-title"><h1><a href="/${repo.owner_login}/${repo.name}">${repo.name}</a></h1><span class="tag">${repo.visibility}</span>${isDemoRepo(repo.description) ? raw('<span class="tag demo">Demo</span>') : ''}</div>
    ${raw(description)}
  </div>
  ${clone ? raw(html`<details class="clone-menu k-head-side">
    <summary class="btn btn-primary">Clone <span aria-hidden="true">▾</span></summary>
    <div class="clone-pop">${raw(clone)}</div>
  </details>`) : ''}
</header>
<div class="k-tab-bar">
  <nav class="tabs k-tabs">${raw(tabHtml)}</nav>
  <details class="branch-picker">
    <summary><span class="hud muted">ref</span> <code>${ref}</code> ▾</summary>
    <ul>${raw(branchList || '<li class="muted">loading…</li>')}</ul>
  </details>
</div>
<div class="k-repo-content">
  ${raw(crumbs)}
  ${raw(body)}
</div>
`;
  return layout(
    env,
    {
      title: opts.title ?? `${repo.owner_login}/${repo.name}`,
      userLogin,
      contentInset: false,
      script: COPY_JS,
      head: opts.head,
      repos: [{ ownerLogin: repo.owner_login, name: repo.name }],
      active: opts.active,
      needsYouCount: opts.needsYouCount,
      inboxCount: opts.inboxCount,
      runningCount: opts.runningCount,
    },
    shellBody,
  );
}
