/** Writes the skill's styles.md from src/comic/styles.ts (run: bun scripts/gen-styles.ts). */
import { writeFileSync } from 'node:fs';
import { STYLES } from '../src/comic/styles.ts';
const kinds = (c: string[]) =>
  c.includes('animal')
    ? 'people, robots, creatures, animals'
    : 'people, robots, creatures (no animals)';
const rows = STYLES.map(
  (s) =>
    `| \`${s.id}\` | ${s.name} | ${s.moods.join(', ')} | ${s.palettes.join(', ')} | ${kinds(s.casts)} |`,
);
const md = `# Art styles

Pick one per comic with \`"style"\`. \`tracetoon comic check\` blocks a style that
doesn't suit the cast, and warns when the repo used it recently.

| Style | Look | Good for | Palettes | Suits |
|---|---|---|---|---|
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
