# ActionManager descriptor conventions

Adobe does not document the ActionManager (AM) event surface. Every event ID, descriptor key, and
enum value this codebase emits was reverse-engineered from ScriptListener captures against a real,
running Photoshop, from forum posts and old scripting guides of varying reliability, or from
trial and error. That means two things for anyone touching `src/api/**`, `go-core/**`, or
`src/spec/**`: treat an unverified event ID as a guess until it's checked against real Photoshop,
and once you *have* checked it, pin it so a later refactor can't silently regress it back to the
guess.

## DOM vs. AM

Prefer Photoshop's DOM API (`app.activeDocument...`) over a raw AM descriptor whenever a robust,
coordinate-free DOM equivalent exists. `doc.guides.add(direction, coordinate)` is the example: the
AM `Mk` path for adding a guide bakes a runtime document ID and guide index into the descriptor,
which is more brittle than the DOM call for no benefit. Default to AM descriptors for anything the
DOM doesn't expose — most adjustment layers, most selection operations, and most filters.

## Create-with-values vs. create-then-modify

Photoshop's own UI usually emits a *sequence* of two AM events for something like adding an
adjustment layer: a `Mk` (make) with the type's default descriptor, immediately followed by a
`setd` (set) carrying the values the user actually chose. Editmamei generally prefers folding the
values into the initial `Mk` descriptor instead — one atomic event instead of two, and one less
place for a mid-sequence failure to leave a half-configured layer. Both forms are accepted by
Photoshop; use whichever is clearer for the operation, but understand the tradeoff.

When you do use create-then-modify, **the `setd` target class is what determines whether it works
at all.** Targeting `AdjL` (the adjustment layer's own contents) modifies the adjustment; targeting
`Lyr ` (a bare layer reference) routes through Photoshop's "bake into pixels" path instead — the
same path `Image > Adjustments > ...` uses. That bake path **silently no-ops when the active layer
has no pixels**, which is exactly true of a freshly created adjustment layer: Photoshop reports
success and nothing happens. A `setd` that targets `Lyr ` against an adjustment layer is a
convincing-looking no-op, not a working call.

**A thrown-nothing AM call is not evidence that it took effect.** Verify tonally (a histogram
read, a pixel sample, a rendered preview) or not at all — a caught exception proves failure, but
the absence of one proves nothing about whether Photoshop actually did what you asked.

## The Hst2 / Hsrt gotcha

The master entry in a Hue/Saturation adjustment's `Adjs` list uses charID `Hst2` in modern
Photoshop. Older scripting references document `Hsrt` instead. Modern Photoshop **silently
ignores** `Hsrt` — the surrounding event succeeds, no error fires, and the values simply never
land. This is the canonical example of why a scripting reference from an old book or forum post
is a hypothesis, not ground truth: it has to be checked against ScriptListener output from a
current Photoshop before you rely on it.

## Forum-lore event IDs — verify before shipping

Any AM event ID, descriptor key, or structure sourced from a forum post, an old PDF, or "this
worked on an older version" lore is unverified until it's been confirmed against a ScriptListener
capture of the real menu action in a current Photoshop, on the platform you're targeting. Shipping
an unverified descriptor risks a silent no-op indistinguishable from a working call — Photoshop
returns success either way. When you add or fix an AM-event snippet:

- Capture the real event via Photoshop's ScriptListener plugin, driving the equivalent menu
  action by hand.
- Pin the event ID and structure with a regression test, and where a prior version shipped a
  wrong ID or key, add a `.not.toContain(...)` guard against the specific wrong value so a future
  refactor can't silently revert the fix.
- Update the corresponding spec (see below) so the pinned ground truth is discoverable, not just
  encoded in a test assertion.

ScriptListener itself has a gap worth knowing about: it only captures menu- and UI-initiated
dispatches. A script-injected `executeAction` call (the path Editmamei itself uses) does not show
up in a ScriptListener log, so you cannot piggyback on an automated session to capture ground
truth — it has to come from a deliberate, human-driven menu action.

## The spec library — the durable record of ground truth

[`src/spec/`](../../src/spec/) is where verified AM event ground truth lives long-term, so the
same landmine doesn't get rediscovered every time someone touches a snippet. Each PS-version
directory (`src/spec/ps27/<category>/<event>.ts`) holds one `AmEventSpec` per event: the event
sequence, descriptor field types and units, required vs. optional keys, and any known gotchas —
all sourced from a real capture, with the Photoshop version, platform, and source log recorded.
`src/spec/types.ts` defines the shape (`AmEventSpec`, `AmField`, `AmTypeID`, and friends).
[`src/spec/ps27/adjustments/hue-saturation.ts`](../../src/spec/ps27/adjustments/hue-saturation.ts)
is a good example to read first — it documents the Hst2/Hsrt gotcha above inline, in context.

When Photoshop ships a new major version, the process is: copy the previous version's spec
directory, re-capture each event against the new version, and diff — most events are stable
across majors, but Adobe does occasionally rotate a key or a type.

## Where the runtime snippets actually live

The Go core (`go-core/cmd/buildtemplates/fragments_*.go`, compiled into the binary's embedded
template set) is what runs at request time. Some tests assert against a TypeScript-side snippet
definition instead of the compiled Go template — that comparison exists to pin a known-good
snippet body for regression purposes, but it is not itself proof that the Go runtime path emits
the same thing. When a test passes against the TypeScript side, that tells you the assertion is
internally consistent, not that the live Go-generated snippet is correct. Cross-check both sides
when you touch a snippet that has one.
