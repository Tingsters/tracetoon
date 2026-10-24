/** What the repo asks of a PR: its template, and any policy on AI contributions. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEMPLATE_PATHS = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md',
];
const TEMPLATE_DIRS = [
  '.github/PULL_REQUEST_TEMPLATE',
  'PULL_REQUEST_TEMPLATE',
  'docs/PULL_REQUEST_TEMPLATE',
];

export interface PrTemplate {
  path: string;
  content: string;
}

export function findPrTemplate(root: string): PrTemplate | undefined {
  for (const rel of TEMPLATE_PATHS) {
    const p = join(root, rel);
    if (existsSync(p)) return { path: rel, content: readFileSync(p, 'utf8') };
  }
  for (const dir of TEMPLATE_DIRS) {
    const d = join(root, dir);
    if (!existsSync(d)) continue;
    const first = readdirSync(d)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .sort()[0];
    if (first)
      return { path: `${dir}/${first}`, content: readFileSync(join(d, first), 'utf8') };
  }
  return undefined;
}

const POLICY_FILES = [
  'AI_POLICY.md',
  '.github/AI_POLICY.md',
  'AGENTS.md',
  '.github/AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md',
  'CONTRIBUTING.md',
  '.github/CONTRIBUTING.md',
  'docs/CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  // Projects that keep their policy in their docs.
  'Documentation/process/coding-assistants.rst',
  'llvm/docs/AIToolPolicy.md',
  'llvm/docs/AIToolPolicy.rst',
  'docs/AIToolPolicy.md',
  'docs/internals/contributing/writing-code/submitting-patches.txt',
  'contributing/ai-tools.md',
];

const AI_TERMS =
  /\b(AI|A\.I\.|LLM|LLMs|large language model|generative|copilot|chatgpt|claude|gpt|machine[- ]generated|coding assistants?|AI[- ]assisted|agents?)\b/i;
const PROHIBIT =
  /\b(not accept|do not accept|don't accept|will be rejected|prohibit\w*|forbid\w*|ban(ned)?|not allowed|not permitted|must not (use|submit)|no AI)\b/i;
const DISCLOSE =
  /\b(disclos|must (state|mention|indicate|note)|Assisted-by|AI-used-for|declare)\w*/i;
const MEDIA =
  /\b(images?|media|art(work)?|illustrations?|videos?|audio|pictures?|drawings?)\b/i;
const AUTHOR_WRITTEN =
  /\b(strongly (recommend|encourage)\w*|should|please|must|expected to)\b[^.]{0,80}\b(write|author)\w*\b[^.]{0,60}\b(descriptions?|pr text|pull request text|commit messages?|yourself|own (words|voice))\b|\b(do not|don't|never)\b[^.]{0,60}\b(auto-?|automatically )?generat\w*\b[^.]{0,40}\b(pull request|pr)s?\b[^.]{0,20}\bdescriptions?\b|\byour own (ideas|judgment|judgement|voice)\b/i;
const PR_TEXT = /\b(pull requests?|PRs?\b|commit messages?)/i;
const NO_PR = /\bnever (create|open|submit) (an? )?(issue|pr|pull request)/i;

export type PolicyVerdict = 'prohibited' | 'disclosure-required' | 'mentioned' | 'none';

export interface AiPolicy {
  verdict: PolicyVerdict;
  /** Lines that mention AI, with their file, for the agent and user to read. */
  excerpts: { file: string; line: number; text: string }[];
  /**
   * The same lines read more closely. Heuristic: the excerpts matter more than
   * the labels, and the user decides.
   *  - text: AI-written text prohibited, author-written text recommended
   *    (e.g. LLVM "strongly recommends"; not a requirement), or nothing special;
   *  - media: AI-generated images prohibited (e.g. Ghostty), which turns the comic off;
   *  - disclosure: the form the repo asks for, if it names one;
   *  - noPullRequests: an instruction to agents never to open PRs.
   */
  text?: 'prohibited' | 'author-written-recommended' | 'none';
  media?: 'prohibited' | 'none';
  disclosure?: 'assisted-by' | 'tool-and-use' | 'unspecified';
  noPullRequests?: boolean;
  /** Instructions about PR text or commit messages from agent files (AGENTS.md…). */
  prInstructions?: { file: string; line: number; text: string }[];
}

/**
 * A heuristic read of the repo's stance on AI contributions. The excerpts matter
 * more than the verdict: the skill shows them to the user, who decides.
 */
export function detectAiPolicy(root: string): AiPolicy {
  const excerpts: AiPolicy['excerpts'] = [];
  const prInstructions: NonNullable<AiPolicy['prInstructions']> = [];
  let prohibited = false;
  let disclose = false;
  let mediaBan = false;
  let authorWritten = false;
  let assistedBy = false;
  let toolAndUse = false;
  let noPullRequests = false;
  for (const rel of POLICY_FILES) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    const agentFile = /AGENTS\.md|CLAUDE\.md|copilot-instructions/i.test(rel);
    const lines = readFileSync(p, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      const t = text.trim();
      if (agentFile && PR_TEXT.test(t) && t.length > 10)
        prInstructions.push({ file: rel, line: i + 1, text: t.slice(0, 300) });
      if (NO_PR.test(t)) noPullRequests = true;
      if (!AI_TERMS.test(t) && !(agentFile && NO_PR.test(t))) return;
      excerpts.push({ file: rel, line: i + 1, text: t.slice(0, 300) });
      const bans = PROHIBIT.test(t);
      if (bans && MEDIA.test(t)) mediaBan = true;
      else if (bans) prohibited = true;
      if (AUTHOR_WRITTEN.test(t)) authorWritten = true;
      if (DISCLOSE.test(t)) disclose = true;
      if (/Assisted-by:/i.test(t)) assistedBy = true;
      if (/\b(tool|model)s?\b[^.]{0,60}\b(how|what)\b[^.]{0,40}\b(used|for)\b/i.test(t))
        toolAndUse = true;
    });
    if (rel === 'AI_POLICY.md' || rel === '.github/AI_POLICY.md') disclose = true;
  }
  const verdict: PolicyVerdict = prohibited
    ? 'prohibited'
    : disclose
      ? 'disclosure-required'
      : excerpts.length
        ? 'mentioned'
        : 'none';
  return {
    verdict,
    excerpts: excerpts.slice(0, 20),
    text: prohibited
      ? 'prohibited'
      : authorWritten
        ? 'author-written-recommended'
        : 'none',
    media: mediaBan ? 'prohibited' : 'none',
    disclosure: assistedBy
      ? 'assisted-by'
      : toolAndUse
        ? 'tool-and-use'
        : disclose
          ? 'unspecified'
          : undefined,
    ...(noPullRequests ? { noPullRequests: true } : {}),
    ...(prInstructions.length ? { prInstructions: prInstructions.slice(0, 10) } : {}),
  };
}
