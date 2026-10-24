/** Writes the skill's styles.md from src/comic/styles.ts (run: bun scripts/gen-styles.ts). */
import { writeFileSync } from 'node:fs';
import { STYLES } from '../src/comic/styles.ts';
const rows = STYLES.map(
  (s) => `| \`${s.id}\` | ${s.name} | ${s.moods.join(', ')} | ${s.palettes.join(', ')} |`,
);
const md = `# Art style ideas

A comic can use any art style. Set \`"style"\` to one of these ids (it expands to
a tested prompt) or to your own description ("1970s Saturday-morning cel
animation", "linocut print"). Pick what suits this PR's story, and something
different from the repo's recent comics (\`tracetoon context\` lists them;
\`tracetoon comic check\` warns on a repeat).

| Style | Look | Good for | Palettes |
|---|---|---|---|
${rows.join('\n')}

Details (what the image model is asked for):

${STYLES.map((s) => `- **\`${s.id}\`**: ${s.prompt}. Lettering: ${s.lettering}.`).join('\n')}

Palettes: \`full-color\`; \`bw-accent\` (black and white with one accent color,
set \`"accent"\`, e.g. "red"); \`duotone\` (two inks); \`limited\` (3 to 4 colors).
`;
export const STYLES_MD = md;
if (import.meta.main)
  writeFileSync(
    process.argv[2] ??
      new URL('../plugin/skills/tracetoon/references/styles.md', import.meta.url),
    md,
  );
