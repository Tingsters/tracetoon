# Making the comic

Every PR gets one comic image, shown right under the description. Its first
reader is the reviewer. The goal: after reading the comic they know **what
changed**, remember it, and smile. Someone who has never seen the repo should
still get the joke, because labels name the real parts. Fun, true to the digest
(no invented features, no fake results), and about *this* change.

A comic can be well drawn and funny yet explain nothing. A waiter serving a
photo of soup is a good gag, but no reader connects it to "the PR link in the
terminal looked clickable but didn't open". Name the real thing and the same
gag works: label the photo `PR #34`.

## 1. Anchor the change, then find the joke

Start with the change itself: one sentence a reviewer would agree with, and the
1–4 real names the PR uses for it (a command, flag, file, error, setting or
concept: `publish --draft`, "skipped tests", `comic.json`). Write them in the
script's `anchor` with a `mapping` from each drawn element to the technical
thing it stands for. Then find the supported event, decision, or changed
behavior from the digest that makes it funny. Keep the evidence reference in
local comic-design.json.

**The PR test.** Cover the title and description. Could a developer name the
change from the comic alone? Apply it to each concept before judging humor or
novelty. If the answer is no, add labels, move the metaphor closer to the
system, or pick another concept.

**Metaphor distance.** Choose the nearest metaphor that still gives a joke, and
justify going further:
1. The system's own parts as characters or objects: the hook, the leak
   scanner, a CI job, a cache entry, two requests racing, with their real names.
2. A developer-world scene: a terminal, a review thread, a CI page, a stand-up.
3. An everyday analogy (a restaurant, a bakery, a classroom). Allowed when it
   is the strongest joke, but only with labels on the elements that carry the
   mapping, the way xkcd's "Dependency" labels a block tower as all modern
   digital infrastructure.

**Labels.** Use `"kind": "label"` callouts (up to 4 words, with `points`
naming the drawn element) for the 1–3 elements that carry the mapping. Use the
PR's real names, not paraphrases. Keep the punchline in the picture or dialogue;
a label names things, it doesn't explain the joke. Don't label everything.
`tracetoon comic check` requires at least one anchor term to be lettered in the
art and warns when a mapped element has no label or a term isn't in the PR.
Fictional exaggeration inside the metaphor is welcome; it must not invent real
test outcomes, measured delays, deployments, or decisions by real people.

For each of the three short concepts, state the reader's expectation, the
specific comic turn (reversal, consequence, incongruity, escalation, wordplay,
or another mechanism), and the visible clues that make it understandable.
"The bug is fixed" and "this explains the feature" are not themselves jokes.
Name one likely misreading or weak point. Choose the strongest premise before
styling it; novelty is a secondary consideration, not a reason to keep a weaker
story. A recurring layout is acceptable when it serves the best joke.

Before drawing, reconcile the synopsis, panel actions, dialogue and alt text.
List the important props/identities that stay consistent, what actually changes,
and what the reader can reasonably infer. A last remaining seat cannot be
surrounded by unexplained available seats; preservation needs recognizable
contents; waiting alone cannot establish a later retry or successful response.
Put necessary meaning in the actual scenes, not only in metadata. Do not ask
the image model to rescue an underspecified story.

This is not a requirement to show every action or to end with success. Static
contradictions, verbal jokes, inferred transitions, and unresolved technical
outcomes can work. The reader needs enough cues to understand this particular
joke without reading the PR. A caption may deliver a punchline; check whether it
adds a turn rather than merely announcing the technical lesson.

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
- **A title only when it helps.** Keep a metadata title, but choose no visible
  title, an integrated title, or a separate heading. A visible title has at most
  6 words; it need not sit at the top or dominate the art.
- **Specific beats generic.** "The panels came back in the wrong order" is funny;
  "tests pass" is not.
- **Make it relatable**: every developer knows flaky tests, a fix that needs a fix,
  or a "quick change" that wasn't. No in-jokes that need the *session history*;
  labels supply the PR context, so the comic can be about this exact change.
- **Punch at the problem, never at people.** The bug, the build, or the agent's
  own blunder are fair game. The user, other contributors and real
  companies are not.
- **Fewer words**: the whole page holds at most 50 words, headline included. If
  it doesn't read on a phone, cut.

## 2. Pick a format

Before writing the final script, compare **three genuinely different concepts**
in local `comic-design.json`: the joke, necessary story beats, composition,
cast and visual treatment, plus the chosen concept and why it wins. Use
`context.comic.recentComics` and [comic-direction.md](comic-direction.md).
These are short text concepts, not three image-generation requests.

Choose the fewest panels that tell this joke. Diff length is not panel count:
a large refactor can have a two-panel payoff; a small race fix can need five
beats. Do not pad or compress the story just to rotate a quota.

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
| `custom` | none fits; supply composition frames or describe `layout` | 1–6 |

New scripts use `composition` for actual page geometry. Its families are
`single`, `comparison`, `sequence`, `vertical`, `asymmetric`, `hero-inset`,
`diagonal` and `custom`. Presets create frames for the panel count; custom
geometry supplies frames explicitly. `layout` can refine the intent in words,
but must not contradict the geometry. The prompt and overlay renderer share it.

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

Set `styleFamily` to `ink`, `flat-color`, `painted`, `print`, `dimensional`,
`pixel`, `technical` or `custom`. Renaming the same visual treatment does not
create variety. A pinned style still allows different compositions and casts.

## 4. Characters: invent them for this comic

Every comic has its own characters, made up for this PR's joke: people,
creatures, objects with faces, or no characters at all. Never reuse characters
from an earlier comic, and don't turn the agents into recurring mascots. List
each one once in `"characters"` with a short visual description (what they look
like, what they wear, their colors), so every panel draws them the same way.
Panels and dialogue refer to them by `name`. Use fictional people, never
identifiable real people. Set each character's `kind` to `human`, `creature`
or `object`; `characters: []` means the story needs no cast.

Choose people for recognizably human situations. Use personified objects,
animals or aliens when their characteristics make this particular joke work.
Do not automatically turn a developer into another animal in office clothes.
Notice recent creature-led casts, but do not ban them or rotate species by quota.

## 5. comic.json

```json
{
  "v": 2,
  "title": "The Last Drip",
  "synopsis": "One forgotten resource handle causes an outsized leak.",
  "altText": "An enormous pristine machine nearly sinks in water from one tiny open tap.",
  "format": "splash",
  "composition": {
    "family": "single",
    "title": { "mode": "none" },
    "frames": [{ "x": 0, "y": 0, "w": 1, "h": 1, "border": "none" }]
  },
  "designReason": "One visual contradiction carries the joke; a cast and heading would distract.",
  "anchor": {
    "change": "The file reader now closes its handle after each read instead of leaking it.",
    "terms": ["file handle"],
    "mapping": [
      { "visual": "the tiny open tap", "technical": "the unclosed file handle" },
      { "visual": "the sinking machine", "technical": "the server" }
    ]
  },
  "style": "precise technical ink, a single red accent, ample negative space",
  "styleFamily": "technical",
  "palette": "bw-accent",
  "accent": "red",
  "characters": [],
  "panels": [
    {
      "scene": "A huge pristine machine nearly sinks in water from one tiny forgotten tap; one clear callout points to the tap",
      "characters": [],
      "dialogue": [
        { "speaker": "caption", "kind": "label", "points": "the tiny open tap", "text": "file handle" },
        { "speaker": "caption", "kind": "label", "points": "the sinking machine", "text": "server" },
        { "speaker": "caption", "text": "Closed after every read now." }
      ]
    }
  ]
}
```

Rules (checked by `tracetoon comic check`; warnings don't block):
- 1–6 panels and at most 6 characters. At most 4 characters and 4 text items
  per panel, 12 words per item, 50 words per page, headline at most 6 words.
- A panel's `characters` lists objects, not names:
  `{ "name": "Ada", "position": "left", "expression": "worried", "pose": "..." }`
  (`position` is `left`, `center` or `right`; `expression` and `pose` are optional).
- `speaker` is a character's `name` or `"caption"`. `kind`: `speech` (default),
  `thought`, `caption` (narration), `sfx` (a sound effect), `sign` (words on a
  screen or sign in the scene) or `label` (a callout tag, up to 4 words, whose
  `points` names the drawn element it points at).
- `anchor` (required with `composition`; local, never posted): `change` in one
  sentence, 1–4 `terms` the PR really uses, and a `mapping` of
  `{ "visual", "technical" }` pairs. At least one term must appear in the
  lettering.
- `aspect`: `4:3` (default), `1:1`, `16:9` or `3:4`; formats have sensible
  defaults. A vertical composition defaults to `3:4`.
- `composition.title.mode`: `none`, `integrated` or `heading`. An optional
  `box` is `{x,y,w,h}` in 0–1 page coordinates. `none` omits the art title from
  prompts, overlay, proofread lists and the transcript; metadata keeps its title.
- Optional `composition.frames`: one `{x,y,w,h}` per panel, in reading order,
  with positive bounds inside the 0–1 page (before the branding footer).
  A frame can use `border: "none"` and `clip: [[x,y], ...]` for a convex
  polygon in its own 0–1 coordinates. Polygon dialogue needs a safe `textBox`
  in frame coordinates. Intentional contained insets use `inset: true` (the
  `hero-inset` preset declares these itself); other overlaps are rejected.
- Legacy scripts without `composition` keep their old rendering defaults.
- No links, no @mentions, no secrets, no real people's names, no company logos,
  and no characters that look like existing cartoon, film or game characters
  (retro styles such as rubber hose make this easy to do by accident).

## 6. Make the art, then proofread

`tracetoon comic art` (see SKILL.md for consent) draws the **whole page in one
image, lettering included**, so the words look like part of the comic. Then:

1. `tracetoon comic render` adds a small "made with Tracetoon" footer bar and
   prints a **proofread** list.
2. **Look at `out/comic.png`** and check every word on the list is lettered
   exactly, with nothing extra or garbled, and that each label sits on the
   element it names. Check the actual panel count, reading
   order, title treatment, framing and payoff at PR-column and phone widths.
   A good prompt is not proof that the generated image followed it.
3. Diagnose before retrying. A weak premise or missing/contradictory action needs
   a script rewrite. A sound script drawn incorrectly needs a redraw. Wrong
   lettering needs lettering repair. Tell the user the concrete reason for an
   additional generation; do not draw routine hidden alternatives. Draw one
   finished image initially; the three concepts are text, not image requests.
   For an art defect, run `tracetoon comic art --force` to redraw (up to 2
   times). If it's still wrong, run `tracetoon comic art --lettering overlay
   --force`: the art is drawn without text and Tracetoon adds the bubbles.
4. If the art is right but drawn a little differently from a panel's `scene`
   (someone seated instead of standing, a pose that differs), don't edit
   `scene`: that changes what the image model draws from, so the art becomes
   stale. Set that panel's `drawn` to a sentence describing what the finished
   panel shows (the transcript uses it) and correct `altText`. Neither is sent
   to the image model, so no redraw is needed; run `tracetoon comic render`
   again. Art drawn by an earlier Tracetoon build is adopted the first time
   `comic render` (or `comic art`) runs, so run it once before correcting
   that text.
5. Not loving the look? `tracetoon comic reroll` keeps the story and redraws it
   in a style idea the repo hasn't used lately (`--style "<any style>"` to choose
   one, `--format`, `--palette` to change those too).
   Format changes replace incompatible geometry. If the requested format needs
   different story beats, have the drafter rewrite the script first. Changed
   scripts invalidate cached art and rendered output; do not reuse an old page
   with a newly named layout.

The independent review starts with the image alone, before the synopsis,
transcript, technical explanation, or design reasoning. The reviewer records
literal panel observations separately from inference, the perceived joke and
the software change the image suggests, then compares the script, the PR's
actual change and factual evidence. See contribution-workflow.md.
Structural checks and a matching transcript do not certify comic quality.

With your own image tool instead: `tracetoon comic prompts` prints the
whole-page prompt and where to save it (`art/page.png`). After a script change,
request prompts again, save fresh images at the listed paths, then render.
Printing prompts alone does not make an old cached drawing current.

With overlay lettering, if a bubble covers something important, write
`layout.json` to place bubbles by hand (0–1 coordinates within the panel, one
entry per text item, `null` for automatic):

```json
{ "panels": [[{ "x": 0.05, "y": 0.04, "w": 0.45 }], []] }
```

`tracetoon render` places the comic after the description, or wherever you put
`{{tracetoon:comic}}` in `body.md`, with a transcript under it. After
publishing, offer the user the share caption that `tracetoon publish` prints.
