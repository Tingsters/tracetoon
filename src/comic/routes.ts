/**
 * The image routes on this machine, whether each can draw and is approved, and
 * the one thing to do next. Shared by `tracetoon images`, `doctor`, the
 * installers' summary and `comic art` when it has no route.
 */
import { loadConfig } from '../config.ts';
import { PROVIDERS, providerInfo, type ProviderId, type Readiness } from './providers.ts';

export interface RouteStatus {
  id: ProviderId;
  label: string;
  sendsTo: string;
  cost: string;
  /** Found on this machine. */
  available: boolean;
  ready: Readiness;
  approved: boolean;
  detail: string;
}

export function routeStatuses(root?: string): RouteStatus[] {
  const approved = loadConfig(root).imageConsent;
  return PROVIDERS.map((id) => {
    const i = providerInfo(id);
    return {
      id,
      label: i.label,
      sendsTo: i.sendsTo,
      cost: i.cost,
      available: i.available,
      ready: i.ready,
      approved: approved.includes(id),
      detail: i.detail,
    };
  });
}

/** Can be used now: found, not known to be broken. */
export const usable = (r: RouteStatus) => r.available && r.ready !== 'not ready';

/** How to set an API key so a restarted agent sees it, on this OS. */
export function keyHowTo(name = 'OPENAI_API_KEY'): string {
  return process.platform === 'win32'
    ? `setx ${name} "<your key>" in a terminal`
    : `add export ${name}="<your key>" to your shell profile (~/.bashrc, ~/.zshrc)`;
}

export type NextStep =
  | { kind: 'ready'; route: ProviderId; text: string }
  | { kind: 'approve'; route: ProviderId; text: string }
  | { kind: 'fix'; route: ProviderId; text: string }
  | { kind: 'setup'; text: string };

/** The single most useful next step for comics. */
export function nextStep(routes: RouteStatus[]): NextStep {
  const ready = routes.find((r) => r.approved && usable(r));
  if (ready)
    return {
      kind: 'ready',
      route: ready.id,
      text:
        ready.ready === 'ready'
          ? `Comics are ready: ${ready.label}.`
          : `Comics will use ${ready.label}. To check it can draw: tracetoon images --test ${ready.id}`,
    };
  const candidate = routes.find(usable);
  if (candidate)
    return {
      kind: 'approve',
      route: candidate.id,
      text: `Approve ${candidate.label} once. It sends comic scenes and character descriptions (never code) to ${candidate.sendsTo}, ${candidate.cost}. Run: tracetoon images --approve ${candidate.id} --test`,
    };
  const broken = routes.find((r) => r.available);
  if (broken)
    return {
      kind: 'fix',
      route: broken.id,
      text: `${broken.label} is installed but can't draw yet: ${broken.detail}.`,
    };
  return {
    kind: 'setup',
    text: `No image route, so PRs get no comic. To add one: ${setupAdvice()}`,
  };
}

/** How to get an image route from nothing. */
export function setupAdvice(): string {
  return `install the Codex CLI and run \`codex login\` with a ChatGPT account (covered by your plan), or set OPENAI_API_KEY or GEMINI_API_KEY (billed per image; ${keyHowTo()}), then restart your agent.`;
}
