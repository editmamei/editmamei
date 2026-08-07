/**
 * Shared helpers for snippet-vs-spec tests.
 *
 * See tests/spec/hue-saturation.test.ts for the original proof-of-
 * concept and the architectural notes on ground-truth-vs-Editmamei-
 * equivalence (some snippets use create-with-values shortcuts that
 * collapse PS's UI-captured Mk+setd sequence into one event).
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoSnippetClient, coreBinaryName } from '@editmamei/api/snippet-client.ts';
import type {
  AmEventSpec,
  AmField,
  AmObjectShape,
  AmReferenceShape,
  AmTypeID,
} from '../../src/spec/types.ts';

/**
 * The host `editmamei-core` binary `npm run build` emits, resolved relative
 * to THIS test file rather than via `resolveCoreBinaryPath()` — that helper
 * derives the binary location from `import.meta.url` on the assumption it's
 * called from the COMPILED `dist/api/snippet-client.js` (dist/api/ → ../bin).
 * Under vitest we import the TS source directly (`src/api/snippet-client.ts`
 * via the `@editmamei` alias), so that assumption resolves to a nonexistent
 * `src/bin/` path. Mirrors the `hostBinary` computation in
 * `tests/api/snippet-client.test.ts`.
 */
const here = dirname(fileURLToPath(import.meta.url));
export const hostBinaryPath = join(here, '..', '..', 'dist', 'bin', coreBinaryName());

/**
 * True when the built `editmamei-core` binary exists at `dist/bin/`.
 * Computed once at module load — mirrors the
 * `existsSync(binaryPath) ? describe : describe.skip` idiom in
 * `tests/api/snippet-client.test.ts`. Spec test files gate their whole
 * `describe` block on this so `npm test` without a prior `npm run build`
 * skips cleanly instead of failing.
 *
 * That clean skip is what makes a buildless run LOOK green while every golden
 * check below is absent, so it does not stand alone:
 * `tests/spec/core-binary-guard.test.ts` fails the suite when this is false,
 * unless `EDITMAMEI_ALLOW_MISSING_CORE=1` opts out deliberately. Keep new spec
 * files gated on this flag — the guard, not each file, is what refuses.
 */
export const goCoreBinaryAvailable = existsSync(hostBinaryPath);

/**
 * Build a snippet's inner JSX body via the SHIPPING Go engine — the same
 * `GoSnippetClient` every tool handler calls at runtime — instead of the
 * dead TS twin `ExtendScriptSnippets`. Spec tests source their JSX from
 * this instead of `ExtendScriptSnippets.X(...)` so the AM-descriptor spec
 * actually verifies what production emits.
 */
export async function goBuild(name: string, params: Record<string, unknown> = {}): Promise<string> {
  return new GoSnippetClient({ binaryPath: hostBinaryPath }).build(name, params);
}

/**
 * Walk an AmEventSpec and collect every required typeID value the
 * snippet must emit to PS. Skips optional fields (`required: false`).
 */
export function collectRequiredTypeIDs(spec: AmEventSpec): Set<string> {
  const out = new Set<string>();
  const visitTypeID = (t: AmTypeID | undefined): void => {
    if (!t) return;
    out.add(t.value);
  };
  const visitReference = (r: AmReferenceShape | undefined): void => {
    if (!r) return;
    visitTypeID(r.classID);
    visitTypeID(r.enumKey);
    visitTypeID(r.enumValue);
    visitTypeID(r.property);
  };
  const visitField = (f: AmField): void => {
    if (!f.required) return;
    visitTypeID(f.typeID);
    visitTypeID(f.enumType);
    f.enumValues?.forEach((v) => visitTypeID(v.typeID));
    if (f.itemSchema && 'classID' in f.itemSchema) visitShape(f.itemSchema);
    if (f.innerShape) visitShape(f.innerShape);
    visitReference(f.referenceShape);
  };
  const visitShape = (s: AmObjectShape): void => {
    visitTypeID(s.classID);
    s.fields.forEach(visitField);
  };
  for (const event of spec.events) {
    visitTypeID(event.event);
    if (event.descriptor) visitShape(event.descriptor);
  }
  return out;
}

/**
 * Parse a snippet's JSX body for every typeID it ACTIVELY USES —
 * arguments to `cTID(...)`, `charIDToTypeID(...)`, `sTID(...)`,
 * `stringIDToTypeID(...)`. Single or double-quoted literals only;
 * dynamic expressions are ignored. Crucially this is COMMENT-AWARE:
 * `cTID('Hsrt')` appearing inside a `//` comment counts in raw
 * substring checks but NOT here, because we match the full call form.
 */
export function extractCalledTypeIDs(jsx: string): Set<string> {
  const out = new Set<string>();
  const re = /\b(?:cTID|sTID|charIDToTypeID|stringIDToTypeID)\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(jsx)) !== null) {
    out.add(m[1]);
  }
  return out;
}

/**
 * Return the spec's required typeIDs minus a set of expected omissions.
 * Use to model the "create-with-values" equivalence where the snippet
 * collapses the UI-captured Mk+setd into a single Mk emission — the
 * setd-only typeIDs (`setd`, `T   `, `Ordn`, `Trgt`) drop out.
 */
export function filterEquivalence(required: Set<string>, omit: ReadonlyArray<string>): string[] {
  const omitSet = new Set(omit);
  return [...required].filter((t) => !omitSet.has(t));
}
