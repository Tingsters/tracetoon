# Art direction: let the joke shape the page

These sources are creative references, not contribution or submission policies.
They are optional background reading; do not crawl them for every PR. Borrow
storytelling principles, not the creator's characters, jokes or page artwork.

| Reference | What to study | Use in Tracetoon |
|---|---|---|
| [xkcd: Dependency](https://xkcd.com/2347/) | One characterless visual metaphor whose labels ("all modern digital infrastructure", one tiny project) carry the meaning | Abstraction plus labels: the labels deliver the joke instead of killing it |
| [Julia Evans: Teaching tech with cartoons](https://jvns.ca/teach-tech-with-cartoons/) | System parts as characters, with their real names (etcd, mutex); a warning that a cartoon can be fun and explain nothing | Personify the PR's actual components and name them |
| [Lin Clark: Code Cartoons](https://code-cartoons.com/) | Friendly metaphors for engine and browser internals, every part labeled with its technical name | A near metaphor, labeled, explains a mechanism without a lecture |
| [PBF: The Report](https://pbfcomics.com/comics/the-report/) | Two smaller setup panels lead to a larger payoff | Give the reveal more space when it needs it |
| [Sarah's Scribbles: Spooky Cute](https://tapas.io/episode/1908294) | A human reaction completes a short visual pattern | Fictional people make ordinary human situations readable |
| [Poorly Drawn Lines: Cute Animals](https://poorlydrawnlines.com/comic/cute-animals/) | The animal premise is part of the joke; a wide opening leads into smaller panels | Use creatures for a reason, not as default developers |
| [The Oatmeal: Brainstorming](https://theoatmeal.com/comics/creativity_brainstorming) | Borderless scenes, short sequences and whitespace mix within one explanation | Use varying frames and spacing without turning the PR into a long illustrated report |
| [MediBang: Frame layout and screen](https://medibangpaint.com/en/use/2021/09/mangatutorialforbeginners06/) | Different geometry for everyday scenes, action and explanation; diagonal cuts, bleed and camera changes | Match the composition to the scene and keep the reading path clear |
| [Steve Ellis: Panels, gutters and flow](https://www.clipstudio.net/how-to-draw/archives/160963) | Insets, dominant panels, silhouette, borderless moments and gutter timing | Geometry is storytelling, not decoration |
| [CLIP STUDIO: Vertical webtoons](https://www.clipstudio.net/how-to-draw/archives/157055) | Deliberate vertical order and space for pauses on small screens | A compact vertical sequence can make a quiet beat work |

References reviewed October 25–26, 2026. This is a representative creative sample,
not a claim about which cast or layout is statistically most successful.

## Make three distinct proposals, then draw one

Use this selection order: technical anchor and the PR test (can a developer
name the change from the comic alone?), understandable premise and comic turn,
economical visible storytelling, then art direction and recent variety. Keep a
short evidence reference, the anchor (change, real terms, what each drawn
element stands for), metaphor distance, expected reader assumption, payoff,
necessary visible clues, and likely failure for each concept. Explain why the
winner both points at the change and has the strongest joke, not only why its
format is novel. A funnier concept that fails the PR test loses to a
slightly less funny one that passes it. These are
editorial judgments, not a numeric humor score or a rotation quota.

Write brief candidates to `comic-design.json` in the local run: the anchor
and PR-test result, the joke, necessary beats, frame arrangement, visible-title treatment, cast, visual style
and why each could work. Choose one and state why it beats the other two.
Put its concise reason in `comic.json.designReason`. This reasoning stays local;
only compact categorical creative metadata is posted with the approved comic.

The candidates must differ in premise or visual storytelling, not just colors
or a new animal species. Compare them with the last five available
`recentComics`. Repetition warnings are advisory: keep a repeated choice when
the story earns it, especially when a user pinned the style. Missing legacy or
offline history is unknown, not evidence of novelty.

## Useful starting compositions

- One visual contradiction: single scene, possibly borderless and titleless.
- Clearly changed behavior: two matched before/after frames.
- A pause or delayed reaction: vertical sequence with deliberate space.
- Misdirection and a reveal: unequal frames with a dominant final panel.
- Overall context plus important details: hero panel with contained insets.
- Contrast or fast motion: a diagonal split with clear, safe lettering areas.

These are starting points, not a rotation schedule. Select the minimum number
of beats needed for one faithful joke; a large PR does not require a long comic.
Use English left-to-right/top-to-bottom reading order even for manga-inspired
art. Keep the current 1–6 panels and 50 displayed words. The metadata title need
not be a visible headline, and a visible title need not be large or at the top.

People, creatures, personified objects and characterless diagrams are all valid.
Use people for human interactions; objects when the system carries the joke
(often the nearest metaphor: the actual hook, server, job or cache, labeled);
creatures when their particular traits or metaphor help. Do not replace one
unvarying mascot with a quota of other species.

The final visual check matters: attractive hierarchy, readable text and labels
at PR and phone widths, unambiguous sequencing, no invented outcome, an actual
payoff, and a picture that points at the change.
Generate one finished image after selection; redraw only for a concrete problem
or an explicit user reroll. The existing consent and preview approval apply.
