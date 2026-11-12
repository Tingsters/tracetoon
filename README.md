# tracetoon.com site (gh-pages branch)

This branch is the website at https://tracetoon.com. The code and docs live on `main`; do not put site files there.

## Pages

- `index.html`: the landing page. Plain HTML with inline CSS and one small inline script for the install tabs and copy buttons. The page still works with JavaScript off. No build step.
- `evidence-graph.html`: the evidence graph results write-up, linked from the landing page as "Results". It is an export of the article with a site nav bar added. Mermaid loads from jsDelivr.

## Edit a page

1. Open the file on this branch in the GitHub web editor (pencil icon), or clone the repo and `git checkout gh-pages`.
2. Change the text or HTML.
3. Commit directly to `gh-pages`. GitHub rebuilds the site in about a minute; check Actions > "pages build and deployment".

Every number on the landing page comes from `evidence-graph.html` (round 23, the shipped build). If you change one, change both.

## Images

- `img/hero.webp`: the "No more PR slop" top image (from `docs/tracetoon-hero.png` on `main`).
- `img/comic-*.webp`: one comic per section (quality, graph, embedded, cost, workflow, pr17). To swap one, keep the file name, or update the `src`, `width`, `height` and `alt` in `index.html`. Use WebP at about 1400 px wide and under 250 KB: `cwebp -q 80 -resize 1400 0 in.png -o img/comic-x.webp`.
- `img/og-image.png`: the 1200×630 card shown when the link is shared.
- `favicon.svg`: the receipt logo, also used in the top bar.

## Do not delete

- `CNAME`: tells GitHub the site's domain. Removing it takes tracetoon.com offline.
- `.nojekyll`: keeps GitHub from processing the files.
- `tracetoon-hero.png`: the original top image. Older links may point to it.

## Where the domain is managed

DNS is on Cloudflare and the registration is at Namecheap; both are managed by the homelab, not from this repo. To change records, ask Stephen.
