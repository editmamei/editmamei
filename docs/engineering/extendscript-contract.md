# The ExtendScript wrapper contract

Every script Editmamei sends to Photoshop passes through one wrapper before it reaches the
application: `wrapInErrorHandling` in [`src/api/photoshop-api.ts`](../../src/api/photoshop-api.ts).
It adds a preamble and postamble around the snippet body. If you're writing or reviewing a
snippet — TypeScript-side in [`src/api/extendscript/_helpers.ts`](../../src/api/extendscript/_helpers.ts)
or Go-side under [`go-core/cmd/buildtemplates/`](../../go-core/cmd/buildtemplates/) — these are the
guarantees you can rely on and the conventions to follow.

## Return value capture

Three patterns get a value back to the caller, in order of preference:

1. **Top-level `return X;`** inside the snippet body. Preferred for go-core-emitted snippets.
2. **Side channel**: assign to `$.__mcp__ = value;` from anywhere, including inside nested IIFEs.
   The wrapper reads it and clears it after the snippet body runs.
3. **Bare IIFE auto-wrap**: the `executeCustomScript` path wraps a bare
   `(function(){ ...; return X; })();` expression automatically, so `return` inside it also
   surfaces.

## Errors: just throw

A snippet needs nothing special to report failure — throw an `Error` (or anything with a
`message`) and the wrapper catches it. The catch block reads `error.message`, `error.number`, and
`error.line` where present and returns them in a structured envelope (see below).

**Do not hand-roll an `'ERROR:'`-prefixed string as a return value.** That prefix is reserved: it
now means *the runner never reached Photoshop at all* — a transport failure, decoded by
[`decodeScriptResult`](../../src/platform/script-result.ts) before the envelope logic even runs.
A snippet that legitimately wants to return a string beginning with those characters is safe and
gets it back verbatim, because every outcome — success or in-script failure — is wrapped in a
tagged envelope (`{ __em: 1, ok, value | error }`). The envelope is what lets a real return value
be told apart from a report about how the script ended; `decodeScriptResult` unwraps it and, on
`ok: false`, throws a `PhotoshopScriptError` carrying Photoshop's message, error number, and line.

## Units preamble

Ruler units and type units are forced to `Units.PIXELS` / `TypeUnits.POINTS` for the duration of
the script, and the user's original preferences are restored in a `finally` block. Write snippets
assuming plain-number pixels and points — you don't need to construct a `UnitValue` for coordinates,
sizes, or text metrics.

## Dialog suppression

`app.displayDialogs` is forced to `DialogModes.NO` for the duration and restored in `finally`. This
suppresses the script-command dialogs Photoshop would otherwise raise mid-script — chiefly
missing-font and ICC color-profile-mismatch prompts — each of which blocks the synchronous
automation call until a human dismisses it, which the calling process can only observe as a
dropped connection. It does **not** suppress application- or OS-level modals (linked-asset
warnings, "disk changed" prompts, licensing dialogs, GPU warnings, rasterize confirmations) —
those need to be handled outside the script, at the process level. Don't set
`app.displayDialogs` inside a snippet body; the wrapper owns it for the duration of the call.

## No JSON in ExtendScript

Photoshop's ExtendScript runtime predates the `JSON` object and has no encoder of its own, so the
postamble carries a small hand-rolled one (`__mcpJsonEncode`) that walks the result tree —
strings with escaping, numbers, booleans, null/undefined, arrays, and plain objects, with a depth
cap against pathological nesting. This is what lets a tool handler receive a real parsed object
instead of a stringified `toSource()` dump. If a snippet needs to hand back structured data,
return a plain object or array from the top level — the wrapper's encoder handles it.

## Known runtime quirk: selection state

Photoshop 2024+ throws an **uncatchable** error 1302 from `doc.selection.bounds` when no
selection exists — uncatchable meaning a `try/catch` around the property read does not stop it
from aborting the script. Snippets that need to know whether a selection exists probe for it via
an `ActionReference` targeting the `fsel` property instead of touching `doc.selection.bounds`
directly. This is why context-gathering and selection-dependent snippets read selection state
through Action Manager even when everything else about the operation is DOM-based.
