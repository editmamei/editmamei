import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { FEATURE_NAMES_DOC, renderFeatureNamesDoc } from '../../scripts/generate-feature-names.ts';
import { buildMcpbManifest } from '../../scripts/build-mcpb.ts';

function normalize(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

describe('docs/feature-names.md', () => {
  it('matches the lists in the code. Regenerate with npm run docs:feature-names', () => {
    expect(normalize(readFileSync(FEATURE_NAMES_DOC, 'utf8'))).toBe(renderFeatureNamesDoc());
  });
});

describe('Claude Desktop manifest', () => {
  it('passes the Feature details toggle through, on by default', () => {
    const manifest = buildMcpbManifest('1.0.0');
    expect(manifest.server.mcp_config.env?.EDITMAMEI_TELEMETRY_FEATURES).toBe(
      '${user_config.telemetry_features}'
    );
    expect(manifest.user_config?.telemetry_features).toMatchObject({
      type: 'boolean',
      default: true,
    });
  });
});
