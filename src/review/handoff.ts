/** Keep local file links outside the wordmark's Markdown fence. */
import { loadConfig, repoConfigPath } from '../config.ts';
import { readFileSync } from 'node:fs';

export const WORDMARK =
  '_|_ ._  _   _  _  _|_  _   _   _\n |_ |  (_| (_ (/_  |_ (_) (_) | |';

export interface PreviewHandoff {
  terminal: string;
  markdown: string;
}

/** Legacy file-reference format; Codex TUI does not hyperlink these targets.
 * Keep URI escapes for reserved filename characters and normalize drive paths
 * without consulting this machine's OS (a host may render another OS's output).
 * Use the same format for ancillary previews, images and local reports.
 */
export function localFileLink(label: string, fileUrl: string): string {
  const url = new URL(fileUrl);
  if (url.protocol !== 'file:') throw new TypeError('Expected a local file URL');
  const path = url.hostname
    ? `//${url.hostname}${url.pathname}`
    : url.pathname.replace(/^\/([a-z]:\/)/i, '$1');
  const safeLabel = label.replace(/[\\\[\]]/g, '\\$&');
  return `[${safeLabel}](<${path}>)`;
}

export const READY_CAPTION = 'OPEN YOUR LOCAL PR PREVIEW';

/**
 * Whether an assistant reply delivered this preview. Accepts the live browser
 * link, the labeled or bare local file URL, and the `Local file:` path that
 * every handoff prints (the serverless one has no clickable link on purpose).
 */
export function handoffShown(
  message: unknown,
  preview: { fileUrl: string; filePath: string; browserUrl?: string },
): boolean {
  if (typeof message !== 'string') return false;
  const slashes = (s: string) => s.replace(/\\/g, '/');
  return (
    (!!preview.browserUrl && message.includes(preview.browserUrl)) ||
    message.includes(localFileLink(READY_CAPTION, preview.fileUrl)) ||
    message.includes(preview.fileUrl) ||
    slashes(message).includes(slashes(preview.filePath))
  );
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
  // Make the preview label itself clickable; plain output retains one full URL.
  const lines = handoff.terminal.split('\n');
  const index = lines.findIndex((line) => line.endsWith(`: ${url}`));
  if (index < 0) return handoff.terminal;
  const caption = lines[index]!.slice(0, -`: ${url}`.length);
  lines[index] =
    `\u001b]8;;${url}\u001b\\\u001b[4;94m${caption}\u001b[0m\u001b]8;;\u001b\\`;
  return lines.join('\n');
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
  filePath: string;
  run: string;
  pending?: boolean;
  problem?: string;
}): PreviewHandoff {
  const caption = input.pending
    ? input.problem
      ? 'Your PR preview needs refreshing'
      : 'You have a PR awaiting review'
    : READY_CAPTION;
  const next = input.problem
    ? `${input.problem}\nResume with: ${input.command} preview --run ${input.run}. Refresh the digest, description, review and preview before publishing.`
    : 'Open the preview, skim the description and comic, then reply "Publish this PR".';
  // A copyable filesystem path also works when the host cannot open links.
  const fence = '`'.repeat(
    Math.max(0, ...(input.filePath.match(/`+/g) ?? []).map((s) => s.length)) + 1,
  );
  const localFile = `Local file: ${fence} ${input.filePath} ${fence}`;
  return {
    terminal: [
      WORDMARK,
      `${caption}: ${input.url}`,
      `Local file: ${input.filePath}`,
      yoloHint(input.root, input.command),
      next,
    ].join('\n'),
    markdown: [
      '```text',
      WORDMARK,
      '```',
      input.url.startsWith('http://127.0.0.1:')
        ? `**[${caption}](${input.url})**`
        : `**${caption}**\n\nStart a clickable browser preview: \`${input.command} preview --run ${input.run} --serve --open\`.`,
      '',
      localFile,
      '',
      yoloHint(input.root, input.command, true),
      '',
      next,
    ].join('\n'),
  };
}
