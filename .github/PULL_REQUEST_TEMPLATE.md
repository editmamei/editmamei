<!--
This title and description become the permanent commit message.

Pull requests are squash-merged, so what you write here — title and body — is
exactly what lands in the public history. There is no separate merge commit
message to fix later. Use a Conventional Commits title
(https://www.conventionalcommits.org), and write the body for a stranger
reading it a year from now with no context beyond this repository: state the
problem and why this approach solves it. The diff already shows what changed,
so leave out process narration ("addressed review comments", "all checks
green"), machine-generated attribution trailers, and assistant session or
share links (e.g. a pasted claude.ai/share URL) — a bot checks the title and
body for these on every push.

Commits on your branch can be as messy as you like — they don't survive the
squash.
-->

## What

<!-- What changed, in terms someone unfamiliar with this PR can follow. -->

## Why

<!-- The problem this solves, or the capability it adds. Not "how" — the diff shows that. -->

## Checklist

- [ ] `npm run build` then `npm test` pass locally (build first — spec tests skip silently without the compiled Go binary)
- [ ] `npm run lint` and `npm run typecheck` pass locally
- [ ] Added or updated a test for anything behavioral
- [ ] I've signed the [CLA](https://github.com/editmamei/editmamei/blob/dev/CLA.md), or the CLA bot will prompt me on this PR (it blocks merge until signed)
