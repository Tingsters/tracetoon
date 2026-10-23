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
  'CONTRIBUTING.md',
  '.github/CONTRIBUTING.md',
  'docs/CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'Documentation/process/coding-assistants.rst',
];

const AI_TERMS =
  /\b(AI|A\.I\.|LLM|large language model|generative|copilot|chatgpt|claude|gpt|machine[- ]generated|coding assistant|AI[- ]assisted)\b/i;
const PROHIBIT =
  /\b(not accept|do not accept|don't accept|will be rejected|prohibit|forbid|ban(ned)?|not allowed|not permitted|must not (use|submit)|no AI)\b/i;
const DISCLOSE =
  /\b(disclos|must (state|mention|indicate|note)|Assisted-by|AI-used-for|declare)\w*/i;

export type PolicyVerdict = 'prohibited' | 'disclosure-required' | 'mentioned' | 'none';

export interface AiPolicy {
  verdict: PolicyVerdict;
  /** Lines that mention AI, with their file, for the agent and user to read. */
  excerpts: { file: string; line: number; text: string }[];
}

/**
 * A heuristic read of the repo's stance on AI contributions. The excerpts matter
 * more than the verdict: the skill shows them to the user, who decides.
 */
export function detectAiPolicy(root: string): AiPolicy {
  const excerpts: AiPolicy['excerpts'] = [];
  let prohibited = false;
  let disclose = false;
  for (const rel of POLICY_FILES) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      if (!AI_TERMS.test(text)) return;
      excerpts.push({ file: rel, line: i + 1, text: text.trim().slice(0, 300) });
      if (PROHIBIT.test(text)) prohibited = true;
      if (DISCLOSE.test(text)) disclose = true;
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
  return { verdict, excerpts: excerpts.slice(0, 20) };
}
