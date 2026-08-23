/**
 * Single source of truth for the Editmamei server version reported over
 * MCP `initialize`. Keep in sync with [`package.json`](../package.json) —
 * a startup-time guard in [`tests/integration/version.test.ts`](../tests/integration/version.test.ts)
 * fails the build if these drift apart, so a routine release that bumps
 * `package.json` will surface the missed update here before it ships.
 *
 * Why a constant instead of a JSON import: ts-node / vitest / the
 * compiled dist all need this resolvable at type-check time, and ESM
 * JSON imports (`import x from './package.json' with { type: 'json' }`)
 * require explicit `--experimental-json-modules` on older Node and bake
 * the JSON into the build output. The hand-synced constant + asserting
 * test is simpler and gives a louder failure mode if anyone forgets.
 */
export const VERSION = '1.2.0';
