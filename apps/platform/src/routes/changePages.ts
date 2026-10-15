/**
 * Repository change list and review pages. Reads and writes stay on the
 * existing change, review, and compare services.
 */

import { Hono, type Context } from 'hono';
import { escapeHtml, html, raw, timeAgo } from '@kvarm/ui';
import { fallbackGuide, type CoverageMap, type ResolvedChapter, type ReviewTier } from '@kvarm/review';
import type { RepoRow } from '../db/repos';
import { repoPage } from '../render/repoShell';
import { appLayoutCounts } from '../web/render';
import { authorizeRoute, requestSession, type App } from './api';
import { csrfInput } from '../web/render';
import { resolveRepo, notFound, finish, type Resolved } from './repoPages';
import * as changes from '../services/changes';
import * as reviews from '../services/reviews';
import * as compare from '../services/compare';
import { headCoverage, recordHeadTier } from '../services/reviewCoverage';
import { approvalNeedsDecisionNote, decisionErrorMessage, decideFromPage } from '../services/reviewInbox';
import { forgetInboxCount } from '../services/inboxCount';
import type { CarryView } from '../services/approvalCarry';
import { remainingFor, type RemainingItem, type RemainingWho } from '../services/remaining';
import { DIFF_CLIENT_TAG, DIFF_TOOLBAR_CONTROLS, renderCompareFileRow } from './comparePages';
import { commitProvenance } from '../services/provenancePanel';
import { provenancePanel } from '../render/provenance';
import * as reviewGuide from '../services/reviewGuide';
import * as reviewImpact from '../services/reviewImpact';

export const changePages = new Hono<App>();

const HTML = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } as const;
const LIST_LIMIT = 25;

type ReviewTierLabel = ReviewTier;

function base(repo: RepoRow): string {
  return `/${repo.owner_login}/${repo.name}`;
}

async function page(c: Context<App>, resolved: Resolved, title: string, body: string, tab: 'changes' | 'review' = 'changes'): Promise<Response> {
  const counts = await appLayoutCounts(c.env, { userId: resolved.viewer?.user.id ?? null });
  const content = repoPage(
    c.env,
    {
      repo: resolved.repo,
      ref: resolved.repo.default_branch || 'main',
      tab: 'changes',
      title,
      head: tab === 'review' ? DIFF_CLIENT_TAG : undefined,
      ...counts,
    },
    resolved.viewer?.user.login ?? null,
    `<div data-live-repo="${escapeHtml(`${resolved.repo.owner_login}/${resolved.repo.name}`)}" data-live-root>${body}</div>`,
    c.req.url,
  );
  return finish(c, new Response(content, { headers: HTML }));
}

function queryFlash(c: Context<App>): string {
  const error = c.req.query('error');
  const notice = c.req.query('notice');
  const done = c.req.query('done');
  const notices: Record<string, string> = {
    approve: 'Review submitted.',
    'request-changes': 'Change request submitted.',
    ack: 'Review acknowledged.',
    'review-requested': 'Reviewer requested.',
    'review-request-withdrawn': 'Reviewer request withdrawn.',
    resolve: 'Escalation resolved.',
    ship: 'Change approved and queued to ship.',
  };
  const message = error
    ? decisionErrorMessage(error).text
    : done
      ? Object.hasOwn(notices, done) ? notices[done] : undefined
      : notice && Object.hasOwn(notices, notice) ? notices[notice] : undefined;
  if (error) {
    const detail = decisionErrorMessage(error);
    return html`<div class="flash err">${detail.text}${detail.fallback ? raw(html` <code>${error}</code>`) : ''}</div>`;
  }
  if ((done || notice) && message) return html`<div class="flash ok">${message}</div>`;
  return '';
}

function stateTag(state: string): string {
  const klass = state === 'merged' ? 'ok' : state === 'conflicted' ? 'err' : state === 'closed' ? 'muted' : 'signal';
  return html`<span class="tag ${klass}">${state}</span>`;
}

function checksSummary(checks: readonly { status: string; conclusion: string | null; required: boolean }[]): string {
  if (checks.length === 0) return html`<span class="muted">no checks reported</span>`;
  const required = checks.filter((check) => check.required);
  const rows = required.length > 0 ? required : checks;
  const failed = rows.filter((check) => check.conclusion === 'failure' || check.status === 'failure').length;
  const pending = rows.filter((check) => check.status !== 'completed' && check.conclusion === null).length;
  const passed = rows.filter((check) => check.conclusion === 'success' || check.status === 'success').length;
  if (failed) return html`<span class="err">${failed} failing</span>`;
  if (pending) return html`<span class="muted">${pending} pending</span>`;
  if (passed) return html`<span class="ok">${passed} passing</span>`;
  return html`<span class="muted">${rows.length} reported</span>`;
}

changePages.get('/changes', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  const state = c.req.query('state') ?? 'open';
  const [listed, pending] = await Promise.all([
    changes.listChanges(c.env, resolved.repo, { state, limit: String(LIST_LIMIT), cursor: c.req.query('cursor') }),
    reviews.pendingReviews(c.env, resolved.repo, { limit: '25' }, (promise) => c.executionCtx.waitUntil(promise)),
  ]);
  if (!listed.ok) return page(c, resolved, 'Changes', html`<div class="flash err">${listed.error}</div>`);
  const checkResults = await Promise.all(
    listed.value.changes.map((change) => changes.listChangeChecks(c.env, resolved.repo, String(change.number))),
  );
  const checkByNumber = new Map<number, string>();
  listed.value.changes.forEach((change, index) => {
    const result = checkResults[index];
    checkByNumber.set(change.number, result?.ok ? checksSummary(result.value.checks) : html`<span class="muted">unavailable</span>`);
  });
  const pendingLine = (change: reviews.PendingReview, reason = '') => html`
    <li>
      <a href="${raw(`${base(resolved.repo)}/changes/${change.number}`)}"><span class="hud">#${change.number}</span> ${change.title}</a>
      <span class="muted">· ${change.approvals.count}/${change.approvals.required} approvals${reason ? ` · ${reason}` : ''}</span>
    </li>`;
  const readyReviews = pending.ok ? pending.value.changes.filter((change) => change.readiness.ready) : [];
  const notReadyReviews = pending.ok ? pending.value.changes.filter((change) => !change.readiness.ready) : [];
  const readinessReason: Record<Exclude<reviews.PendingReview['readiness']['reason'], null>, string> = {
    conflicted: 'Has conflicts the author must resolve.',
    'checks-pending': 'Waiting on checks.',
    'checks-failed': 'Checks failed.',
    unknown: 'Readiness could not be determined.',
  };
  const pendingContent = pending.ok
    ? pending.value.changes.length
      ? html`<div class="pending-review-groups">
          <div><div class="eyebrow">Ready for review</div>
            ${readyReviews.length ? raw(html`<ul class="k-list">${raw(readyReviews.map((change) => pendingLine(change)).join(''))}</ul>`) : raw(html`<p class="muted">No changes ready for review.</p>`)}
          </div>
          ${notReadyReviews.length ? raw(html`<details class="not-ready-group">
            <summary>Not ready yet (${notReadyReviews.length})</summary>
            <ul class="k-list">${raw(notReadyReviews.map((change) => pendingLine(change, readinessReason[change.readiness.reason ?? 'unknown'])).join(''))}</ul>
          </details>`) : ''}
        </div>`
      : html`<p class="muted">No changes are waiting for review.</p>`
    : html`<p class="muted">The review queue is unavailable.</p>`;
  const rows = listed.value.changes.map((change) => html`
    <tr>
      <td><a href="${raw(`${base(resolved.repo)}/changes/${change.number}`)}">#${change.number}</a></td>
      <td><a href="${raw(`${base(resolved.repo)}/changes/${change.number}`)}">${change.title}</a></td>
      <td><code>${change.head}</code> <span class="muted">→</span> <code>${change.base}</code></td>
      <td>${raw(stateTag(change.state))}</td>
      <td>${raw(checkByNumber.get(change.number) ?? '')}</td>
      <td class="muted">${timeAgo(Date.parse(change.updatedAt))}</td>
    </tr>`).join('');
  const filters = (['open', 'merged', 'closed'] as const).map((value) =>
    html`<a class="tab ${state === value ? 'active' : ''}" href="${raw(`${base(resolved.repo)}/changes?state=${value}`)}"${state === value ? ' aria-current="page"' : ''}>${value}</a>`,
  ).join('');
  const next = listed.value.nextCursor
    ? html`<p><a class="btn" href="${raw(`${base(resolved.repo)}/changes?state=${state}&cursor=${listed.value.nextCursor}`)}">Older changes</a></p>`
    : '';
  return page(c, resolved, 'Changes', html`
    <div data-live-region="changes">
    ${raw(queryFlash(c))}
    <section class="card review-pending">
      <div class="card-title">Needs your review</div>
      ${raw(pendingContent)}
    </section>
    <section class="card">
      <div class="card-title">Changes</div>
      <nav class="tabs change-filters" aria-label="Filter changes">${raw(filters)}</nav>
      <div class="table-wrap"><table class="table changes-table">
        <thead><tr><th>Change</th><th>Title</th><th>Head → base</th><th>State</th><th>Checks</th><th>Updated</th></tr></thead>
        <tbody>${raw(rows || '<tr><td colspan="6" class="muted">No changes in this state.</td></tr>')}</tbody>
      </table></div>
      ${raw(next)}
    </section></div>`);
});

function stageStrip(change: changes.ChangeDetail, packet: reviews.ReviewPacket): string {
  const merged = change.state === 'merged';
  const failed = change.checks.some((check) => check.conclusion === 'failure' || check.status === 'failure');
  const checksDone =
    change.checks.length > 0 &&
    change.checks.every((check) => check.status === 'success' || check.status === 'failure' || check.status === 'skipped' || check.conclusion !== null);
  const queued = change.queueState !== null;
  const stages = [
    ['Checks', failed ? 'blocked' : checksDone ? 'done' : 'current'],
    ['Review', merged || packet.satisfied ? 'done' : failed ? 'pending' : 'current'],
    ['Train', merged ? 'done' : queued ? 'current' : 'pending'],
    ['Merged', merged ? 'done' : 'pending'],
  ] as const;
  return html`<ol class="change-stages">${raw(stages.map(([label, status]) => `<li class="${status}"><span class="stage-mark"></span><span>${label}</span></li>`).join(''))}</ol>`;
}

function tierFor(guide: ReturnType<typeof fallbackGuide>, keys: readonly string[]): ReviewTierLabel {
  const order: Record<ReviewTier, number> = { receipt: 0, read: 1, scrutinize: 2 };
  return keys.map((key) => guide.tiers[key] ?? 'read').reduce((a, b) => order[a] >= order[b] ? a : b, 'receipt');
}

function tierTag(tier: ReviewTier): string {
  const klass = tier === 'scrutinize' ? 'heat-3 fail' : tier === 'read' ? 'signal-hi' : 'steel';
  return html`<span class="tag review-tier ${klass}">${tier}</span>`;
}

function filesLabel(count: number): string {
  return count === 1 ? 'file' : 'files';
}

function renderGuide(
  repo: RepoRow,
  encRange: string,
  result: compare.CompareResponse,
  guide: ReturnType<typeof fallbackGuide>,
  map: CoverageMap,
  configError: string | null,
  carry: CarryView | null,
  pageGuide?: reviewGuide.ReviewGuideView,
  options: {
    path: string; headSha: string; csrf: string; writable: boolean;
    view: 'guided' | 'tier' | 'file'; layerOnly: boolean; impact: reviewImpact.ReviewImpactView | null;
  } = {
    path: '',
    headSha: '',
    csrf: '',
    writable: false,
    view: 'guided',
    layerOnly: false,
    impact: null,
  },
): string {
  const selectedGuide = pageGuide?.guide ?? guide;
  const units = new Map(map.units.map((unit) => [unit.key, unit]));
  const files = new Map(result.files.map((file) => [file.path, file]));
  const pageUnits = pageGuide?.units ?? map.units.map((unit) => ({
    key: unit.key, path: unit.path, tier: selectedGuide.tiers[unit.key] ?? unit.defaultTier,
    acked: false, ackCount: 0, inherited: undefined,
  }));
  const visiblePageUnits = pageUnits.filter((unit) => !options.layerOnly || !unit.inherited);
  const visiblePageUnitsByKey = new Map(visiblePageUnits.map((unit) => [unit.key, unit]));
  const chapters: ResolvedChapter[] = options.view === 'guided'
    ? selectedGuide.chapters
    : options.view === 'tier'
      ? (['scrutinize', 'read', 'receipt'] as const).flatMap((tier) => {
          const hunks = visiblePageUnits.filter((unit) => unit.tier === tier).map((unit) => unit.key);
          return hunks.length ? [{ id: tier, title: `${tier} tier`, tier, hunks }] : [];
        })
      : [...new Set(visiblePageUnits.map((unit) => unit.path))].sort().map((path) => {
          const fileUnits = visiblePageUnits.filter((unit) => unit.path === path);
          return { id: path, title: path, tier: tierFor(selectedGuide, fileUnits.map((unit) => unit.key)), hunks: fileUnits.map((unit) => unit.key) };
        });
  const rows = chapters.map((chapter) => {
    const keysByPath = new Map<string, string[]>();
    for (const key of chapter.hunks) {
      const unit = units.get(key);
      const pageUnit = visiblePageUnitsByKey.get(key);
      if (!unit || !pageUnit) continue;
      const keys = keysByPath.get(pageUnit.path) ?? [];
      keys.push(key);
      keysByPath.set(pageUnit.path, keys);
    }
    const fileRows = [...keysByPath].map(([path, keys]) => {
      const file = files.get(path);
      if (!file) return '';
      const tier = tierFor(selectedGuide, keys);
      const mark = carry?.unchangedPaths.includes(path) ? 'unchanged' : carry?.changedPaths.includes(path) ? 'changed' : null;
      const rowUnits = keys.map((key) => visiblePageUnitsByKey.get(key)).filter((unit) => unit !== undefined);
      const reviewed = rowUnits.filter((unit) => unit.acked).length;
      const from = rowUnits.find((unit) => unit.inherited)?.inherited?.change;
      return html`<div class="carry-file-row ${mark ? `carry-${mark}` : ''}" data-review-file-row tabindex="0">
        <div class="carry-file-actions">
          ${rowUnits.length ? raw(html`<span class="muted">${reviewed}/${rowUnits.length} reviewed</span>`) : ''}
          ${from ? raw(html`<span class="tag steel">from #${from}</span>`) : ''}
          ${mark ? raw(html`<span class="tag ${mark === 'changed' ? 'err' : 'steel'}">${mark}</span>`) : ''}
          ${options.writable ? raw(html`<form method="post" action="${raw(`${options.path}/ack`)}" class="inline review-ack-form">
            ${raw(options.csrf)}<input type="hidden" name="headSha" value="${options.headSha}" />
            ${raw(keys.map((key) => html`<input type="hidden" name="keys" value="${key}" />`).join(''))}
            <button class="btn btn-sm" type="submit">Mark reviewed</button>
          </form>`) : ''}
        </div>
        ${raw(renderCompareFileRow(repo, encRange, file, tier))}
      </div>`;
    }).join('');
    return html`<section class="card guide-chapter">
      <div class="card-title">${chapter.title} ${raw(tierTag(chapter.tier))}
      ${options.writable ? raw(html`<form method="post" action="${raw(`${options.path}/ack`)}" class="inline review-ack-form">
        ${raw(options.csrf)}<input type="hidden" name="headSha" value="${options.headSha}" />
        ${raw(chapter.hunks.filter((key) => visiblePageUnitsByKey.has(key)).map((key) => html`<input type="hidden" name="keys" value="${key}" />`).join(''))}
        <button class="btn btn-sm" type="submit">Mark chapter reviewed</button>
      </form>`) : ''}</div>
      ${chapter.why ? raw(html`<p class="muted">${chapter.why}</p>`) : ''}
      ${raw(chapter.notes?.map((note) => html`<p class="guide-note">${note.body}</p>`).join('') ?? '')}
      <div class="compare-list">${raw(fileRows || '<p class="muted">No diff rows in this chapter.</p>')}</div>
    </section>`;
  }).join('');
  const counts = { scrutinize: new Set<string>(), read: new Set<string>(), receipt: new Set<string>() };
  for (const unit of map.units) {
    const tier = selectedGuide.tiers[unit.key] ?? unit.defaultTier;
    counts[tier].add(unit.path);
  }
  const summary = html`<section class="card coverage-summary">
    <div class="card-title">Coverage · ${selectedGuide.source === 'fallback' ? 'Generated guide' : 'Author guide'}</div>
    <nav class="tabs guide-views" aria-label="Review view">${raw((['guided', 'tier', 'file'] as const).map((item) =>
      html`<a class="tab ${options.view === item ? 'active' : ''}" href="${raw(`${options.path}?view=${item}${options.layerOnly ? '&layer=only' : ''}`)}">${item}</a>`,
    ).join(''))}</nav>
    <p><a href="${raw(`${options.path}?view=${options.view}${options.layerOnly ? '' : '&layer=only'}`)}">${options.layerOnly ? 'Show full stack' : 'Only this layer'}</a></p>
    <div class="coverage-counts">
      <span>${raw(tierTag('scrutinize'))} ${counts.scrutinize.size} ${filesLabel(counts.scrutinize.size)}</span>
      <span>${raw(tierTag('read'))} ${counts.read.size} ${filesLabel(counts.read.size)}</span>
      <span>${raw(tierTag('receipt'))} ${counts.receipt.size} ${filesLabel(counts.receipt.size)}</span>
    </div>
    ${map.truncated ? raw(html`<p class="flash warn">Coverage is truncated by the review-page diff budget.</p>`) : ''}
    ${configError ? raw(html`<p class="flash warn">${configError}</p>`) : ''}
    ${carry && carry.changedPaths.length
      ? raw(html`<div class="approval-carry"><p>Your approval at <code>${carry.fromHead.slice(0, 8)}</code> still covers ${carry.unchangedPaths.length} of ${carry.unchangedPaths.length + carry.changedPaths.length} ${filesLabel(carry.unchangedPaths.length + carry.changedPaths.length)}. Review the ${carry.changedPaths.length} changed ${filesLabel(carry.changedPaths.length)}.</p>
          <ul class="carry-agent-paths">${raw(carry.changedPaths.map((path) => `<li><code>${escapeHtml(path)}</code></li>`).join(''))}</ul></div>`)
      : ''}
  </section>`;
  const stack = pageGuide?.stack;
  const stackPanel = stack && (stack.parents.length || stack.children.length) ? html`<section class="card review-stack">
    <div class="card-title">Stack · ${stack.inherited} inherited unit(s)</div>
    ${raw([...stack.parents.map((item) => html`<a class="tag" href="${raw(`${base(repo)}/changes/${item.number}`)}">parent #${item.number}</a>`),
      ...stack.children.map((item) => html`<a class="tag" href="${raw(`${base(repo)}/changes/${item.number}`)}">child #${item.number}</a>`)].join(' '))}
  </section>` : '';
  const findings = pageGuide?.findings.items.filter((item) => item.status === 'open') ?? [];
  const findingPanel = pageGuide ? html`<section class="card"><div class="card-title">Open findings · ${findings.length}</div>
    ${raw(findings.length ? html`<ul class="k-list">${raw(findings.map((item) => html`<li>
      <span class="tag ${item.severity === 'high' ? 'err' : 'signal'}">${item.severity}</span>
      <span class="tag">${item.confidence}</span> ${item.title}
    </li>`).join(''))}</ul>` : html`<p class="muted">No open findings.</p>`)}
  </section>` : '';
  const contractsPanel = pageGuide ? html`<section class="card"><div class="card-title">Contracts & export breaks</div>
    <p class="muted">${pageGuide.contracts.declared.length} declared · ${pageGuide.contracts.undeclared.length} undeclared</p>
    ${raw(html`<ul class="k-list">${raw(pageGuide.contracts.breaks.map((item) => html`<li>
      <code>${item.path}</code> · ${item.name} · ${item.change} · ${item.declared ? 'declared' : 'undeclared'}
    </li>`).join(''))}</ul>`)}
  </section>` : '';
  const evidencePanel = pageGuide?.guide.evidence ? html`<section class="card"><div class="card-title">Guide evidence</div>
    ${raw(html`<ul class="k-list">${raw(pageGuide.guide.evidence.map((item) => html`<li><span class="tag">${item.status}</span> ${item.kind}: ${item.ref}</li>`).join(''))}</ul>`)}
  </section>` : '';
  const moved = pageGuide?.units.filter((unit) => unit.moved) ?? [];
  const movedPanel = moved.length ? html`<section class="card"><div class="card-title">Moved code</div>
    ${raw(html`<ul class="k-list">${raw(moved.map((unit) => html`<li><code>${unit.path}</code> moved from <code>${unit.moved!.from}</code></li>`).join(''))}</ul>`)}
  </section>` : '';
  const impactPanel = !pageGuide ? '' : options.impact ? html`<section class="card"><div class="card-title">Downstream impact</div>
    <p class="muted">${options.impact.files.reduce((n, item) => n + item.consumers.length, 0)} importers · ${new Set(options.impact.files.flatMap((item) => item.tests)).size} tests${options.impact.truncated ? ' · truncated' : ''}</p>
    ${raw(html`<ul class="k-list">${raw(options.impact.files.filter((item) => item.consumers.length || item.tests.length).slice(0, 8).map((item) => html`<li>
      <code>${item.path}</code> · ${item.consumers.length} importer(s) · ${item.tests.length} test(s)
    </li>`).join(''))}</ul>`)}
    ${options.impact.truncated ? raw(html`<p class="muted">Some downstream consumers were omitted by the analysis budget.</p>`) : ''}
  </section>` : html`<section class="card"><div class="card-title">Downstream impact</div><p class="muted">Not computed yet.</p></section>`;
  return html`<div id="review-guide" class="compare-root review-guide-root" data-file-api="/api/v1/repos/${repo.owner_login}/${repo.name}/compare/${raw(encRange)}/file">
    ${raw(stackPanel)}${raw(summary)}
    <div class="review-insights">${raw(findingPanel)}${raw(contractsPanel)}${raw(evidencePanel)}${raw(movedPanel)}${raw(impactPanel)}</div>
    ${rows ? raw(html`<div class="diff-toolbar"><span class="hud muted">Files</span><span class="spacer"></span>${raw(DIFF_TOOLBAR_CONTROLS)}</div>`) : ''}
    ${raw(rows || '<p class="muted">No reviewable files in this change.</p>')}
  </div>`;
}

function checkRows(change: changes.ChangeDetail): string {
  if (!change.checks.length) return html`<p class="muted">No checks have been reported.</p>`;
  return html`<ul class="k-list">${raw(change.checks.map((check) => {
    const state = check.conclusion ?? check.status;
    const klass = state === 'success' ? 'ok' : state === 'failure' ? 'err' : 'muted';
    const link = check.detailsUrl ? `<a href="${escapeHtml(check.detailsUrl)}" rel="nofollow noopener">${escapeHtml(check.name)}</a>` : escapeHtml(check.name);
    return `<li><span>${link}</span> <span class="tag ${klass}">${escapeHtml(state)}</span>${check.required ? ' <span class="muted">required</span>' : ''}</li>`;
  }).join(''))}</ul>`;
}

function remainingPanel(items: readonly RemainingItem[], state: string, queueState: string | null, agentMode: boolean): string {
  if (state === 'closed' || state === 'merged') return '';
  const glyph: Record<RemainingWho, string> = { human: 'H', reviewer: 'R', author: 'A', ci: 'CI', train: 'T', dependency: 'D' };
  const rows = items.map((item) => html`<li class="remaining-row">
    <span class="remaining-who" aria-label="${item.who}" title="${item.who}">${glyph[item.who]}</span>
    <div class="remaining-copy">
      <span>${item.summary}</span>
      ${item.paths?.length ? raw(html`<ul class="remaining-paths">${raw(item.paths.map((path) => `<li><code>${escapeHtml(path)}</code></li>`).join(''))}</ul>`) : ''}
    </div>
    <div class="remaining-meta">
      ${item.you ? raw(html`<span class="tag signal-hi">You</span>`) : ''}
      ${agentMode ? raw(html`<code class="remaining-code">${item.code}</code>`) : ''}
    </div>
  </li>`).join('');
  const empty = queueState !== null ? 'In the merge queue.' : 'Nothing left. Ready to merge.';
  return html`<section class="card remaining-panel">
    <div class="card-title">What’s left</div>
    ${items.length ? raw(html`<ol class="remaining-list">${raw(rows)}</ol>`) : html`<p class="muted">${empty}</p>`}
  </section>`;
}

function reviewTimeline(packet: reviews.ReviewPacket): string {
  if (!packet.reviews.length) return html`<p class="muted">No reviews submitted yet.</p>`;
  return html`<ol class="review-timeline">${raw(packet.reviews.map((review) => `
    <li><div><strong>${escapeHtml(review.reviewer.agent?.name ?? review.reviewer.login)}</strong>
      <span class="tag ${review.verdict === 'approve' ? 'ok' : 'err'}">${escapeHtml(review.verdict)}</span>
      ${review.current ? '' : '<span class="muted"> · previous head</span>'}
      ${review.carriedFromHead ? `<span class="muted"> · carried from ${escapeHtml(review.carriedFromHead.slice(0, 8))}</span>` : ''}
      <span class="muted"> · ${timeAgo(Date.parse(review.updatedAt))}</span></div>
      ${review.body ? `<p>${escapeHtml(review.body)}</p>` : ''}</li>`).join(''))}</ol>`;
}

async function renderDetail(c: Context<App>, resolved: Resolved, number: string): Promise<Response> {
  const cx: changes.ChangeContext = {
    env: c.env,
    repo: resolved.repo,
    actor: resolved.viewer,
    writeAccess: resolved.viewer !== null && (resolved.role === 'write' || resolved.role === 'admin'),
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  };
  const detail = await changes.getChange(cx, number, { includeRemaining: false });
  if (!detail.ok) return notFound(c);
  const change = detail.value;
  const row = await c.env.DB.prepare('SELECT id FROM change_sets WHERE repo_id = ? AND number = ?')
    .bind(resolved.repo.id, change.number).first<{ id: string }>();
  if (!row) return notFound(c);
  const coverage = change.headSha
    ? await headCoverage(c.env, resolved.repo, { id: row.id, base: change.base }, change.headSha, (promise) => c.executionCtx.waitUntil(promise))
    : null;
  if (change.headSha && coverage) {
    await recordHeadTier(c.env, resolved.repo, { id: row.id, base: change.base }, change.headSha, coverage, (promise) => c.executionCtx.waitUntil(promise));
  }
  const guideResult = change.headSha ? await reviewGuide.getGuide(cx, number, {}, undefined, coverage ?? undefined) : null;
  const pageGuide = guideResult?.ok ? guideResult.value : null;
  let impact: reviewImpact.ReviewImpactView | null = null;
  if (pageGuide?.impact.cached && coverage) {
    impact = await reviewImpact.getCachedReviewImpact(coverage);
  } else if (change.headSha) {
    c.executionCtx.waitUntil(reviewImpact.getReviewImpact(cx, number).catch(() => undefined));
  }
  const [packet, aux] = await Promise.all([
    reviews.getReviewPacket(c.env, resolved.repo, number),
    change.state === 'open' || change.state === 'conflicted'
      ? changes.readRemainingAux(c.env, resolved.repo.id, change.number)
      : Promise.resolve({ dependency: null, resolveConflictTaskOpen: false }),
  ]);
  if (!packet.ok) return notFound(c);
  const reviewPacket = packet.value;
  const reviewerData = await reviews.reviewPageReviewers(
    c.env,
    resolved.repo,
    row.id,
    coverage?.map?.units.map((unit) => unit.path) ?? [],
    reviewPacket.author.principal,
    reviewPacket.headSha,
  );
  const requestedReviewers = reviewerData.requested;
  reviewPacket.suggestedReviewers = reviewerData.suggested;
  const approvalNoteRequired = approvalNeedsDecisionNote(reviewPacket);
  const provenance = await commitProvenance(c.env, resolved.repo, reviewPacket.headSha, {
    admin: resolved.role === 'admin',
    change: change.number,
  });
  const viewerPrincipal = resolved.viewer
    ? resolved.viewer.agent
      ? `agent:${resolved.viewer.agent.agentId}`
      : `user:${resolved.viewer.user.id}`
    : null;
  const remaining = remainingFor({
    change: {
      state: change.state,
      mergePolicy: change.mergePolicy,
      author: { login: reviewPacket.author.login, agentId: reviewPacket.author.agent?.id ?? null },
      queueState: change.queueState,
      conflicts: change.conflicts,
    },
    blockers: reviewPacket.blockers,
    approvals: reviewPacket.approvals,
    agentApprovals: reviewPacket.policy.agentApprovals,
    mergeability: change.mergeability,
    dependency: aux.dependency,
    resolveConflictTaskOpen: aux.resolveConflictTaskOpen,
    requestedReviewers: requestedReviewers.map((reviewer) => reviewer.login ?? reviewer.principal),
    viewer: {
      principal: viewerPrincipal,
      login: resolved.viewer?.user.login ?? null,
      kind: resolved.viewer ? (resolved.viewer.agent ? 'agent' : 'human') : null,
      writeAccess: resolved.viewer !== null && (resolved.role === 'write' || resolved.role === 'admin'),
    },
  });
  const path = `${base(resolved.repo)}/changes/${change.number}`;
  const requestedView = c.req.query('view');
  const view = requestedView === 'tier' || requestedView === 'file' ? requestedView : 'guided';
  const layerOnly = c.req.query('layer') === 'only';
  const encRange = encodeURIComponent(`${change.base}...${change.headSha ?? change.head}`);
  let coverageBody = html`<div class="flash warn">The base or head commit is unavailable for a bounded diff.</div>`;
  const configError = coverage?.configError ?? null;
  if (coverage) {
    if (coverage.response && coverage.map && coverage.guide) {
      const principal = resolved.viewer
        ? resolved.viewer.agent
          ? `agent:${resolved.viewer.agent.agentId}`
          : `user:${resolved.viewer.user.id}`
        : null;
      const carry = reviewPacket.carry.find((item) => item.principal === principal && item.changedPaths.length > 0) ?? null;
      coverageBody = renderGuide(
        resolved.repo,
        encRange,
        coverage.response,
        coverage.guide,
        coverage.map,
        configError,
        carry,
        pageGuide ?? undefined,
        {
          path,
          headSha: change.headSha ?? '',
          csrf: resolved.viewer !== null && (resolved.role === 'write' || resolved.role === 'admin')
            ? csrfInput((await requestSession(c))?.csrfToken)
            : '',
          writable: resolved.viewer !== null && (resolved.role === 'write' || resolved.role === 'admin'),
          view,
          layerOnly,
          impact,
        },
      );
    } else {
      coverageBody = html`<div class="flash warn">Diff coverage unavailable: ${coverage.error ?? 'the bounded comparison could not be read.'}</div>`;
    }
  }
  const checkTags = change.checks.map((check) => html`<span class="tag">${check.name}: ${check.conclusion ?? check.status}</span>`).join(' ');
  const reviewRows = reviewTimeline(reviewPacket);
  const writable = resolved.viewer !== null && (resolved.role === 'write' || resolved.role === 'admin');
  const canResolve = writable && !resolved.viewer?.agent && viewerPrincipal !== reviewPacket.author.principal;
  const csrf = writable ? csrfInput((await requestSession(c))?.csrfToken) : '';
  const draft = change.mergePolicy === 'draft';
  const author =
    reviewPacket.author.agent && reviewPacket.author.login
      ? html`agent <strong>${reviewPacket.author.agent.name}</strong> for ${reviewPacket.author.login}`
      : reviewPacket.author.agent
        ? html`agent <strong>${reviewPacket.author.agent.name}</strong>`
        : html`<strong>${reviewPacket.author.login ?? 'unknown'}</strong>`;
  const reasons = change.rating?.reasons.map((reason) => html`<li>${reason}</li>`).join('') ?? '';
  const body = html`
    ${raw(queryFlash(c))}
    <header class="k-head change-head">
      <p class="hud">#${change.number} · <span class="ident">${change.head}</span> → <span class="ident">${change.base}</span> · ${change.state}</p>
      <h1>${change.title}</h1>
      <p class="lede">by ${raw(author)} · mergeability:
        ${change.mergeability ? raw(stateTag(change.mergeability.status)) : html`<span class="tag muted">not evaluated</span>`}</p>
    </header>
    ${raw(stageStrip(change, reviewPacket))}
    <div data-live-region="review"><div class="change-review-grid">
      <main class="change-review-main">
        <section class="card review-packet">
          <div class="card-title">Review packet <span class="tag ${change.rating?.level ?? 'muted'}">${change.rating ? `${change.rating.level} risk · ${change.rating.score}` : 'risk unavailable'}</span></div>
          ${change.rating?.reasons.length
            ? raw(html`<ul>${raw(reasons)}</ul>`)
            : raw(html`<p class="muted">No risk reasons recorded.</p>`)}
          <div class="guard-results"><strong>Guard results</strong><div>${raw(checkTags || '<span class="muted">No check results yet.</span>')}</div></div>
        </section>
        ${raw(coverageBody)}
        <section class="card">
          <div class="card-title">Reviews</div>
          ${raw(reviewRows)}
        </section>
        ${writable ? raw(html`<section class="card review-form-card" id="decide">
          <div class="card-title">Submit a review</div>
          <form method="post" action="${raw(`${path}/review`)}">
            ${raw(csrf)}
            <input type="hidden" name="headSha" value="${change.headSha ?? ''}" />
            <label for="review-body">Review note</label>
            <textarea id="review-body" name="body" rows="6" maxlength="65536" ${raw(approvalNoteRequired ? 'required' : '')} placeholder="Add a note: overrides and change requests record why."></textarea>
            <p class="muted">Required for change requests and approvals that answer an open escalation; optional for a plain approval.</p>
            <div class="review-actions">
              <button class="btn primary" type="submit" name="verdict" value="approve">Approve</button>
              <button class="btn primary" type="submit" name="ship" value="1"${draft ? ' disabled' : ''}>Approve &amp; ship</button>
              <button class="btn" type="submit" name="verdict" value="request-changes">Request changes</button>
              <button class="btn" type="submit" disabled aria-describedby="comment-only-note">Comment</button>
            </div>
            <p id="comment-only-note" class="muted">Comment-only reviews are not supported by the current review service.</p>
            ${draft ? raw(html`<p class="muted">Draft changes cannot be shipped until the merge policy changes.</p>`) : ''}
          </form>
        </section>`) : ''}
      </main>
      <aside class="change-review-side">
        ${raw(remainingPanel(remaining, change.state, change.queueState, resolved.viewer?.agent !== undefined))}
        <section class="card"><div class="card-title">Checks</div>${raw(checkRows(change))}</section>
        <section class="card"><div class="card-title">Mergeability</div>
          <p>${change.mergeability ? raw(stateTag(change.mergeability.status)) : html`<span class="muted">Not available for this state.</span>`}</p>
          ${change.mergeability?.unknownReason ? raw(html`<p class="muted">${change.mergeability.unknownReason}</p>`) : ''}
          ${change.mergeability?.conflicts?.length ? raw(html`<ul>${raw(change.mergeability.conflicts.map((conflict) => `<li><code>${escapeHtml(conflict.path)}</code></li>`).join(''))}</ul>`) : ''}
        </section>
        <section class="card" id="reviewers"><div class="card-title">Policy & reviewers</div>
          <p>${reviewPacket.policy.requiredReviews} required approval(s); ${reviewPacket.policy.humanApprovalsRequired} human approval(s).</p>
          <p class="muted">${reviewPacket.policy.protected ? 'Protected target' : 'No protected-target rule'} · ${reviewPacket.policy.branchRules.length} branch rule(s)</p>
          <p class="muted">Agent approvals: ${reviewPacket.policy.agentApprovals === 'low-risk' ? 'different-family agents may count when the head has no scrutinize files.' : 'off; agent approvals do not count toward protected-branch approvals.'}</p>
          <h3>Suggested reviewers</h3>
          ${reviewPacket.suggestedReviewers.filter((reviewer) => reviewer.reason !== 'requested').length
            ? raw(html`<ul class="k-list reviewer-suggestions">${raw(reviewPacket.suggestedReviewers.filter((reviewer) => reviewer.reason !== 'requested').map((reviewer) => html`
                <li class="reviewer-suggestion">
                  <div class="reviewer-suggestion-copy">
                    <div class="reviewer-suggestion-identity"><strong>${reviewer.login}</strong><span class="tag">${reviewer.kind}</span></div>
                    <span class="reviewer-suggestion-reason muted">Reviewed these paths · ${reviewer.reviewedPaths} overlapping ${reviewer.reviewedPaths === 1 ? 'path' : 'paths'}</span>
                  </div>
                  ${writable ? raw(html`<form method="post" action="${raw(`${path}/review-requests`)}" class="inline reviewer-request-form reviewer-suggestion-request">
                    ${raw(csrf)}
                    <input type="hidden" name="principal" value="${reviewer.principal}" />
                    <button class="btn" type="submit">Request review</button>
                  </form>`) : ''}
                </li>`).join(''))}</ul>`)
            : raw(html`<p class="muted">No eligible reviewer suggestions.</p>`)}
          <h3>Requested reviewers</h3>
          ${requestedReviewers.length
            ? raw(html`<ul class="k-list">${raw(requestedReviewers.map((reviewer) => html`
                <li><strong>${reviewer.login ?? reviewer.principal}</strong>
                  ${writable ? raw(html`<form method="post" action="${raw(`${path}/review-requests/${encodeURIComponent(reviewer.principal)}/withdraw`)}" class="inline reviewer-request-form">
                    ${raw(csrf)}
                    <button class="btn" type="submit">Withdraw</button>
                  </form>`) : ''}
                </li>`).join(''))}</ul>`)
            : raw(html`<p class="muted">No reviewers requested.</p>`)}
          <pre class="k-term m-agent"><code>kvarm review request --repo ${resolved.repo.owner_login}/${resolved.repo.name} ${change.number} &lt;principal&gt;</code></pre>
        </section>
        ${raw(provenancePanel(provenance, { heading: `Provenance · head ${reviewPacket.headSha?.slice(0, 10) ?? '—'}` }))}
        <section class="card" id="escalations"><div class="card-title">Escalations</div>
          ${reviewPacket.escalations.length
            ? raw(html`<ul class="k-list">${raw(reviewPacket.escalations.map((item) => html`<li><span class="tag ${item.state === 'open' ? 'err' : 'muted'}">${item.state}</span> ${item.reason}${item.detail ? ` · ${item.detail}` : ''}${raw(item.state === 'resolved' ? html`<p class="k-resolution-history">Resolved by ${item.resolvedBy ?? 'unknown'}${item.note ? ` · ${item.note}` : ''}</p>` : '')}${raw(item.state === 'open' && canResolve ? html`
                <form method="post" action="${raw(`${path}/escalations/${encodeURIComponent(item.id)}/resolve`)}" class="inline">
                  ${raw(csrf)}
                  <input type="hidden" name="back" value="change" />
                  <label for="resolution-${item.id}">Resolution note</label>
                  <textarea id="resolution-${item.id}" name="note" rows="2" required maxlength="4000" placeholder="What changed, or why it's safe to proceed"></textarea>
                  <p class="muted k-resolution-help">Required. Recorded in the ledger as the reason.</p>
                  <button class="btn" type="submit" name="resolution" value="resolve">Resolve</button>
                </form>` : '')}</li>`).join(''))}</ul>`)
            : raw(html`<p class="muted">No escalations.</p>`)}
        </section>
      </aside>
    </div></div>`;
  return page(c, resolved, `#${change.number} · ${change.title}`, body, 'review');
}

changePages.get('/changes/:number', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  return renderDetail(c, resolved, c.req.param('number'));
});

changePages.post('/changes/:number/ack', async (c) => {
  const number = c.req.param('number');
  const url = `/${c.req.param('owner')}/${c.req.param('repo')}/changes/${number}`;
  const auth = await authorizeRoute(c, 'write', { requireActor: true, allowAgent: true });
  if (!auth.ok || !auth.actor) return notFound(c);
  const form = await c.req.parseBody({ all: true });
  const single = (value: unknown) => Array.isArray(value) ? value[value.length - 1] : value;
  const keysValue = form.keys;
  const keys = (Array.isArray(keysValue) ? keysValue : keysValue === undefined ? [] : [keysValue])
    .filter((value): value is string => typeof value === 'string');
  const cx: changes.ChangeContext = {
    env: c.env,
    repo: auth.repo,
    actor: auth.actor,
    writeAccess: true,
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  };
  const result = await reviewGuide.ackUnits(cx, number, {
    headSha: single(form.headSha),
    keys,
  });
  return c.redirect(`${url}?${result.ok ? 'done=ack' : `error=${encodeURIComponent(result.code ?? 'FAILED')}`}#review-guide`, 303);
});

changePages.post('/changes/:number/review', async (c) => {
  const number = c.req.param('number');
  const url = `/${c.req.param('owner')}/${c.req.param('repo')}/changes/${number}`;
  const form = await c.req.parseBody({ all: true });
  const field = (name: string): unknown => {
    const value = form[name];
    return Array.isArray(value) ? value[value.length - 1] : value;
  };
  const auth = await authorizeRoute(c, 'write', { requireActor: true, branchRules: true });
  if (!auth.ok || !auth.actor) return notFound(c);
  const key = `ch/${auth.repo.owner_login}/${auth.repo.name}/${number}`;
  const back = field('back');
  const submittedCursor = field('cursor');
  const inbox = back === 'inbox';
  const cursor = typeof submittedCursor === 'string' && submittedCursor.length > 0 && submittedCursor.length <= 200
    ? `&cursor=${encodeURIComponent(submittedCursor)}`
    : '';
  const redirectDecision = (code: string | null, done: string | null): Response => {
    const query = code ? `error=${encodeURIComponent(code)}` : `done=${encodeURIComponent(done ?? 'approve')}`;
    return c.redirect(inbox
      ? `/inbox?${query}${code ? cursor : ''}&item=${encodeURIComponent(key)}#${key}`
      : `${url}?${query}#decide`, 303);
  };
  const submittedShip = field('ship');
  const submittedVerdict = field('verdict');
  const verdict = submittedVerdict ?? (submittedShip === '1' ? 'approve' : undefined);
  if (verdict !== 'approve' && verdict !== 'request-changes') {
    return redirectDecision('INVALID_VERDICT', null);
  }
  const cx: changes.ChangeContext = {
    env: c.env,
    repo: auth.repo,
    actor: auth.actor,
    branchRules: auth.branchRules ?? [],
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  };
  const result = await decideFromPage(cx, number, {
    kind: 'review',
    verdict,
    headSha: typeof field('headSha') === 'string' && String(field('headSha')).length > 0 ? String(field('headSha')) : null,
    ship: submittedShip === '1',
  }, field('note') ?? field('body'));
  if (!result.ok) {
    return redirectDecision(result.code ?? 'FAILED', null);
  }
  await forgetInboxCount(auth.actor.user.id);
  if (result.value.noteProvided && !result.value.decision) {
    return redirectDecision('DECISION_NOT_RECORDED', null);
  }
  return redirectDecision(null, submittedShip === '1' ? 'ship' : verdict);
});

changePages.post('/changes/:number/review-requests', async (c) => {
  const number = c.req.param('number');
  const url = `/${c.req.param('owner')}/${c.req.param('repo')}/changes/${number}`;
  const auth = await authorizeRoute(c, 'write', { requireActor: true, allowAgent: true, branchRules: true });
  if (!auth.ok || !auth.actor) return notFound(c);
  const form = await c.req.parseBody({ all: true });
  const rawPrincipal = form.principal;
  const principal = Array.isArray(rawPrincipal) ? rawPrincipal[rawPrincipal.length - 1] : rawPrincipal;
  const cx: changes.ChangeContext = {
    env: c.env,
    repo: auth.repo,
    actor: auth.actor,
    writeAccess: true,
    branchRules: auth.branchRules ?? [],
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  };
  const result = await reviews.requestReview(cx, number, { principal });
  return c.redirect(`${url}?${result.ok ? 'done=review-requested' : `error=${encodeURIComponent(result.code ?? 'FAILED')}`}#reviewers`, 303);
});

changePages.post('/changes/:number/review-requests/:principal/withdraw', async (c) => {
  const number = c.req.param('number');
  const url = `/${c.req.param('owner')}/${c.req.param('repo')}/changes/${number}`;
  const auth = await authorizeRoute(c, 'write', { requireActor: true, allowAgent: true, branchRules: true });
  if (!auth.ok || !auth.actor) return notFound(c);
  const cx: changes.ChangeContext = {
    env: c.env,
    repo: auth.repo,
    actor: auth.actor,
    writeAccess: true,
    branchRules: auth.branchRules ?? [],
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  };
  const principal = decodeURIComponent(c.req.param('principal'));
  const result = await reviews.withdrawReviewRequest(cx, number, principal);
  return c.redirect(`${url}?${result.ok ? 'done=review-request-withdrawn' : `error=${encodeURIComponent(result.code ?? 'FAILED')}`}#reviewers`, 303);
});
