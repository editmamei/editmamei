# Tool design conventions

Conventions for adding to or changing the MCP tool surface (`src/tools/**`). A tool is registered
by a `create*Tools(connection)` factory returning `ToolDefinition`s to the `ToolRegistry`; every
registered tool must be classified in `src/core/tool-tiers.ts` and grouped in
`src/core/tool-groups.ts`, or the server refuses to boot. This doc covers the design conventions
that shape what a new tool should look like, beyond that registration mechanics.

## Tool consolidation — the altitude rule

The question every new operation raises is: does this need a new standalone tool, or a new
discriminator value (`type` / `mode` / `op` / `property`) on an existing one? Merge a family into
one discriminated tool only when **all five** of these hold:

1. **Same verb, same object** — every variant is "do *one action* to *one kind of target*,"
   differing only by an enum value.
2. **Param sets overlap heavily** — the union schema isn't mostly-empty on any given call.
3. **Same safety class** — all read-only, or all destructive with the *same* guard. Don't put a
   reader and a baking (pixel-modifying) operation behind one tool name *when they are about
   different things*. Read/write on the SAME noun is fine and is the established pattern:
   `ps_path` ships `list` beside `delete` and `stroke`, `ps_vector_mask` ships `add` beside
   `delete`, `ps_filter` ships `list` beside `remove`. What this criterion rules out is a tool
   that has quietly become an unrelated getter bolted onto an unrelated baker.
4. **Same tier** — a tool has one tier (see below); never merge tools that ship in different
   editions.
5. **Same output-shape family** — one output shape, or a clean discriminated union, not several
   unrelated shapes forced together.

If a candidate operation has a distinct verb, a divergent param or output shape, or a different
safety class, it should stay a separate tool — a genuinely distinct operation *should* be its own
tool; that isn't a failure to consolidate. As a smell test in the other direction: if a
discriminated union ends up with more than about four wildly different param sets, or a person
reading only the schema can't tell which params apply to which discriminator value, it's
over-merged and should be split back apart.

"Wildly different" is doing the work in that sentence, and it means *semantically unrelated* — not
merely numerous. A large family of same-noun variants is not over-merged so long as each
discriminator value's own description states which params it takes: `ps_filter` carries 18 filter
types alongside five ops and is correctly one tool, because every one of them is still "a filter on
this layer." Count the unrelated *ideas* behind the discriminator, not the number of values.

**Read this section against the surface, not just literally.** The five criteria are a checklist
for a judgement, not a scoring rubric — applying them strictly, one at a time, will tell you to
split tools this codebase has deliberately merged. The decisive question is the one the criteria
are proxies for: **would an AI assistant pick correctly more often with one tool or with two?**
Two tools whose names differ by a word, in the same group and the same tier, are the failure mode
worth avoiding — that is what motivated folding the Smart Filter operations into `ps_filter`
(2026-08-09). Creating a filter and managing the resulting stack had been two tools whose names
differed by two letters, and a reader could not tell from either name which one did what.

Consolidation (which tools exist) and grouping (`src/core/tool-groups.ts`, how the tool surface is
organized and presented) are separate axes — changing one doesn't imply changing the other.

## Auto-duplicate-first pattern

Every destructive, pixel-modifying tool defaults to operating on a **duplicate** of the active
layer rather than the layer itself. The original is preserved; the operation runs on a freshly
named copy (`"<Op Name> (<Original Layer Name>)"`); undoing the effect is as simple as deleting
the copy. This is what the filter family (`ps_filter` op=apply and its Gaussian blur / sharpen /
noise / lens blur / etc. variants) and the retouch family (content-aware fill, patch, move) do —
`duplicateForOp` on the Go side, mirrored by the equivalent helper in
[`src/api/extendscript/_helpers.ts`](../../src/api/extendscript/_helpers.ts) for the tools that
still interpolate TypeScript-side snippets directly.

A tool following this pattern needs:

- **Input schema**: `apply_to_active_layer: boolean`, default `false` — the escape hatch for a
  caller that explicitly wants the historical bake-directly-into-the-active-layer behavior.
- **Output schema**: `target_was_copy: boolean`, `target_layer_name: string`,
  `original_layer_name: string` — so the caller can see which layer the operation actually landed
  on.

Any new destructive tool should follow this pattern. An exception needs a documented reason in
the tool's own description or spec — for example, an operation that is conceptually in-place by
nature (applying a mask merges it into the layer's alpha; there's no meaningful "duplicate" of
that action), or an adjustment layer, which never needs this pattern at all because adjustment
layers are already non-destructive in Photoshop's data model.

## Context-return contract

Tools return context — the active document and active layer's current state — so the calling
model can keep its picture of the document fresh without a separate query. The rule for how much:

- Tools that change **what is active** or **what exists** (create/delete/duplicate a layer,
  select a different layer, open/close/save/export a document, create or apply a mask, add an
  adjustment layer or layer style, rasterize/merge/flatten, crop/resize, move a layer to a new
  position, undo/redo, and any pure "get info" tool) return the **full** context payload —
  bounds, opacity, blend mode, kind, lock state, and document dimensions/mode/layer count/selection
  state.
- Tools that only mutate a **property** of the already-active layer, without changing what's
  active — property setters (opacity, blend mode, visibility, lock, rename, text properties, fill),
  pure filters, pure selection operations, and pure relative transforms (move/rotate/scale by a
  delta) — are **exempt** from that requirement. Exempt means "not required to return full
  context," not "forbidden from" — a tool can always return more than the minimum. The rationale
  is that a caller invoking one of these already knows what's active from the prior call's result;
  re-sending the full payload on every call is pure repetition that costs context budget without
  adding information.

If you're adding a tool and unsure which bucket it falls in, ask whether a caller who already knew
the document state before this call could be surprised about *what exists* or *what's active*
after it. If yes, return full context. If the answer is only "some property of the same thing I
was already looking at changed," the minimal payload is enough.

## MCP tool-surface contract

Every registered tool needs, at minimum:

- **`name`** — non-empty.
- **`description`** — specific about *when* to use this tool versus its alternatives. Aim for
  roughly 100–400 characters on anything non-trivial; a one-line description is only appropriate
  for a completely unambiguous primitive.
- **`inputSchema`** — `type: 'object'`, snake_case field names, enums where the value is
  constrained, `default` declared whenever the handler has one, and numeric ranges constrained
  with `minimum`/`maximum` where they're bounded.
- **`outputSchema`** — the JSON shape the tool returns, so a caller can program against structured
  output rather than parsing prose.
- **`annotations`** — at minimum a `title`; set `readOnlyHint`, `destructiveHint`,
  `idempotentHint`, and `openWorldHint` wherever they apply.

This shape is asserted for every tool a factory returns — see `assertToolShape` in the shared test
fixtures — so a new tool missing an `outputSchema` or a `title` annotation fails its factory's test
immediately rather than shipping quietly incomplete.
