# Contributing to Editmamei

Thanks for considering a contribution. This repository is the Community Edition source of
Editmamei, a Photoshop MCP server, and the source is published here. Bug reports, fixes, and
well-scoped improvements are all welcome.

## Before you start

Small fixes move fast. A typo, a clear bug fix, a failing edge case with a test: open a pull
request directly. Anything that adds a tool, changes the tool surface, or alters behavior users
depend on: open an issue first so we can agree on the shape before you spend an evening on it.
Declining a thoughtful PR on direction is a waste of your time that we would rather prevent.

You will need to sign the [CLA](CLA.md). A bot checks it on your first pull request and blocks
the merge until it is signed — you sign by posting one comment, once, and it covers everything
you contribute afterwards. The Contributor License Agreement is a license grant, not a copyright
assignment, so you keep ownership of your work. It exists because this project makes a binding
promise that every released version converts to the MIT license two years after its release, and
that promise can only cover code we hold the rights to.

Your contribution ships under the [FSL-1.1-MIT](LICENSE.md) like the rest of the CE source, and
converts to MIT on the same two-year schedule.

## What is in this repository

The CE host, the CE Go snippet core, the test suite, and the CE build scripts. Editmamei Pro is a
separate commercial module whose source is not published here. CE never imports Pro, so this tree
builds and runs on its own.

Pull requests that add Pro functionality to CE will be declined. A feature request explaining the
workflow you are missing is genuinely useful, though.

## Getting set up

```sh
npm install
npm run build
npm test
```

You need Node 20 or newer and a Go toolchain. `npm run build` compiles the `editmamei-core` Go
binary that the server calls at runtime. It warns instead of failing when Go is missing, so a
docs or test-only contributor is not blocked, but you will need Go to exercise anything that
emits ExtendScript.

The Vitest suite runs entirely without Photoshop, which is what makes it fast and what limits it.
It verifies the ExtendScript we generate, never that Photoshop accepted it. If your change
touches snippet generation, say so in the PR and describe what you tested against a real
Photoshop, including the version and platform. A maintainer will validate on the platforms you
could not reach.

## Pull requests

- Branch from `dev`. `main` is the released branch.
- Keep the suite green. `npm test`, `npm run lint`, and `npm run typecheck` all pass before you
  open the PR.
- Add a test for anything behavioral. A bug fix without a regression test tends to come back.
- Write the PR title and description as the permanent commit message. Pull requests are
  squash-merged, so the title and description are exactly what lands in the public history. Use a
  [Conventional Commits](https://www.conventionalcommits.org) title, and explain in the body what
  problem you hit and why you solved it this way.
- Commits on your branch can be as messy as you like. They do not survive the squash.

Run `git config core.hooksPath .githooks` once per clone to pick up the repository's hooks.

### What belongs in the permanent message

This repository does not rewrite published history, so the squashed message is permanent. A good
one states the problem and why this approach solves it, in terms a stranger can follow with no
context beyond this repository. The diff already shows what changed.

Leave out anything that will not mean anything to a reader a year from now: process narration
("addressed the review comments", "all checks green"), references to documents or trackers that
are not public here, and machine-generated attribution trailers. The same applies to code
comments, which are read far more often than they are written. A comment should explain a
constraint the code itself cannot express.

A `commit-msg` hook catches the mechanical cases, but it is only a safety net; review is the
real check.

## Architecture orientation

Useful before your first non-trivial change:

1. An MCP client calls a tool over stdio. `EditmameiServer` (`src/core/server.ts`) dispatches
   through `ToolRegistry`.
2. The handler builds an ExtendScript snippet via the Go core, which compiles its templates from
   `go-core/cmd/buildtemplates/`.
3. `ExtendScriptPhotoshopAPI` (`src/api/photoshop-api.ts`) wraps the snippet with a standard
   preamble and postamble, then hands it to `PhotoshopConnection`.
4. A platform executor runs it (COM plus VBScript on Windows, AppleScript on macOS) and parses
   the result back through MCP.

All logging goes to stderr, via `src/utils/logger.ts`. stdout is the MCP JSON-RPC channel, so a
stray `console.log` corrupts the protocol.

### Engineering notes

The hard-won conventions and landmines behind the code — the ExtendScript wrapper contract, the
ActionManager descriptor gotchas, and the tool-design rules (consolidation, auto-duplicate-first,
context return, the MCP surface contract) — live under [`docs/engineering/`](docs/engineering/).
Read the relevant one before touching `src/api/**`, `go-core/**`, or `src/tools/**`; the source
comments in those areas point back to specific sections.

## Code conventions

- TypeScript is strict ESM. Relative imports carry a `.js` extension even though the sources are
  `.ts`.
- New tools use the `ps_` prefix, verb first, and must be classified in `src/core/tool-tiers.ts`
  and grouped in `src/core/tool-groups.ts`. The server refuses to boot otherwise.
- Match the surrounding code. Comment density, naming, and idiom should look like the file you
  are editing rather than like a different project.

If you use a coding agent, point it at this file and at [`docs/engineering/`](docs/engineering/).
The repository intentionally ships no agent-specific instruction file — the rules everyone
follows live in this file and in `docs/engineering/`, not in a file only an agent reads.

## Reporting bugs

Open an issue and include:

- The diagnostic bundle from `editmamei report`, which writes an anonymized file to your
  Downloads folder with system info, recent session summaries, and a log tail. Attach it, or
  paste the parts you are comfortable sharing.
- Your Photoshop version and MCP client (Claude Desktop, Cursor, Claude Code, and so on).
- A minimal reproduction. A single prompt that reliably triggers the problem is ideal.

If you would rather assemble it yourself, the relevant slice of your session log at
`~/.editmamei/sessions/<session-id>.ndjson` is usually what we need. Scrub it before pasting,
since paths in there can contain your username and client folder names.

Issues are public, so please do not paste license keys, sensitive file paths, or screenshots of
unreleased client work.

## Security

Do not open a public issue for a security-impacting bug. See [SECURITY.md](SECURITY.md) for the
disclosure process.

## Code of conduct

There is no formal code-of-conduct document yet. The short version: be decent. Technical
disagreement is welcome and useful. Harassment and bad-faith engagement are not, and will get
issues closed or contributors blocked. If you experience or witness something along those lines,
email support@editmamei.com.

## A note on terminology

Editmamei is *fair source*, or *source-available*. It is not open source under the OSI
definition, and we do not describe it that way. The license lets you read, run, modify, and
redistribute the code for nearly anything, and holds back only commercial offerings that compete
with Editmamei CE or Pro, for two years per release. The [README](README.md) has the plain
English summary, and [LICENSE.md](LICENSE.md) is the governing text.
