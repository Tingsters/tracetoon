/** Keep the clickable URL outside the wordmark's Markdown fence. */
import { loadConfig, repoConfigPath } from '../config.ts';
import { readFileSync } from 'node:fs';

export const WORDMARK =
  '_|_ ._  _   _  _  _|_  _   _   _\n |_ |  (_| (_ (/_  |_ (_) (_) | |';

export interface PreviewHandoff {
  terminal: string;
  markdown: string;
}

/** Style only interactive output; JSON and redirected logs retain the plain URL. */
export function terminalHandoff(
  handoff: PreviewHandoff,
  url: string,
  display: { isTTY?: boolean; env?: NodeJS.ProcessEnv } = {},
): string {
  const isTTY = display.isTTY ?? process.stdout.isTTY;
  const env = display.env ?? process.env;
  if (!isTTY || env.NO_COLOR || env.TERM === 'dumb') return handoff.terminal;
  // OSC 8 keeps wrapped file URLs clickable in supporting terminals. The full
  // URL is still visible when a terminal only understands the ANSI styling.
  const link = `\u001b]8;;${url}\u001b\\\u001b[4;94m${url}\u001b[0m\u001b]8;;\u001b\\`;
  return handoff.terminal.replace(url, () => link);
}

export function yoloHint(root: string, command: string, chat = false): string {
  const enabled = loadConfig(root).yolo;
  let repoOverride: boolean | undefined;
  try {
    const value = JSON.parse(readFileSync(repoConfigPath(root), 'utf8')).yolo;
    if (typeof value === 'boolean') repoOverride = value;
  } catch {
    /* no repository override */
  }
  if (repoOverride !== undefined)
    return `YOLO is ${enabled ? 'on' : 'off'} in this repository's .github/tracetoon.json; that setting overrides your personal preference.`;
  if (enabled)
    return chat
      ? 'YOLO is on for future PRs. To restore preview approval, say: "Disable Tracetoon yolo mode".'
      : `YOLO is on for future PRs. Restore preview approval: ${command} config set yolo false`;
  return chat
    ? 'Skip preview approval for future PRs: say "Enable Tracetoon yolo mode for future PRs". Freshness and publication checks still apply.'
    : `Skip preview approval for future PRs: ${command} config set yolo true (freshness and publication checks still apply).`;
}

export function previewHandoff(input: {
  root: string;
  command: string;
  url: string;
  run: string;
  pending?: boolean;
  problem?: string;
}): PreviewHandoff {
  const caption = input.pending
    ? input.problem
      ? 'Your PR preview needs refreshing'
      : 'You have a PR awaiting review'
    : 'OPEN YOUR LOCAL PR PREVIEW';
  const next = input.problem
    ? `${input.problem}\nResume with: ${input.command} preview --run ${input.run}. Refresh the digest, description, review and preview before publishing.`
    : 'Open the preview, skim the description and comic, then reply "Publish this PR".';
  return {
    terminal: [
      WORDMARK,
      caption,
      input.url,
      yoloHint(input.root, input.command),
      next,
    ].join('\n'),
    markdown: [
      '```text',
      WORDMARK,
      '```',
      `**[${caption}](<${input.url}>)**`,
      '',
      input.url,
      '',
      yoloHint(input.root, input.command, true),
      '',
      next,
    ].join('\n'),
  };
}
