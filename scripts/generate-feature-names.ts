/*
 * Writes docs/feature-names.md, the published list of names Feature details can send from a
 * script. tests/integration/feature-names-doc.test.ts fails when the file and the code disagree,
 * so the list can't grow without the doc. Run with `npm run docs:feature-names`.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ACTION_OPERATIONS,
  DOM_OPERATIONS,
  SCRIPT_CAPABILITIES,
} from '../src/telemetry/script-operations.ts';

export const FEATURE_NAMES_DOC = fileURLToPath(
  new URL('../docs/feature-names.md', import.meta.url)
);

function list(names: ReadonlySet<string>): string {
  return [...names]
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((name) => `- \`${name}\``)
    .join('\n');
}

export function renderFeatureNamesDoc(): string {
  return `# Feature names

This is every name Editmamei can send from a script when \`telemetry.features\` is on. See
[Privacy & data handling](privacy.md#exactly-what-data-leaves). Any other name is sent as \`unknown\`,
with \`dom\`, \`action\` or \`dynamic\`, and the name itself isn't sent.

Generated from \`src/telemetry/script-operations.ts\`. A test keeps the two identical.

Names are sent with spaces changed to underscores.

Tool options aren't listed here. An option's value is sent only when it exactly matches a fixed value
that tool's own schema declares, and those schemas are in each tool's definition.

## Script capabilities

Reaching outside Photoshop, or loading code the scan can't see.

${list(SCRIPT_CAPABILITIES)}

## Photoshop scripting methods

${list(DOM_OPERATIONS)}

## Photoshop action ids

${list(ACTION_OPERATIONS)}
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(FEATURE_NAMES_DOC, renderFeatureNamesDoc());
}
