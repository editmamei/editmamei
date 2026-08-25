# Changelog

Notable changes to Editmamei are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This changelog starts with the first release published from this repository. Release notes for
earlier versions are preserved in the archived wiki repository's
[releases page](https://github.com/editmamei/editmamei-wiki/releases).

## [Unreleased]

## [1.2.1] — 2026-08-25

### Fixed

- **A Pro module newer than the app no longer costs you Pro entirely.** A module built after your
  installed version could register a tool the app did not recognise, and the app responded by
  rolling back the whole module at every start, dropping a paying subscriber to Community.
  - Unrecognised tools are now skipped one at a time with a warning and the rest of the module
    loads. The all-or-nothing rollback remains for a module at or below the app's version, where
    re-downloading it genuinely does fix the problem.
  - Re-downloading could never cure the newer-module case, because the installed module already
    matched what the server offered — so the app stayed in Community every start until it was
    updated by hand.
  - This protects future versions from the same class of problem. If you are already affected,
    installing this release is what clears it.

- **Reading the scene no longer runs out of time on a large document.** `ps_read_scene` worked out
  every selectable region before it answered, which on a big layered file consumed most of the
  thirty seconds Photoshop allows a script and often failed outright.
  - Measured on a 4898×3265 layered document: about thirty seconds before, around five after.
  - Three of the seven regions it derived up front routinely resolved to nothing, so a large part
    of that wait bought nothing at all.

### Changed

- **The scene read now offers regions and works each one out when you ask for it.** It reports what
  it can select rather than selecting everything in advance; the first request for a region pays
  for that region, and repeats are immediate.
  - Because nothing has been measured yet, an offered region carries no confidence score and is
    marked `candidate`. It is a candidate, not a promise — `ps_select_by_reference` still scores it
    and can still report honest absence.
  - Pass `save_regions: true` to `ps_read_scene` for the previous behaviour, where every region is
    derived and scored in one call.
  - A region worked out this way is remembered for the rest of the session, so asking for it again
    is instant. Pass `refresh: true` if you have changed the image in a way that changes what the
    region means.

### Added

- **A document can be closed by name or id, not only whichever one is in front.** `ps_close_document`
  takes an optional `name` or `id`, so closing one file out of several no longer means bringing it
  to the front first.
  - If two open documents share a name, the call fails and says so rather than guessing. Photoshop
    permits duplicate names, and picking one silently would send later edits to the wrong file.

- **Release notes are linked from the command line and the update notice.** `editmamei --help` now
  lists them beside Docs and Issues, and the notice shown when an update is available points at
  them too.

## [1.2.0] — 2026-08-23

### Added

- **`ps_batch` runs an edit over a folder of images as one Photoshop batch (Pro).** A recipe is
  turned into a Photoshop Action and handed to Photoshop once, so a set of images costs one
  round trip rather than one per file.
  - Ops are `run`, `preview`, and `export_action`. `preview` reports what would be processed
    without touching anything.
  - Files a percent-based crop would ruin are skipped rather than silently mangled, and the run
    reports which ones and why.
  - Large sets are processed in chunks.

### Changed

- **`ps_ping` stops waiting on a Photoshop that isn't there.** The liveness question could
  previously wait out the full script budget — about thirty seconds — and even start Photoshop as
  a side effect. When a detected install has no running process, the ping now skips the script
  round trip and says so, with no launch attempt; only the first ping of a session still spends up
  to a few seconds on the startup version check it reports. A Photoshop that is running but still
  starting up keeps the full budget, since a cold start legitimately takes longer than any short
  cutoff would allow.

### Removed

- **The eight tool names superseded by `ps_filter`, `ps_group`, and `ps_text` in 1.1.0 are gone.**
  Call the op-discriminated tool instead:
  - `ps_apply_filter` → `ps_filter`
  - `ps_create_group` → `ps_group(op=create)`
  - `ps_move_layer_to_group` → `ps_group(op=add_layer)`
  - `ps_set_group_blend_mode` → `ps_group(op=set_blend_mode)`
  - `ps_ungroup` → `ps_group(op=ungroup)`
  - `ps_delete_group` → `ps_group(op=delete)`
  - `ps_create_text_layer` → `ps_text(op=create)`
  - `ps_set_text` → `ps_text(op=set_font / set_color / set_alignment / set_content)`

### Fixed

- **The update notice now reaches the session that should see it.** The startup version check
  raced the first `ps_ping` of a session and usually lost, so the one ping most sessions make
  never carried the notice. The first ping now waits for the check (bounded at four seconds),
  asks for the notice to be relayed (`notify_user` in the result), and — when the previous
  session's failures are among the fixes the newer version ships — names them, so the reason to
  update is the one you already felt. The check is still a single request to the public npm
  registry, and reading the previous session's log never leaves this machine.

- **Layer names containing non-ASCII characters now survive the round trip on Windows.** A layer
  Photoshop named itself in a non-English UI — `Farbfüllung 1`, `Kopie` — came back with the
  accented characters replaced by `?`, so naming that layer in the next call could not match it.
  Names are now escaped at both script boundaries and arrive intact.

- **`ps_delete_layer` no longer deletes a group.** When the given name matched a group rather than
  a layer, the group and everything inside it was removed and the call reported success. It now
  declines and says the name is a group; use `ps_group(op=delete)` to delete one deliberately.

- **`ps_group(op=add_layer)` now prefers a layer over a same-named group** when resolving
  `layer_name`, instead of letting the layer order decide which one moves. A group is still moved
  when nothing else matches the name, so nesting one group inside another works as before.

- **A layer-not-found error now spells the missing name the way you would send it back.**
  Non-ASCII characters in the "Have:" list were shown as escape sequences, which could not be used
  verbatim in the retry.

## [1.1.0] — 2026-08-14

### Added

- **Filters applied to a Smart Object can now be changed after the fact.** A Smart Filter can be
  listed, hidden, re-blended and removed without rasterizing the layer or starting the edit again.
  - `ps_filter` gains `op: list | set_visibility | set_blend | remove` alongside the default
    `op: apply`, and `as_smart_filter` applies a filter to a Smart Object non-destructively.
  - `ps_inspect` gains `what=smart_object` for reading a layer's Smart Object state.
  - Removing a filter renumbers the ones above it, so re-read the list before the next call that
    takes an index.

- **A clipped layer can be unclipped.** Releasing a clipping mask now ships; previously a layer
  could be clipped with no way to reverse it except the Photoshop menu or an undo.
  - `ps_clipping_mask` takes `op: create | release`. Both do nothing rather than fail when the
    layer is already in the requested state.
  - Releasing a layer in the middle of a clipping chain also releases the layers above it, which
    is Photoshop's own behaviour.

- **A failed layer lookup names the layers that exist.** Asking for a layer by a name that is not
  in the document now answers with the available names instead of only reporting the miss.

### Changed

- **Editmamei now requires Node 22 or newer.** Node 20 reached end of life on 2026-04-30, so it is
  no longer a supported runtime; installing on Node 20 will fail the engine check.
  - Dependency major versions are pinned, so routine updates stay on minor and patch releases.

- **Filters, layer groups and text each work through one tool instead of several.** Related
  operations sit behind a single name with an `op` argument, so there is one obvious tool per
  subject rather than several with similar names.
  - `ps_filter`, `ps_group` and `ps_text` are the names to use. The previous names still work for
    this release and will be removed in the next one.
  - `grow` and `similar` move to `ps_modify_selection`, which is where the rest of the
    change-an-existing-selection modes live; both are still accepted on `ps_select` for this
    release.

- **Editing a raw-sourced photo starts with a develop pass.** Opening a raw file now steers the
  first tonal step through Camera Raw rather than a layer adjustment, which is where raw files
  hold their latitude.

### Fixed

- **Error messages more often say what actually went wrong.** Failures raised by the scripting
  engine are matched against the wording Photoshop really emits, so more of them arrive as a
  specific cause instead of a generic failure.

- **Startup and connection checks no longer report a success they did not confirm.** The
  Photoshop version and reachability probes report only what they verified, and concurrent probes
  share one round trip instead of racing.

## [1.0.3] — 2026-08-08

### Fixed

- **Editmamei can now be listed in the official MCP registry.** The published
  package was missing the `mcpName` field, which the registry reads to confirm
  that an npm package and a registry entry belong to the same project.
  - The build assembles the published `package.json` from an explicit list of
    fields. `mcpName` was not on that list, so it was dropped from every
    release up to 1.0.2 even though the repository declared it.
  - Published npm versions cannot be changed, so the field appears for the
    first time in this release.

## [1.0.2] — 2026-08-08

### Fixed

- **Editmamei now starts on a machine where Photoshop cannot be installed.** It
  completes the handshake and answers a tool listing, then fails each tool call
  with a message naming the reason, instead of failing at startup.
  - The Photoshop connection is built on first use rather than at boot, so an
    unreachable Photoshop is reported per call rather than preventing the server
    from running at all.
  - This is what lets an MCP directory enumerate the tool surface in a Linux
    sandbox, where Photoshop does not exist.

### Changed

- **The engineering notes cited in the source comments are published.** The
  ActionManager descriptor conventions, the ExtendScript wrapper contract, and
  the tool design rules now live under
  [`docs/engineering/`](docs/engineering/), so those references resolve.

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
