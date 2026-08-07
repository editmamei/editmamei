# Changelog

Notable changes to Editmamei are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This changelog starts with the first release published from this repository. Release notes for
earlier versions are on the
[releases page](https://github.com/editmamei/editmamei-wiki/releases).

## [Unreleased]

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
