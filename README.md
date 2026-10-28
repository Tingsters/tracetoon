# tracetoon.com site (gh-pages branch)

This branch is the website at https://tracetoon.com. The code and docs live on `main`; do not put site files there.

## Edit the page

1. Open `index.html` on this branch in the GitHub web editor (pencil icon), or clone the repo and `git checkout gh-pages`.
2. Change the text or HTML. It is one plain file with no build step and no JavaScript.
3. Commit directly to `gh-pages`. GitHub rebuilds the site in about a minute; check Actions > "pages build and deployment".

## Do not delete

- `CNAME`: tells GitHub the site's domain. Removing it takes tracetoon.com offline.
- `.nojekyll`: keeps GitHub from processing the files.
- `tracetoon-hero.png`: the top image (the same file as `docs/tracetoon-hero.png` on `main`).

## Where the domain is managed

DNS is on Cloudflare and the registration is at Namecheap; both are managed by the homelab, not from this repo. To change records, ask Stephen.
