# Changelog

Notable changes to Editmamei are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This changelog starts with the first release published from this repository. Release notes for
earlier versions are preserved in the archived wiki repository's
[releases page](https://github.com/editmamei/editmamei-wiki/releases).

## [Unreleased]

## [1.0.1] — 2026-08-08

### Fixed

- **The npm package and the one-click bundle now include the license text.** The
  1.0.0 artifacts shipped without a license file: the build staged a file named
  `LICENSE` while this repository's file is `LICENSE.md`, and the copy step
  skipped missing files silently. The staging now picks the right license file
  per edition, fails the build if a required document is absent, and tests pin
  the packaged contents so this cannot regress quietly.

### Changed

- **The user documentation moved into this repository.** Installation, getting
  started, the FAQ, the privacy notes, the Pro feature list, and the roadmap now
  live under [`docs/`](docs/), updated for the fair-source split. The old wiki
  is archived and keeps the release notes for versions before 1.0.0.
- Bug reports and feature requests now point at
  [this repository's issue tracker](https://github.com/editmamei/editmamei/issues)
  everywhere the product mentions it: `package.json`, the diagnostics bundle,
  and the CLI help text.
- The macOS test job now gates merges instead of reporting informationally.

## [1.0.0] — 2026-08-07

**The first release published from this repository, and the first released as
fair source.** Editmamei itself is not new — it has been shipping to users since
early 2026 — but its Community Edition source is public from this release
onward, under the Functional Source License with an MIT future.

`1.0.0` marks that change, not a rewrite. If you are already running Editmamei,
this is an ordinary upgrade: the tool surface, the schemas, and the behaviour
are the ones you already have.

### Added

- The Community Edition source, published: the MCP server, the tool surface, the
  Go snippet engine that generates the ExtendScript Photoshop runs, and the
  offline test suite that verifies what would be sent without opening Photoshop.
- A Contributor License Agreement and the check that enforces it. It is a licence
  grant, not an assignment — contributors keep the copyright in their work. It
  exists so the promise that every release converts to MIT after two years can
  cover the whole work.

### Fixed

- **A leftover directory could stop a verified module from loading.** When an
  installed module was regenerated, the superseded copy was deleted as part of
  the load rather than as housekeeping, so a single unreadable directory inside
  it turned a successful regeneration into a failed verification.
  - Affected macOS and Linux only; permissions do not block a directory read the
    same way on Windows.
  - The removal is now best-effort and logs instead of throwing. The path that
    restores the previous tree, which is genuinely load-critical, is unchanged.

### Internal

- The Community edition gate derives the names it must reject from a committed
  list when the commercial dispatch table is not present, so it can run in this
  repository rather than failing on a file that only exists privately.
- A guard asserts this tree contains no commercial or private paths: no
  restricted directory, no `-pro` suffixed file, no Go file carrying an
  unnegated `pro` build constraint, and no private build script.
