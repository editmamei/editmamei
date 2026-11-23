/**
 * `gimp_*` tool names that have tier and group rows but are registered only by a downloaded
 * module, never by a built-in one. A test that expects every `gimp_*` row to be registered by
 * the built-in GIMP module subtracts these.
 *
 * Pinned from both sides: `tests/integration/tool-tiers.test.ts` checks that each name has its
 * rows and that no built-in module registers it, and its orphan check, which runs where the
 * downloaded module's sources are present, checks that the module does.
 */
export const MODULE_ONLY_GIMP_TOOLS: ReadonlySet<string> = new Set([
  'gimp_look',
  'gimp_preset_look',
  'gimp_batch',
  'gimp_develop_raw',
  'gimp_mark_up',
]);
