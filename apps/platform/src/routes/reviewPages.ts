/**
 * The human review inbox and escalation-resolution post.
 *
 * Thin adapters: the inbox and decide flow are services
 * (services/reviewInbox.ts, services/reviews.ts). Repository authority uses the shared page lookup,
 * so agent tokens and non-api PATs act as anonymous
 * and a repository the viewer cannot see answers 404.
 *
 * Page CSRF is enforced by the global middleware before this router.
 *
 * Escaping convention: user data is interpolated bare into html`` (escaped
 * once); composed fragments and pre-encoded URLs go through raw().
 */

import { Hono, type Context } from 'hono';
import { html, raw, timeAgo } from '@kvarm/ui';
import { listReposForOwner, type RepoRow } from '../db/repos';
import { appLayout, csrfInput } from '../web/render';
import { evidenceBadge } from '../render/provenance';
import { clientIp, requestCredential, requestSession, type ApiActor, type App } from './api';
import { notFound } from './repoPages';
import { resolvePageActor, resolveRepoAccess } from '../services/access';
import { parseNumber, type ChangeContext } from '../services/changes';
import { forgetInboxCount, rememberInboxCount } from '../services/inboxCount';
import { decideFromPage, decisionErrorMessage, INBOX_LIMITS, reviewInbox, type InboxGroup, type InboxItem, type PageDecision } from '../services/reviewInbox';
import { staleApprovals, type EscalationView, type ReviewView } from '../services/reviews';

/** Mounted at `/inbox`, ahead of the generic web routes. */
export const inboxPages = new Hono<App>();
/** Mounted at `/:owner/:repo` for escalation resolution only. */
export const reviewPages = new Hono<App>();

const HTML = { 'content-type': 'text/html; charset=utf-8' };

const REASON_LABEL: Record<InboxGroup['reason'], string> = {
  requested: 'Requested of you',
  'reviewer-disagreement': 'Reviewers disagree',
  'review-blocked': 'Changes requested',
  'protected-path': 'Protected target',
  'final-selection': 'Arena final selection',
  'approvals-required': 'Awaiting approval',
};

const REASON_HELP: Record<InboxGroup['reason'], string> = {
  requested: 'A reviewer request names you on this change.',
  'reviewer-disagreement': 'One reviewer approved the head another asked to change. A human settles it.',
  'review-blocked': 'A reviewer asked for changes. Approve the head to overrule, or resolve with a note.',
  'protected-path': 'The change targets a protected branch. A human signs off before it can publish.',
  'final-selection': 'An arena picked this change as its winner. Confirm the pick before it publishes.',
  'approvals-required': 'The review policy wants more approving reviews of the current head.',
};

/** Outcome and error codes a decide post redirects with; anything else reads as a generic failure. */
const DONE_TEXT: Record<string, string> = {
  approve: 'Approved. Any note is on the record.',
  ship: 'Approved and queued to ship.',
  'request-changes': 'Changes requested. The decision and your note are on the record.',
  resolve: 'Escalation resolved. The decision and your note are on the record.',
};

const short = (sha: string | null): string => (sha ? sha.slice(0, 10) : '—');
const repoBase = (owner: string, name: string): string => `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
const changeHref = (owner: string, name: string, n: number): string => `${repoBase(owner, name)}/changes/${n}`;
const compareHref = (owner: string, name: string, base: string, head: string | null): string =>
  `${repoBase(owner, name)}/compare/${encodeURIComponent(`${base}...${head ?? base}`)}`;

/** An inbox item's anchor: owner and name never contain `/`, so it is unambiguous. */
const itemKey = (owner: string, name: string, n: number): string => `ch/${owner}/${name}/${n}`;

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: HTML });
}

async function csrfField(c: Context<App>): Promise<string> {
  return csrfInput((await requestSession(c))?.csrfToken);
}

/** An unparseable body reads as an empty form, which a session post then fails for its missing token. */
async function readForm(c: Context<App>): Promise<Record<string, unknown>> {
  return (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
}

function errorNote(error: string): string {
  const message = decisionErrorMessage(error);
  return html`<div class="k-note risk" role="alert">${message.text}${message.fallback ? raw(html` <code>${error}</code>`) : ''}</div>`;
}

function flash(c: Context<App>, inline = false): string {
  const done = c.req.query('done');
  // An error that names an inbox item shown on this page is rendered next to that item instead.
  const error = inline ? undefined : c.req.query('error');
  if (done && Object.hasOwn(DONE_TEXT, done)) return html`<div class="k-note signal" role="status">${DONE_TEXT[done]}</div>`;
  return error ? errorNote(error) : '';
}

function reviewer(r: ReviewView): string {
  return r.reviewer.agent ? r.reviewer.agent.name : r.reviewer.login;
}

function verdictTag(r: ReviewView): string {
  return r.verdict === 'approve' ? '<span class="tag tag-approved">approve</span>' : '<span class="tag tag-failed">request changes</span>';
}

function familyLabel(family: string | null, evidence: ReviewView['modelFamilyEvidence']): string {
  if (!family) return '<span class="k-prov-none">family not declared</span>';
  return html`<code>${family}</code> ${raw(evidenceBadge(evidence))}`;
}

function staleTag(r: ReviewView, stale: ReadonlySet<ReviewView>): string {
  return !stale.has(r) ? '' : html`<span class="tag tag-stale" title="Reviewed ${short(r.headSha)}; the head has moved, so this no longer counts">stale · ${short(r.headSha)}</span>`;
}

function noteField(id: string, label: string, required = true, placeholder = 'Add a note: overrides and change requests record why.'): string {
  return html`
    <div class="k-field">
      <label for="${id}">${label}${required ? raw(html` <span class="k-req">required</span>`) : ''}</label>
      <textarea id="${id}" name="note" rows="3" ${raw(required ? 'required' : '')} maxlength="${INBOX_LIMITS.noteMax}" placeholder="${placeholder}"></textarea>
    </div>`;
}

/** The inbox page a decide form came from, so a failed decision returns to the same page. */
function cursorField(cursor: string | null): string {
  return cursor ? html`<input type="hidden" name="cursor" value="${cursor}" />` : '';
}

function reviewForm(owner: string, name: string, n: number, headSha: string | null, csrf: string, back: 'inbox' | 'change', idBase: string, cursor: string | null = null, noteRequired = true): string {
  return html`
    <form class="k-decide-form" method="post" action="${raw(`${changeHref(owner, name, n)}/review`)}">
      ${raw(csrf)}
      ${raw(cursorField(cursor))}
      <input type="hidden" name="headSha" value="${headSha ?? ''}" />
      <input type="hidden" name="back" value="${back}" />
      ${raw(noteField(`${idBase}-review`, `Review note for ${short(headSha)}`, noteRequired))}
      <div class="actions">
        <button class="btn btn-primary" type="submit" name="verdict" value="approve">Approve head</button>
        <button class="btn" type="submit" name="verdict" value="request-changes">Request changes</button>
      </div>
    </form>`;
}

function resolveForm(owner: string, name: string, n: number, e: EscalationView, csrf: string, back: 'inbox' | 'change', idBase: string, cursor: string | null = null): string {
  return html`
    <form class="k-decide-form" method="post" action="${raw(`${changeHref(owner, name, n)}/escalations/${encodeURIComponent(e.id)}/resolve`)}">
      ${raw(csrf)}
      ${raw(cursorField(cursor))}
      <input type="hidden" name="back" value="${back}" />
      ${raw(noteField(`${idBase}-${e.id}`, 'Resolution note', true, "What changed, or why it's safe to proceed"))}
      <p class="muted k-resolution-help">Required. Recorded in the ledger as the reason.</p>
      <div class="actions">
        <button class="btn" type="submit" name="resolution" value="resolve">Resolve</button>
      </div>
    </form>`;
}

function pageHead(eyebrow: string, title: string, accent: string, human: string, agent: string, kpis: Array<{ label: string; value: string | number; warn?: boolean }>): string {
  const stats = kpis.map((k) => html`<div><span class="hud">${k.label}</span><b class="${k.warn ? 'warn' : ''}">${k.value}</b></div>`).join('');
  return html`
    <header class="k-head">
      <div class="k-head-copy">
        <span class="hud">${eyebrow}</span>
        <h1>${title}${raw(accent ? html`<br /><span class="ink">${accent}</span>` : '')}</h1>
        <p class="lede m-human">${human}</p>
        <p class="lede m-agent k-mono">${agent}</p>
      </div>
      <div class="k-head-side"><div class="k-kpis">${raw(stats)}</div></div>
    </header>`;
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

/** The author answers to reviewers, not for them: a change's own author gets no resolve form. */
function mayResolve(authorPrincipal: string | null, viewerId: string): boolean {
  return authorPrincipal !== `user:${viewerId}`;
}

function inboxItem(item: InboxItem, csrf: string, viewerId: string, error: string | null, cursor: string | null): string {
  const { owner, name } = item.repo;
  const idBase = itemKey(owner, name, item.number);
  const escalation = item.reasons[0] !== 'approvals-required';
  const reasonTags = item.reasons
    .map((r) => html`<span class="tag ${r === 'approvals-required' ? 'tag-await' : 'tag-pending'}">${REASON_LABEL[r]}</span>`)
    .join('');
  const readinessTag = item.readiness.ready ? '' : html`<span class="tag tag-pending">${item.readiness.reason ?? 'unknown'}</span>`;
  const readinessCopy = item.readiness.reason === 'conflicted'
    ? 'Has conflicts the author must resolve.'
    : item.readiness.reason === 'checks-pending'
      ? 'Waiting on checks.'
      : item.readiness.reason === 'checks-failed'
        ? 'Checks failed.'
        : item.readiness.ready
          ? ''
          : 'Readiness could not be determined.';
  const stale = new Set(staleApprovals(item.reviews));
  const verdicts = item.reviews.length
    ? html`<ul class="k-verdicts" aria-label="Verdicts">${raw(
        item.reviews
          .map((r) => html`<li><b>${reviewer(r)}</b> ${raw(verdictTag(r))} ${raw(familyLabel(r.modelFamily, r.modelFamilyEvidence))} ${raw(staleTag(r, stale))}</li>`)
          .join(''),
      )}</ul>`
    : '<p class="k-inbox-quiet">No reviews of any head yet.</p>';
  const author = item.author.agent
    ? html`${item.author.agent.name} ${raw(familyLabel(item.author.modelFamily, item.author.modelFamilyEvidence))}`
    : html`${item.author.login ?? 'unknown'}`;
  return html`
    <article class="k-inbox-item ${escalation ? 'heat' : 'signal'}" id="${idBase}">
      <div class="k-inbox-body">
        <span class="hud"><span class="ident">${owner}/${name}</span> · #${item.number} · into <span class="ident">${item.base}</span> · ${timeAgo(item.createdAtMs)}</span>
        <h3><a href="${raw(changeHref(owner, name, item.number))}">${item.title}</a></h3>
        <p class="k-inbox-tags">${raw(reasonTags)}${raw(readinessTag)}<span class="tag">approvals ${item.approvals.count}/${item.approvals.required}</span>${raw(
          item.approvals.humansRequired ? html`<span class="tag">human ${item.approvals.humans}/${item.approvals.humansRequired}</span>` : '',
        )}${raw(
          item.staleApprovals ? html`<span class="tag tag-stale">${item.staleApprovals} stale</span>` : '',
        )}</p>
        ${raw(readinessCopy ? html`<p class="k-inbox-readiness">${readinessCopy}</p>` : '')}
        <p class="k-inbox-author">By ${raw(author)} · head <code>${short(item.headSha)}</code></p>
        ${raw(verdicts)}
        <p class="k-inbox-links">
          <a href="${raw(changeHref(owner, name, item.number))}">Open change</a>
          <a href="${raw(compareHref(owner, name, item.base, item.headSha))}">Risk-ordered diff</a>
          <a href="${raw(`${changeHref(owner, name, item.number)}#verdicts`)}">All verdicts</a>
        </p>
        <details class="k-decide"${raw(error ? ' open' : '')}>
          <summary class="btn btn-sm">Decide</summary>
          <div class="k-decide-body">
            ${raw(error ? errorNote(error) : '')}
            ${raw(mayResolve(item.author.principal, viewerId) ? item.openEscalations.map((e) => resolveForm(owner, name, item.number, e, csrf, 'inbox', idBase, cursor)).join('') : '')}
            ${raw(reviewForm(owner, name, item.number, item.headSha, csrf, 'inbox', idBase, cursor, item.reasons.some((reason) => reason !== 'approvals-required')))}
          </div>
        </details>
      </div>
    </article>`;
}

inboxPages.get('/', async (c) => {
  const actor = await resolvePageActor(c.env, await requestCredential(c), clientIp(c));
  if (!actor) return c.redirect('/auth/sign-in?returnTo=%2Finbox');
  const [r, repos] = await Promise.all([
    reviewInbox(c.env, actor, { limit: c.req.query('limit'), cursor: c.req.query('cursor') }),
    listReposForOwner(c.env.DB, actor.user.login, 8),
  ]);
  const layout = (body: string, inboxCount?: { count: number; more: boolean }) =>
    appLayout(
      c.env,
      { title: 'Inbox', userLogin: actor.user.login, userId: actor.user.id, repos: repos.map((x) => ({ ownerLogin: x.owner_login, name: x.name })), active: 'inbox', inboxCount },
      body,
    );
  if (!r.ok) {
    return htmlResponse(await layout(html`<div class="k-content"><div class="k-note risk" role="alert">${r.error} <code>${r.code}</code></div><p><a href="/inbox">Back to the inbox</a></p></div>`), r.status);
  }
  const inbox = r.value;
  const csrf = await csrfField(c);
  const failedItem = c.req.query('error') ? (c.req.query('item') ?? null) : null;
  const shown = new Set(inbox.groups.flatMap((g) => g.items.map((i) => itemKey(i.repo.owner, i.repo.name, i.number))));
  const inline = failedItem !== null && shown.has(failedItem);
  const failedError = inline ? (c.req.query('error') ?? null) : null;
  const cursor = c.req.query('cursor') ?? null;
  // Only the default first page is the count the badge means; a custom `limit` would count something else.
  const inboxCount = !cursor && !c.req.query('limit') ? { count: inbox.counts.changes, more: inbox.nextCursor !== null } : undefined;
  // The header badge on other pages reads this count back (services/inboxCount.ts). Awaited, so a decision
  // posted after this page loaded clears it rather than racing a late write.
  if (inboxCount) await rememberInboxCount(actor.user.id, inboxCount);
  const waiting = inbox.counts.changes;
  const head = pageHead(
    'INBOX · NEEDS A HUMAN',
    waiting ? `${waiting} CHANGE${waiting === 1 ? '' : 'S'}` : 'INBOX',
    waiting ? 'NEED YOU.' : 'CLEAR.',
    'Escalations and approvals across every repository you can review. Overrides, change requests, and escalation resolutions record why.',
    `kvarm review pending --repo <owner/repo> · ${inbox.counts.escalations} escalation · ${inbox.counts.awaitingApproval} awaiting approval`,
    [
      { label: 'Escalations', value: inbox.counts.escalations, warn: inbox.counts.escalations > 0 },
      { label: 'Awaiting approval', value: inbox.counts.awaitingApproval },
      { label: 'Stale approvals', value: inbox.counts.staleApprovals, warn: inbox.counts.staleApprovals > 0 },
      { label: 'Repositories', value: inbox.repositories },
    ],
  );
  const truncated =
    inbox.truncatedReason === 'repositories'
      ? html`<div class="k-note warn" role="note">Showing the ${INBOX_LIMITS.reposMax} most recently pushed repositories you can review; others are not scanned on this page.</div>`
      : inbox.truncatedReason === 'admin-window'
        ? html`<div class="k-note warn" role="note">As instance admin you see your own repositories and the ${INBOX_LIMITS.adminReposWindow} most recently pushed; older ones are not scanned on this page.</div>`
        : '';
  const groups = inbox.groups
    .map(
      (g) => html`
      <section class="panel" aria-labelledby="g-${g.reason}">
        <div class="panel-head"><h2 class="hud k-panel-title" id="g-${g.reason}">${REASON_LABEL[g.reason]} · <b>${g.items.length}</b></h2></div>
        <p class="k-group-help">${REASON_HELP[g.reason]}</p>
        ${raw(g.items
          .filter((i) => i.readiness.ready || i.reasons[0] !== 'approvals-required')
          .map((i) => inboxItem(i, csrf, actor.user.id, itemKey(i.repo.owner, i.repo.name, i.number) === failedItem ? failedError : null, cursor)).join(''))}
        ${raw(g.items.some((i) => !i.readiness.ready && i.reasons[0] === 'approvals-required')
          ? html`<details class="not-ready-group"><summary>Not ready yet</summary>${raw(g.items
              .filter((i) => !i.readiness.ready && i.reasons[0] === 'approvals-required')
              .map((i) => inboxItem(i, csrf, actor.user.id, itemKey(i.repo.owner, i.repo.name, i.number) === failedItem ? failedError : null, cursor)).join(''))}</details>`
          : '')}
      </section>`,
    )
    .join('');
  const empty = html`
    <section class="panel" aria-labelledby="empty-h">
      <div class="panel-head"><h2 class="hud k-panel-title" id="empty-h">NOTHING WAITING</h2></div>
      <div class="k-empty">
        <p class="m-human">Nothing needs a human right now. When reviewers disagree, ask for changes, or a protected branch needs sign-off, the change lands here.</p>
        <pre class="k-term m-agent"><code>kvarm review pending --repo &lt;owner/repo&gt;
kvarm review approve &lt;number&gt; --repo &lt;owner/repo&gt;</code></pre>
      </div>
    </section>`;
  const pager = inbox.nextCursor
    ? html`<nav class="k-pager" aria-label="Inbox pages"><a class="btn" href="${`/inbox?cursor=${encodeURIComponent(inbox.nextCursor)}${c.req.query('limit') ? `&limit=${encodeURIComponent(c.req.query('limit')!)}` : ''}`}">Older changes</a></nav>`
    : c.req.query('cursor')
      ? '<nav class="k-pager" aria-label="Inbox pages"><a class="btn" href="/inbox">Back to newest</a></nav>'
      : '';
  const body = html`
    ${raw(head)}
    <div class="k-content">
      ${raw(flash(c, inline))}
      ${raw(truncated)}
      ${raw(
        groups ||
          (inbox.nextCursor
            ? '<div class="k-note signal" role="status">None of the changes scanned for this page needs you. Older changes are still to check.</div>'
            : c.req.query('cursor')
              ? '<div class="k-empty">No older changes need you.</div>'
              : empty),
      )}
      ${raw(pager)}
    </div>`;
  return htmlResponse(await layout(body, inboxCount));
});

// ---------------------------------------------------------------------------
// Decide posts
// ---------------------------------------------------------------------------

/** Write authority with the branch rules the review service's auto merge needs, on the page transport. */
async function writeAccess(c: Context<App>): Promise<{ cx: ChangeContext; actor: ApiActor } | null> {
  const access = await resolveRepoAccess(c.env, {
    owner: c.req.param('owner') ?? '',
    name: c.req.param('repo') ?? '',
    need: 'write',
    transport: 'page',
    credential: await requestCredential(c),
    clientIp: clientIp(c),
    rejectedCredentialAsAnonymous: true,
    branchRules: true,
  });
  if (!access.ok || !access.actor) return null;
  return {
    actor: access.actor,
    cx: { env: c.env, repo: access.repo, actor: access.actor, branchRules: access.branchRules ?? [], waitUntil: (p) => c.executionCtx.waitUntil(p) },
  };
}

/** Back to the inbox entry or the change page; the target is built here, never taken from the form. */
function afterDecision(
  c: Context<App>,
  repo: RepoRow,
  number: string,
  form: Record<string, unknown>,
  outcome: { done: string } | { error: string },
  panel: 'decide' | 'escalations',
): Response {
  const n = Number(number);
  if ('done' in outcome) {
    const query = `done=${encodeURIComponent(outcome.done)}`;
    if (form.back === 'inbox') {
      const key = itemKey(repo.owner_login, repo.name, n);
      const page = typeof form.cursor === 'string' && form.cursor.length > 0 && form.cursor.length <= 200 ? `&cursor=${encodeURIComponent(form.cursor)}` : '';
      return c.redirect(`/inbox?${query}${page}&item=${encodeURIComponent(key)}#${key}`, 303);
    }
    return c.redirect(`${changeHref(repo.owner_login, repo.name, n)}?${query}`, 303);
  }
  // A failed decision returns the reader to the form they used, with the error next to it.
  const query = `error=${encodeURIComponent(outcome.error)}`;
  if (form.back === 'inbox') {
    const key = itemKey(repo.owner_login, repo.name, n);
    const page = typeof form.cursor === 'string' && form.cursor.length > 0 && form.cursor.length <= 200 ? `&cursor=${encodeURIComponent(form.cursor)}` : '';
    return c.redirect(`/inbox?${query}${page}&item=${encodeURIComponent(key)}#${key}`, 303);
  }
  return c.redirect(`${changeHref(repo.owner_login, repo.name, n)}?${query}#${panel}`, 303);
}

/** `toDecision` answers the form's decision, or the error code that refuses it. */
async function decide(c: Context<App>, toDecision: (form: Record<string, unknown>) => PageDecision | string, label: (d: PageDecision) => string): Promise<Response> {
  const w = await writeAccess(c);
  if (!w) return notFound(c);
  const form = await readForm(c);
  const number = c.req.param('number') ?? '';
  if (parseNumber(number) === null) return notFound(c);
  const d = toDecision(form);
  const panel = c.req.param('id') ? 'escalations' : 'decide';
  if (typeof d === 'string') return afterDecision(c, w.cx.repo, number, form, { error: d }, panel);
  const r = await decideFromPage(w.cx, number, d, form.note);
  if (!r.ok) {
    if (r.code === 'CHANGE_NOT_FOUND') return notFound(c);
    return afterDecision(c, w.cx.repo, number, form, { error: r.code ?? 'FAILED' }, panel);
  }
  // The remembered inbox count is now out of date; the next /inbox recounts.
  await forgetInboxCount(w.actor.user.id);
  if (r.value.noteProvided && !r.value.decision) return afterDecision(c, w.cx.repo, number, form, { error: 'DECISION_NOT_RECORDED' }, panel);
  return afterDecision(c, w.cx.repo, number, form, { done: label(d) }, panel);
}

reviewPages.post('/changes/:number/escalations/:id/resolve', (c) =>
  decide(
    c,
    () => ({ kind: 'resolve', escalationId: c.req.param('id') ?? '' }),
    () => 'resolve',
  ),
);
