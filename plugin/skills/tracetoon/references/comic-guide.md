# Making the comic

Every PR gets one comic image. The goal: a developer who has never seen this repo
laughs, gets what happened, and wants to share it. Fun first, but true to the
digest: no invented features, no fake results.

## 1. Find the joke

Read the digest for the moment that's funny *because it really happened*:
- a twist (`milestones`: "tests went from failing to passing", "edits did not
  survive");
- a decision the user made, or a plan that changed;
- a number (7 images for 4 prompts, 57/57 checks, 9 minutes);
- the user's own pushback (paraphrased; never quote private details);
- the gap between what was asked and what it took.

Then shape it:
- **One joke per image.** Set it up, then pay it off at the end (the last panel,
  or the bottom of a poster).
- **A headline that works alone**, at most 6 words: a pun, a tabloid line, a movie
  title ("SILENCE IS GOLDEN", "THE CAT-EARS INCIDENT", "7 IMAGES, 4 PROMPTS").
- **Specific beats generic.** "The panels came back in the wrong order" is funny;
  "tests pass" is not.
- **Make it relatable**: every developer knows flaky tests, a fix that needs a fix,
  or a "quick change" that wasn't. No in-jokes that need the PR to make sense.
- **Punch at the problem, never at people.** The bug character, the build, or the
  agent's own blunder are fair game. The user, other contributors and real
  companies are not.
- **Fewer words**: the whole page holds at most 50 words, headline included. If
  it doesn't read on a phone, cut.

## 2. Pick a format

Pick what makes the best image for this PR, not always the same one:

| Format (`format`) | Use it when | Panels |
|---|---|---|
| `strip` | one gag with a punchline | 2–4 |
| `4koma` | setup, development, twist, resolution | 4 |
| `before-after` | the change is easy to see (broken → fixed, slow → fast) | 2–3 |
| `splash` | one big moment: a launch, a rescue, a victory | 1–2 |
| `mission-briefing` | a tricky multi-part fix: objectives, obstacles, outcome | 3–5 |
| `movie-poster` | a big feature or dramatic rescue | 1 |
| `manual-page` | a new workflow or setup, as numbered steps | 3–6 |
| `newspaper-sunday` | an everyday, relatable story in a few beats | 4–6 |
| `trading-card` | a new capability or tool, with stats and powers | 1 |
| `custom` | none fits; describe the page in `layout` | 1–6 |

Describe the composition in `layout` in your own words when it helps ("three
panels; the last one breaks its border", "a big hero panel plus a small inset").

## 3. Pick a style that fits

Choose from [styles.md](styles.md) to suit the mood of the work (a tense debug →
`noir`; a big launch → `pulp-scifi` or `silver-age`; a gentle cleanup →
`storybook-watercolor`). Rules:
- **Vary it.** `tracetoon context` lists the repo's recent styles; pick
  something else (unless this is a sequel). Vary the format and `palette` too:
  `bw-accent` (black and white with one accent color, set `accent`, e.g.
  "red"), `duotone`, `limited` or `full-color`.
- **Fit the cast.** Anime and manga styles (`manga-ink`, `shonen-action`,
  `mecha-anime`, `chibi-anime`) are never used with animal characters, because
  they come out as furries. With an animal cast (the pets theme), use cartoon
  styles: `sunday-strip`, `ligne-claire`, `rubber-hose`, `storybook-watercolor`,
  `claymation`, `pixel-16bit` and others. `tracetoon comic check` enforces this.
  Only the user can lift it (`config set allowAnimalAnime true`).
- If the repo pins a style (`config style`), use it.

## 4. Continuity: standalone unless it really continues

Most PRs are standalone: no recap. `tracetoon context` lists **related
episodes**, meaning stacked or linked PRs and earlier PRs that touched the same
areas of the code.
- **`sequel`**: this PR continues one of those (same feature, a follow-up fix).
  Reuse its style and cast, set `"continuity": {"mode": "sequel", "of": [12]}`,
  and you may call back to it. Character sheets are attached so the cast matches,
  and a "Previously" line appears (only sequels get one).
- **`standalone`** (default): fresh style. The cast is optional; a scene with
  only the bug, or with guest characters described in `scene`, is fine.
- **`new-arc`**: new or very different work. Start fresh and be inventive.

## 5. The cast

`tracetoon context` writes `bible.json` and lists the cast. Use the cast `id`s
exactly. Each agent that worked on the PR has a character (in the pets theme,
Kit the fox for Claude Code). Sam is the developer, and Glitch is a small
troublemaker for problems. Characters are optional on a page; you can also put
people or things in the scene by describing them in `scene`, as long as they are
not real people.

## 6. comic.json (v2, a page)

```json
{
  "v": 2,
  "title": "The Cat-Ears Incident",
  "headline": "THE CAT-EARS INCIDENT",
  "synopsis": "Codex draws the comic, but Sam comes back as a cat. Prompts now say who's human.",
  "altText": "Before: Sam drawn with cat ears looks horrified. After: Sam drawn as a human, relieved; Kit points at a prompt that says 'human'.",
  "format": "before-after",
  "layout": "BEFORE on the left, AFTER on the right, a thin arrow between",
  "style": "silver-age",
  "palette": "full-color",
  "continuity": { "mode": "standalone" },
  "panels": [
    {
      "scene": "Sam stares at a freshly drawn portrait of themselves with cat ears",
      "characters": [{ "cast": "sam", "position": "left", "expression": "surprised" }],
      "dialogue": [
        { "speaker": "caption", "text": "BEFORE" },
        { "speaker": "sam", "text": "I asked for a comic, not a makeover!" }
      ]
    },
    {
      "scene": "Kit taps a glowing prompt card; the new portrait shows Sam as a human",
      "characters": [
        { "cast": "kit", "position": "left", "expression": "proud" },
        { "cast": "sam", "position": "right", "expression": "happy" }
      ],
      "dialogue": [
        { "speaker": "caption", "text": "AFTER" },
        { "speaker": "caption", "kind": "sign", "text": "SPECIES: HUMAN" }
      ]
    }
  ]
}
```

Rules (checked by `tracetoon comic check`; warnings don't block):
- 1–6 panels. At most 4 characters and 4 text items per panel, 12 words per item,
  50 words per page, headline at most 6 words.
- `kind`: `speech` (default), `thought`, `caption` (narration, speaker
  `"caption"`), `sfx` (a sound effect) or `sign` (words on a screen, sign or label
  in the scene).
- `aspect`: `4:3` (default), `1:1`, `16:9` or `3:4`; formats have sensible
  defaults.
- No links, no @mentions, no secrets, no real people's names, no company logos.
- The old fixed format (`"v": 1`, exactly four panels with beats `ki`, `sho`,
  `ten`, `ketsu`) still works.

## 7. Make the art, then proofread

`tracetoon comic art` (see SKILL.md for consent) draws the **whole page in one
image, lettering included**, so the words look like part of the comic. For a
sequel, the series' character sheets are attached so the cast looks the same as
before. A standalone page draws the cast fresh from their descriptions, so each
style can render them its own way. Then:

1. `tracetoon comic render` adds Tracetoon's footer bar (`owner/repo #N · made
   with Tracetoon`) and prints a **proofread** list.
2. **Look at `out/comic.png`** and check every word on the list is lettered
   exactly, with nothing extra or garbled.
3. If something is off, run `tracetoon comic art --force` to redraw (up to 2
   times). If it's still wrong, run `tracetoon comic art --lettering overlay
   --force`: the art is drawn without text and Tracetoon adds the bubbles.
4. Not loving the look? `tracetoon comic reroll` keeps the story and redraws it
   in a fresh style that suits the cast (`--style <id>` to choose one,
   `--format`, `--palette` to change those too).

With your own image tool instead: `tracetoon comic prompts` prints the
character-sheet prompts and one whole-page prompt (save it to `art/page.png`).

With overlay lettering, if a bubble covers something important, write
`layout.json` to place bubbles by hand (0–1 coordinates within the panel, one
entry per text item, `null` for automatic):

```json
{ "panels": [[{ "x": 0.05, "y": 0.04, "w": 0.45 }], []] }
```

`tracetoon render` places the comic at the top of the description, or wherever
you put `{{tracetoon:comic}}` in `body.md`, with a transcript under it. After
publishing, offer the user the share caption that `tracetoon publish` prints.
