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
  title ("SILENCE IS GOLDEN", "THREE SILENT SUSPECTS", "7 IMAGES, 4 PROMPTS").
- **Specific beats generic.** "The panels came back in the wrong order" is funny;
  "tests pass" is not.
- **Make it relatable**: every developer knows flaky tests, a fix that needs a fix,
  or a "quick change" that wasn't. No in-jokes that need the PR to make sense.
- **Punch at the problem, never at people.** The bug, the build, or the agent's
  own blunder are fair game. The user, other contributors and real
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

## 3. Pick or invent a style

Any art style works. Choose one that suits this PR's story (a tense debug might
be film noir, a big launch a pulp sci-fi poster, a gentle cleanup a watercolor
storybook), and make it different from the repo's recent comics, which
`tracetoon context` lists. Set `"style"` to an idea from [styles.md](styles.md)
by id, or describe your own in a few words ("1970s Saturday-morning cel
animation", "linocut print", "museum diorama"). Vary the format and `palette`
too: `bw-accent` (black and white with one accent color, set `accent`, e.g.
"red"), `duotone`, `limited` or `full-color`. If the repo pins a style
(`config style`), use it.

## 4. Characters: invent them for this comic

Every comic has its own characters, made up for this PR's joke: people,
creatures, objects with faces, or no characters at all. Never reuse characters
from an earlier comic, and don't turn the agents into recurring mascots. List
each one once in `"characters"` with a short visual description (what they look
like, what they wear, their colors), so every panel draws them the same way.
Panels and dialogue refer to them by `name`. No real people.

## 5. comic.json

```json
{
  "v": 2,
  "title": "The Wrong-Folder Mystery",
  "headline": "THREE SILENT SUSPECTS",
  "synopsis": "A login screen breaks three quiet ways; a detective lines up the suspects.",
  "altText": "A rain-soaked detective questions three config files in a police line-up; the last one sweats under the lamp.",
  "format": "strip",
  "layout": "three panels; the line-up panel is wider",
  "style": "film noir with a single teal glow",
  "palette": "bw-accent",
  "accent": "teal",
  "characters": [
    { "name": "Detective Ash", "description": "a tired detective in a rumpled trench coat and fedora, stubble, holding a flashlight" },
    { "name": "Config File", "description": "a nervous sheet of paper with a face, dog-eared corner, sweating ink drops" }
  ],
  "panels": [
    {
      "scene": "Ash shines a flashlight down a rainy alley at a login screen that shows nothing",
      "characters": [{ "name": "Detective Ash", "position": "left", "expression": "thinking" }],
      "dialogue": [{ "speaker": "Detective Ash", "text": "Three ways to fail. Not one error." }]
    },
    {
      "scene": "A police line-up of three config files under harsh light",
      "characters": [
        { "name": "Detective Ash", "position": "left", "expression": "determined" },
        { "name": "Config File", "position": "right", "expression": "worried" }
      ],
      "dialogue": [
        { "speaker": "caption", "kind": "sign", "text": "WRONG FOLDER" },
        { "speaker": "Config File", "text": "I was in the other folder!" }
      ]
    }
  ]
}
```

Rules (checked by `tracetoon comic check`; warnings don't block):
- 1–6 panels and at most 6 characters. At most 4 characters and 4 text items
  per panel, 12 words per item, 50 words per page, headline at most 6 words.
- `speaker` is a character's `name` or `"caption"`. `kind`: `speech` (default),
  `thought`, `caption` (narration), `sfx` (a sound effect) or `sign` (words on a
  screen, sign or label in the scene).
- `aspect`: `4:3` (default), `1:1`, `16:9` or `3:4`; formats have sensible
  defaults.
- No links, no @mentions, no secrets, no real people's names, no company logos.

## 6. Make the art, then proofread

`tracetoon comic art` (see SKILL.md for consent) draws the **whole page in one
image, lettering included**, so the words look like part of the comic. Then:

1. `tracetoon comic render` adds a small "made with Tracetoon" footer bar and
   prints a **proofread** list.
2. **Look at `out/comic.png`** and check every word on the list is lettered
   exactly, with nothing extra or garbled.
3. If something is off, run `tracetoon comic art --force` to redraw (up to 2
   times). If it's still wrong, run `tracetoon comic art --lettering overlay
   --force`: the art is drawn without text and Tracetoon adds the bubbles.
4. Not loving the look? `tracetoon comic reroll` keeps the story and redraws it
   in a style idea the repo hasn't used lately (`--style "<any style>"` to choose
   one, `--format`, `--palette` to change those too).

With your own image tool instead: `tracetoon comic prompts` prints the
whole-page prompt and where to save it (`art/page.png`).

With overlay lettering, if a bubble covers something important, write
`layout.json` to place bubbles by hand (0–1 coordinates within the panel, one
entry per text item, `null` for automatic):

```json
{ "panels": [[{ "x": 0.05, "y": 0.04, "w": 0.45 }], []] }
```

`tracetoon render` places the comic after the description, or wherever you put
`{{tracetoon:comic}}` in `body.md`, with a transcript under it. After
publishing, offer the user the share caption that `tracetoon publish` prints.
