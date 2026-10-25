# Art style ideas

A comic can use any art style. Set `"style"` to one of these ids (it expands to
a tested prompt) or to your own description ("1970s Saturday-morning cel
animation", "linocut print"). Pick what suits this PR's story, and something
different from the repo's recent comics (`tracetoon context` lists them;
`tracetoon comic check` warns on a repeat).

These lettering notes suggest a treatment, not a mandatory headline.
`composition.title` decides whether a title is drawn and where it belongs.
Also compare broad `styleFamily`, layout and cast in `recentComics`;
renaming the same treatment is not variety.

| Style | Look | Good for | Palettes |
|---|---|---|---|
| `manga-ink` | Manga ink | dramatic, intense, heroic, victory | bw-accent, limited |
| `shonen-action` | Shonen action | epic, battle, comeback, speed | full-color |
| `mecha-anime` | Mecha anime | systems, infrastructure, launch, precision | full-color, bw-accent |
| `chibi-anime` | Chibi anime | cozy, silly, small fix, wholesome | full-color |
| `noir` | Film noir | mystery, debugging, investigation, suspense | bw-accent, limited |
| `silver-age` | Silver-age comic | heroic, rescue, big win, retro | full-color, limited |
| `ligne-claire` | Ligne claire | adventure, exploration, clever, travel | full-color |
| `sunday-strip` | Sunday newspaper strip | gag, everyday, relatable, small fix | full-color, limited |
| `rubber-hose` | 1930s rubber hose | slapstick, chaos, silly, retro | limited, duotone |
| `storybook-watercolor` | Storybook watercolor | gentle, cleanup, care, wholesome | full-color |
| `claymation` | Claymation | handmade, building, silly, craft | full-color |
| `pixel-16bit` | 16-bit pixel art | quest, level up, boss fight, retro | limited, full-color |
| `risograph` | Risograph zine | indie, tooling, docs, craft | duotone |
| `pulp-scifi` | Pulp sci-fi | launch, future, bold claim, adventure | full-color, limited |
| `ukiyo-e` | Ukiyo-e woodblock | calm, refactor, balance, migration | limited |
| `atomic-flat` | Mid-century flat | optimistic, product, feature, clean | limited, full-color |
| `blueprint` | Blueprint | architecture, internals, how it works, design | duotone |
| `vaporwave` | Vaporwave | performance, speed, nostalgia, ui | full-color |

Details (what the image model is asked for):

- **`manga-ink`**: black-and-white manga page, crisp ink linework, screentone shading, speed lines and impact bursts, dramatic angles, expressive eyes. Lettering: hand-lettered manga captions in boxes, bold brush-script headline.
- **`shonen-action`**: full-color shonen anime action page, dynamic poses, motion blur, glowing energy effects, bold cel shading. Lettering: big angled sound effects, bold outlined headline.
- **`mecha-anime`**: mecha anime style, detailed robots and cockpits, holographic HUD panels, cinematic lighting. Lettering: HUD labels and readouts on screens, condensed sci-fi headline.
- **`chibi-anime`**: cute chibi anime style, big heads, small bodies, soft cel shading, pastel colors. Lettering: rounded bubbly lettering, playful headline.
- **`noir`**: film noir graphic novel, heavy black shadows, venetian-blind light, rain, chiaroscuro, trench coats. Lettering: typewriter caption boxes, hard-boiled narration, stark serif headline.
- **`silver-age`**: 1960s American comic book, Ben-Day halftone dots, bold primary colors, thick outlines, heroic poses. Lettering: classic comic lettering in white balloons, exclamation-heavy, burst headline.
- **`ligne-claire`**: ligne claire European comic style, clean uniform outlines, flat colors, detailed tidy backgrounds, no hatching. Lettering: neat hand lettering in clean balloons, elegant headline.
- **`sunday-strip`**: classic Sunday newspaper comic strip, simple expressive cartoon characters, warm flat colors, slight paper texture. Lettering: friendly hand-lettered balloons, strip title in a banner.
- **`rubber-hose`**: 1930s rubber-hose cartoon, bendy limbs, pie-cut eyes, white gloves, sepia film grain, bouncy motion. Lettering: vintage title card lettering, bouncy balloons.
- **`storybook-watercolor`**: children's storybook watercolor illustration, soft washes, pencil linework, gentle light. Lettering: handwritten storybook captions, whimsical headline.
- **`claymation`**: stop-motion claymation diorama, plasticine characters with fingerprints, miniature set, soft studio lighting. Lettering: cut-paper signs and labels in the set, chunky headline.
- **`pixel-16bit`**: 16-bit pixel art like a 1990s console game, crisp pixels, limited palette, game UI elements. Lettering: pixel font dialogue boxes like an RPG, "LEVEL CLEAR" style headline.
- **`risograph`**: risograph-printed zine, two overprinted ink colors, grainy texture, slight misregistration, bold shapes. Lettering: chunky grotesque type, stamped labels.
- **`pulp-scifi`**: 1950s pulp science fiction magazine art, ray guns, rocket fins, painted gouache, dramatic sky. Lettering: pulp magazine cover headline, starburst blurbs.
- **`ukiyo-e`**: Japanese ukiyo-e woodblock print, flat color areas, carved outlines, stylized waves and clouds, washi paper texture. Lettering: vertical cartouche labels, brush headline.
- **`atomic-flat`**: mid-century modern illustration, atomic-age shapes, flat geometric characters, starbursts, cream background. Lettering: retro display type, small caption labels.
- **`blueprint`**: technical blueprint, white linework on cyan blueprint paper, callouts, dimension lines, exploded views. Lettering: drafting stencil labels and callouts, title block headline.
- **`vaporwave`**: vaporwave aesthetic, neon pink and cyan, synthwave sun, chrome text, grid horizon, retro computer windows. Lettering: chrome and neon headline, window-title labels.

Palettes: `full-color`; `bw-accent` (black and white with one accent color,
set `"accent"`, e.g. "red"); `duotone` (two inks); `limited` (3 to 4 colors).
