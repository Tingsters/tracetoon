/** A self-contained local HTML preview that looks roughly like a GitHub PR. */
import { marked } from 'marked';
import type { Approval } from '../commands/publish.ts';
import type { TraceDigest } from '../digest/build.ts';

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
}): string {
  const { title, body, approval, digest } = input;
  // Hidden metadata comments are kept in the HTML as comments; GitHub hides them too.
  const html = marked.parse(body, { async: false, gfm: true }) as string;
  const findings = approval.findings.length
    ? `<p class="warn">Leak scan: ${approval.findings.map((f) => `${esc(f.kind)}×${f.count}`).join(', ')}</p>`
    : '<p class="ok">Leak scan: clean</p>';
  const policy =
    approval.policy === 'prohibited'
      ? '<p class="warn">This repository appears to prohibit AI-assisted contributions.</p>'
      : '';
  const sessions = digest.sessions
    .map(
      (s) =>
        `<li>${esc(s.agent)} | ${esc(s.title ?? s.ref)} | ${s.band} (${s.score})</li>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | Tracetoon preview</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--code:#f6f8fa;--accent:#0969da;--warn:#9a6700;--ok:#1a7f37}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--border:#3d444d;--code:#151b23;--accent:#4493f8;--warn:#d29922;--ok:#3fb950}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px}
h1.title{font-size:28px;font-weight:400;margin:0 0 8px}
.meta{color:var(--muted);font-size:14px;margin-bottom:16px}
.card{border:1px solid var(--border);border-radius:6px;padding:16px 24px}
.card img{max-width:100%}
pre,code{background:var(--code);border-radius:6px;font-size:85%}pre{padding:12px;overflow:auto}code{padding:.2em .4em}pre code{padding:0}
table{border-collapse:collapse}td,th{border:1px solid var(--border);padding:6px 12px}
a{color:var(--accent)}.warn{color:var(--warn)}.ok{color:var(--ok)}
aside{margin-top:24px;font-size:14px;color:var(--muted);border-top:1px solid var(--border);padding-top:12px}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:20px;color:var(--fg)}
</style></head><body><main>
<h1 class="title">${esc(title)}</h1>
<div class="meta">${approval.mode === 'edit' ? `Updates PR #${approval.prNumber}` : 'New pull request'} | ${esc(approval.head)} -> ${esc(approval.base)}</div>
<div class="card">${html}</div>
<aside>
${findings}${policy}
<p>Sessions used:</p><ul>${sessions || '<li>none</li>'}</ul>
<p>Approval code: <span class="code">${esc(approval.code)}</span></p>
<p>Nothing has been posted. Tell your agent to publish with this code once you're happy.</p>
</aside>
</main></body></html>
`;
}
