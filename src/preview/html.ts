/** A self-contained local HTML preview that looks roughly like a GitHub PR. */
import { marked } from 'marked';
import type { Approval } from '../commands/publish.ts';
import type { TraceDigest } from '../digest/build.ts';
import { claimSummary, type ClaimFinding } from '../digest/claims.ts';
import type { ContextNote } from '../digest/notes.ts';
import type { TitleFinding } from '../digest/titleCheck.ts';
import type { AiPolicy } from '../github/repoContext.ts';
import type { ReviewResult } from '../contribution/types.ts';
import { bodyReviewLines } from '../contribution/bodyReview.ts';
import { comicReviewLines } from '../contribution/comicReview.ts';
import type { ChangeMapFinding } from '../digest/changeMap.ts';

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const ALLOWED_TAGS = new Set([
  'details',
  'summary',
  'img',
  'br',
  'sub',
  'sup',
  'kbd',
  'picture',
  'source',
  'p',
  'div',
  'span',
  'b',
  'i',
  'em',
  'strong',
  'hr',
]);
const ALLOWED_ATTRS = new Set([
  'src',
  'srcset',
  'alt',
  'title',
  'width',
  'height',
  'align',
  'open',
  'media',
]);

/** Keep the small set of HTML GitHub allows in PR bodies; escape anything else. */
export function sanitizeHtml(html: string): string {
  if (/^\s*<!--[\s\S]*-->\s*$/.test(html)) return html; // comments (our metadata) stay hidden
  return html.replace(
    /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>|<!--[\s\S]*?-->|[<>]/g,
    (m, tag: string, attrs: string) => {
      if (m.startsWith('<!--')) return m;
      if (!tag) return esc(m);
      const name = tag.toLowerCase();
      if (!ALLOWED_TAGS.has(name)) return esc(m);
      if (m.startsWith('</')) return `</${name}>`;
      const kept: string[] = [];
      for (const a of attrs.matchAll(
        /([a-zA-Z-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g,
      )) {
        const key = a[1]!.toLowerCase();
        if (!ALLOWED_ATTRS.has(key)) continue;
        const value = (a[2] ?? '').replace(/^["']|["']$/g, '');
        if (
          (key === 'src' || key === 'srcset') &&
          !/^(https?:|\.{0,2}\/|[\w-]+\.(png|jpe?g|gif|webp|svg))/i.test(value)
        )
          continue;
        kept.push(a[2] === undefined ? key : `${key}="${esc(value)}"`);
      }
      return `<${name}${kept.length ? ' ' + kept.join(' ') : ''}>`;
    },
  );
}

marked.use({ renderer: { html: ({ text }: { text: string }) => sanitizeHtml(text) } });

export function renderPreviewHtml(input: {
  title: string;
  body: string;
  approval: Approval;
  digest: TraceDigest;
  /** Rendered comic bytes, supplied by the CLI rather than by PR HTML. */
  previewComic?: { src: string; data: string };
  /** The comic as it would look in a social post (image path and caption). */
  share?: { image: string; caption: string };
  /** Advisory claim-check findings, shown beside the sentences they're about. */
  claims?: ClaimFinding[];
  /** Optional, skippable notes about facts a reviewer may want. */
  notes?: ContextNote[];
  /** The repo's AI policy, read heuristically. */
  policy?: AiPolicy;
  /** An outline of the evidence, for authors who write the text themselves. */
  outline?: string;
  /** The comic exists but the repo doesn't allow AI-generated images. */
  comicHeldBack?: boolean;
  /** Advisory checks on the title. */
  titleFindings?: TitleFinding[];
  /** Why the title shown isn't the one proposed (a person's title kept). */
  titleNote?: string;
  contributionReview?: ReviewResult;
  /** Advisory checks on the drafter's local change map. */
  changeMapFindings?: ChangeMapFinding[];
}): string {
  const {
    title,
    body,
    approval,
    digest,
    share,
    claims = [],
    notes = [],
    policy,
    outline,
    comicHeldBack,
    titleFindings = [],
    titleNote,
    contributionReview,
    previewComic,
    changeMapFindings = [],
  } = input;
  // Hidden metadata comments are kept in the HTML as comments; GitHub hides them too.
  const marked_ = annotateClaims(body, claims);
  const sanitized = marked_.place(
    marked.parse(marked_.body, { async: false, gfm: true }) as string,
  );
  // Embedding before Markdown parsing loses the data URL to sanitizeHtml. Keep
  // arbitrary data URLs blocked and insert only this render's approved image afterward.
  const html = previewComic
    ? sanitized.replaceAll(`src="${previewComic.src}"`, `src="${esc(previewComic.data)}"`)
    : sanitized;
  const findings = approval.findings.length
    ? `<p class="warn">Leak scan: ${approval.findings.map((f) => `${esc(f.kind)}×${f.count}`).join(', ')}</p>`
    : '<p class="ok">Leak scan: clean</p>';
  const policyWarn =
    approval.policy === 'prohibited'
      ? '<p class="warn">This repository appears to prohibit AI-assisted contributions.</p>'
      : '';
  const evidence = evidenceHtml(digest);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | Tracetoon preview</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--code:#f6f8fa;--accent:#0969da;--warn:#9a6700;--ok:#1a7f37}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--border:#3d444d;--code:#151b23;--accent:#4493f8;--warn:#d29922;--ok:#3fb950}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px;overflow-wrap:anywhere}
h1.title{font-size:28px;font-weight:400;margin:0 0 8px}
.meta{color:var(--muted);font-size:14px;margin-bottom:16px}
.card{border:1px solid var(--border);border-radius:6px;padding:16px 24px}
.card img{max-width:100%}
pre,code{background:var(--code);border-radius:6px;font-size:85%}pre{padding:12px;overflow:auto}code{padding:.2em .4em}pre code{padding:0}
table{border-collapse:collapse}td,th{border:1px solid var(--border);padding:6px 12px}
a{color:var(--accent)}.warn{color:var(--warn)}.ok{color:var(--ok)}
aside{margin-top:24px;font-size:14px;color:var(--muted);border-top:1px solid var(--border);padding-top:12px}
.evidence{color:var(--fg)}.evidence h2{font-size:16px;margin:16px 0 4px}.evidence h3{font-size:14px;margin:12px 0 4px}
.evidence ul{margin:4px 0;padding-left:20px}.evidence li{margin:2px 0}.evidence .n{color:var(--muted)}
.claim{font-size:11px;font-weight:600;padding:0 4px;border-radius:8px;margin-left:2px;vertical-align:super;text-decoration:none}
.claim.contradicted{background:#ffebe9;color:#cf222e}.claim.not-established{background:#fff8c5;color:#9a6700}
.policy{border:1px solid var(--border);border-left:4px solid var(--warn);border-radius:6px;padding:8px 12px;margin:0 0 12px;font-size:14px}
.checks{margin-top:12px;font-size:14px;color:var(--muted)}.checks li{margin:4px 0}.checks b{color:var(--fg)}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:20px;color:var(--fg)}
.social{margin-top:24px}.social h2{font-size:16px;margin:0 0 8px}
.phone{max-width:380px;border:1px solid var(--border);border-radius:16px;padding:12px;background:var(--code)}
.phone img{width:100%;border-radius:8px;display:block}.phone p{margin:8px 2px 0;font-size:14px;white-space:pre-wrap}
</style></head><body><main>
<h1 class="title">${esc(title)}</h1>
<div class="meta">${approval.mode === 'edit' ? `Updates PR #${approval.prNumber}` : 'New pull request'} | ${esc(approval.head)} -> ${esc(approval.base)} | ${title.length} characters</div>
${titleNote ? `<p class="checks">${esc(titleNote)}</p>` : ''}
${
  titleFindings.length
    ? `<section class="checks"><p><b>Title check</b> (advisory):</p><ul>${titleFindings.map((f) => `<li>${esc(f.state)} (${esc(f.check)}): ${esc(f.reason)}</li>`).join('')}</ul></section>`
    : ''
}
${policyHtml(policy, comicHeldBack)}
<div class="card">${html}</div>
${marked_.notes}
${contributionReview?.bodyReview ? `<section class="checks">${bodyReviewLines(contributionReview.bodyReview).map(esc).join('<br>')}</section>` : ''}
${
  changeMapFindings.length
    ? `<section class="checks"><p><b>Change map</b> (advisory):</p><ul>${changeMapFindings.map((f) => `<li>${esc(f.text)}</li>`).join('')}</ul></section>`
    : ''
}
${contributionReview?.comicReview ? `<section class="checks">${comicReviewLines(contributionReview.comicReview).map(esc).join('<br>')}</section>` : ''}
${contributionReview ? contributionReviewHtml(contributionReview) : ''}
${digest.validation?.length ? `<section class="checks"><p><b>Local validation before author review</b></p><ul>${digest.validation.map((c) => `<li><b>${esc(c.name)}</b>: ${esc(c.outcome)}${c.current ? '' : ' (stale)'} — ${esc(c.command || 'not run')}; ${c.durationMs}ms${c.reason ? `<br>${esc(c.reason)}` : ''}</li>`).join('')}</ul></section>` : ''}
${
  notes.length
    ? `<section class="checks"><p><b>Optional additions</b> (skip any that don't apply; "not captured" doesn't mean "not done"):</p><ul>${notes.map((n) => `<li>${esc(n.text)}</li>`).join('')}</ul></section>`
    : ''
}

${
  outline
    ? `<section class="checks outline"><p><b>Notes to write from</b>: this repository asks for author-written text, so here are the facts as an outline.</p>${marked.parse(outline, { async: false, gfm: true }) as string}</section>`
    : ''
}
${
  share
    ? `<section class="social"><h2>On a phone, shared</h2><div class="phone"><img src="${esc(share.image)}" alt="comic at phone size"><p>${esc(share.caption)}</p></div>
<p class="meta">Can every word be read at this size? Is it funny to someone outside the project? If not, ask your agent to tighten it, or to reroll the style (<code>tracetoon comic reroll</code>).</p></section>`
    : ''
}
<aside>
${findings}${policyWarn}
${evidence}
<p>Approval code: <span class="code">${esc(approval.code)}</span></p>
<p>Nothing has been posted. Tell your agent to publish with this code once you're happy.</p>
</aside>
</main></body></html>
`;
}

/** Source and assessment text is escaped, never rendered as executable markup. */
function contributionReviewHtml(review: ReviewResult): string {
  const mode =
    review.mode === 'inline'
      ? 'Inline draft / self-review'
      : review.mode === 'delegated'
        ? 'Independent host agents (reported by the host)'
        : 'Review unavailable';
  const rules = review.requirements.map((rule) => {
    const finding = review.assessments.find((a) => a.requirement === rule.id);
    const refs = rule.sources.map((ref) => {
      const source = review.sources.find((s) => s.id === ref.source);
      return `${source?.location ?? ref.source}:${ref.startLine}-${ref.endLine}`;
    });
    return `<li><b>${esc(rule.text)}</b> — ${esc(finding?.state ?? 'not assessed')}<br>${esc(rule.strength)}; applies when: ${esc(rule.appliesWhen)}${rule.exceptions.length ? `<br>Exceptions: ${esc(rule.exceptions.join('; '))}` : ''}<br>${esc(finding?.reason ?? 'No current assessment.')}${finding?.correction ? `<br>Suggested correction: ${esc(finding.correction)}` : ''}${finding?.evidence.length ? `<br>Evidence: ${esc(finding.evidence.join(', '))}` : ''}<br><small>Sources: ${esc(refs.join(', '))}</small></li>`;
  });
  return `<section class="checks"><p><b>Contributor guidance review</b> (advisory): ${esc(review.status)}. ${esc(mode)}. Guidance: ${esc(review.guidanceStatus)}.</p>${review.issues.length ? `<ul>${review.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}${rules.length ? `<details open><summary>Requirements and assessments</summary><ul>${rules.join('')}</ul></details>` : '<p>No requirements assessed; this is not a certification of compliance.</p>'}</section>`;
}

/** Captured evidence beside the draft, so its claims can be checked. */
function evidenceHtml(d: TraceDigest): string {
  const li = (items: string[], empty = 'none') =>
    `<ul>${items.length ? items.map((i) => `<li>${i}</li>`).join('') : `<li class="n">${empty}</li>`}</ul>`;
  const s = d.stats;
  const facts = [
    `${s.filesChanged} file(s) changed, +${s.added} / -${s.removed} lines`,
    `${s.agentMatchedPct}% of added lines match agent edits; ${s.unmatchedPct}% match none`,
    `${s.commitsMadeInSessions} of ${s.commits} commit(s) made during agent sessions`,
    ...d.notes.map(esc),
  ];
  const sessions = d.sessions.map((x) => {
    const tests = x.commands.filter((c) => c.isTest);
    return `<h3>${esc(x.agent)}: ${esc(x.title ?? x.ref)} <span class="n">(${x.band}, score ${x.score}${x.models.length ? `, ${esc(x.models.join(', '))}` : ''})</span></h3>
<p class="n">${esc(x.reasons.join('; '))}</p>
<b>Prompts</b>${li(x.prompts.map((p) => esc(p.text)))}
${x.plans.length ? `<b>Plans</b>${li(x.plans.map((p) => `${p.approved ? 'approved' : 'not approved'}: ${esc(p.excerpt.split('\n')[0] ?? '')}`))}` : ''}
${x.decisions.length ? `<b>Decisions</b>${li(x.decisions.map((p) => esc(p.text)))}` : ''}
<b>Tests</b>${li(
      tests.map((c) => `${esc(c.cmd)}: ${c.count} run(s), ${c.failures} failed`),
      'no test runs recorded',
    )}
<b>Milestones</b>${li(x.milestones.map(esc))}`;
  });
  return `<details class="evidence" open><summary><b>Evidence from the agent logs</b></summary>
<h2>Facts</h2>${li(facts)}
<h2>Sessions</h2>${sessions.join('') || '<p class="n">No agent sessions matched.</p>'}
<h2>Disclosure</h2>${li(d.disclosure.suggestedTrailers.map(esc), 'no AI trailer suggested')}
</details>`;
}

const CLAIM_MARK = (n: number) => `\u27e6c${n}\u27e7`;

/**
 * Put a small numbered marker after each sentence a finding is about (only the
 * ones worth a look: contradicted, or not established), and list them under the
 * draft. Markers go in as plain text first and become HTML after rendering, so
 * the description's own HTML is never trusted.
 */
export function annotateClaims(
  body: string,
  claims: ClaimFinding[],
): { body: string; place: (html: string) => string; notes: string } {
  const shown = claims.filter(
    (c) => c.state === 'contradicted' || c.state === 'not established',
  );
  let out = body;
  const placed: { n: number; c: ClaimFinding }[] = [];
  shown.forEach((c) => {
    const words = c.quote
      .replace(/[`*_]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (words.length < 2) return;
    // Match the sentence loosely: markdown markup and line breaks may sit between words.
    const re = new RegExp(words.join('[\\s`*_]+').replace(/\\\.$/, ''), 'i');
    const m = re.exec(out);
    if (!m) return;
    const n = placed.length + 1;
    let end = m.index + m[0].length;
    while (/[`*_.!?)]/.test(out[end] ?? '')) end++;
    out = out.slice(0, end) + CLAIM_MARK(n) + out.slice(end);
    placed.push({ n, c });
  });
  const place = (html: string) =>
    placed.reduce(
      (h, { n, c }) =>
        h.replace(
          CLAIM_MARK(n),
          `<a class="claim ${c.state.replace(' ', '-')}" href="#check-${n}" title="${esc(c.detail)}">${n}</a>`,
        ),
      html,
    );
  const counts = claimSummary(claims);
  const summary = claims.length
    ? `${counts.observed} supported by captured evidence, ${counts['author-reported']} reported by the author, ${counts['not established']} not established, ${counts.contradicted} contradicted.`
    : '';
  const notes = placed.length
    ? `<section class="checks"><p><b>Checks on the text</b> (advisory; logs can be incomplete, so "not established" is not "false"). ${summary}</p><ol>${placed
        .map(
          ({ n, c }) =>
            `<li id="check-${n}"><b>${c.state}</b>: ${esc(c.detail)}${c.evidence.length ? ` <span class="n">(${c.evidence.join(', ')})</span>` : ''}</li>`,
        )
        .join('')}</ol></section>`
    : summary
      ? `<section class="checks"><p><b>Checks on the text:</b> ${summary}</p></section>`
      : '';
  return { body: out, place, notes };
}

/** A compact notice of what the repo's AI policy means for this PR, with the lines it comes from. */
function policyHtml(policy: AiPolicy | undefined, comicHeldBack?: boolean): string {
  if (
    !policy ||
    (policy.verdict === 'none' &&
      !policy.noPullRequests &&
      !policy.prInstructions?.length)
  )
    return '';
  const points: string[] = [];
  if (policy.text === 'prohibited')
    points.push(
      'This repository appears to prohibit AI-written contributions. Treat the draft as notes, not something to post as is.',
    );
  else if (policy.text === 'author-written-recommended')
    points.push(
      'This repository asks authors to write PR text themselves. The outline below the draft has the facts to write from.',
    );
  if (comicHeldBack || policy.media === 'prohibited')
    points.push("AI-generated images aren't allowed here, so the comic is left out.");
  if (policy.noPullRequests)
    points.push(
      "The repo's agent instructions say never to open a PR. Only you can decide to post anyway.",
    );
  if (policy.disclosure && policy.disclosure !== 'unspecified')
    points.push(
      `A disclosure in the form the repo asks for (${policy.disclosure}) is added at the end.`,
    );
  if (!points.length)
    points.push('This repository mentions AI in its contribution docs.');
  const lines = [...policy.excerpts, ...(policy.prInstructions ?? [])].slice(0, 8);
  return `<div class="policy"><b>Repository policy:</b> ${points.map(esc).join(' ')}${
    lines.length
      ? `<details><summary>The lines this comes from</summary><ul>${lines.map((l) => `<li><code>${esc(l.file)}:${l.line}</code> ${esc(l.text)}</li>`).join('')}</ul></details>`
      : ''
  }</div>`;
}
