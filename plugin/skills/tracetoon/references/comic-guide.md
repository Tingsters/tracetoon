# Writing the comic

Every PR gets a four-panel comic (a *4-koma*) that tells the story of how the
change was made, starring the repo's recurring cast. Fun first, but true to the
digest: no invented features, no fake results.

## The cast

`tracetoon context` writes `bible.json` and lists the cast. Use the cast `id`s
exactly. Each agent that worked on the PR has a character (for example Kit the
fox for Claude Code in the pets theme). The developer is the human, and there is
a small "bug" troublemaker for problems. Only use characters from the cast.

## The four beats

| Panel | Beat | Use it for |
|---|---|---|
| 1 | `ki`, setup | What the user asked for and why (from their prompts) |
| 2 | `sho`, development | How the work went: the plan, an approach, a decision |
| 3 | `ten`, twist | The surprise: a failing test, a bug, a dropped approach, a tricky edge case |
| 4 | `ketsu`, resolution | How it ended: tests green, PR ready, a wink at what's next |

Good twists come from the digest: `milestones` ("tests went from failing to
passing", "edits did not survive"), decisions, or plan revisions. If nothing went
wrong, the twist can be the bug character finding nothing to break.

If `story.previously` is not empty, this episode continues a saga: a light
callback in panel 1 or 4 is a nice touch ("Remember the parser? It's back.").

## comic.json

Write it to the run folder:

```json
{
  "v": 1,
  "title": "Short episode title",
  "synopsis": "One or two sentences on what this episode was about. Shown as 'previously on' in later PRs.",
  "altText": "Describe all four panels for screen-reader users.",
  "panels": [
    {
      "beat": "ki",
      "scene": "Sam asks Kit to move the log readers into a shared library",
      "camera": "medium",
      "characters": [
        { "cast": "sam", "position": "left", "expression": "happy" },
        { "cast": "kit", "position": "right", "expression": "excited" }
      ],
      "dialogue": [
        { "speaker": "sam", "text": "Can other tools use our log readers?" },
        { "speaker": "kit", "text": "Leave it to me!" }
      ]
    }
  ]
}
```

Rules (checked by `tracetoon comic check`):

- Exactly four panels, beats in order `ki`, `sho`, `ten`, `ketsu`.
- At most 3 characters and 3 dialogue lines per panel; at most 14 words a line.
- `position`: `left`, `center` or `right`. `camera`: `wide`, `medium` or `close`.
- `expression`: happy, excited, worried, surprised, determined, thinking, sleepy,
  proud, angry.
- `kind`: `speech` (default), `thought`, `caption` (narration, speaker
  `"caption"`) or `sfx` (big sound effect like "BZZT!").
- No links, no @mentions, no secrets, no real people's names.
- Order dialogue in reading order: left speaker before right speaker.

## Making the art

The art is AI-drawn whenever possible. Each character gets a reference portrait
(a "character sheet") once per series. Sheets are saved with the series and
attached to every later panel, so characters look the same in every episode.
Speech bubbles are always added afterwards by Tracetoon, so the text is exact.

Pick the first option that works:

1. **Your own image tool** (Codex's built-in image generation, Antigravity's
   image generation): run `tracetoon comic prompts`. First draw any character
   sheets it lists and save each to its path (`art/cast-<id>.png`). Then draw
   each panel with those sheets (and the listed character references) as
   reference images, and save it to its path (`art/panel-N.png`). Square images,
   no text in them.
2. **`tracetoon comic art`** (any agent, including Claude Code, which has no
   image tool). It uses an AI image route the user has approved:
   - the Codex or Antigravity CLI if installed (uses the user's own login, no
     key needed);
   - OpenAI or Gemini if `OPENAI_API_KEY` or `GEMINI_API_KEY` is set.

   The first time, it exits with code 4 and says where the prompts would go.
   Ask the user once, quoting that, and if they agree run
   `tracetoon comic art --provider <name> --consent`. `tracetoon doctor` lists
   which routes exist and which are approved. Prompts contain only the comic's
   scenes and character descriptions, never code or log text. AI art takes a
   few minutes; let the command finish.
3. **Built-in artist:** if no route is available or approved, or the image
   model fails, `tracetoon comic art` draws the panels itself and reports a
   warning when it fell back.

Then `tracetoon comic render` adds the speech bubbles and writes
`out/comic.png`. Look at the result if you can view images. If a bubble covers
something important, write `layout.json` to place bubbles by hand:

```json
{ "panels": [[{ "x": 0.05, "y": 0.04, "w": 0.45 }], [], [], []] }
```

Coordinates run from 0 to 1 within the panel, one entry per dialogue line (use
`null` to keep the automatic spot). Render again.

`tracetoon render` places the comic at the top of the description, or wherever
you put `{{tracetoon:comic}}` in `body.md`, with a transcript under it.
