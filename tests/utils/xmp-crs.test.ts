import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CRS_FIELDS,
  describeSidecar,
  findTopLevelDescription,
  formatCrsValue,
  mergeCrsIntoSidecar,
  readTopLevelCrs,
  validateCrsChanges,
} from '../../src/utils/xmp-crs.js';

/**
 * The load-bearing property of this module is PRESERVATION. Camera Raw's
 * local/AI-mask corrections carry integrity digests, and a Look carries a
 * `LookTable` hash; if a merge disturbs either, ACR silently discards the
 * whole block. `acr-full-sidecar.xmp` is a REAL sidecar written by ACR 18.2.2
 * carrying a Look, two mask-based corrections and 182 `crs:` fields — it is
 * the fixture that makes these tests meaningful, so the preservation assertions
 * deliberately run against it rather than a synthetic sample.
 */
const FIXTURES = join(__dirname, '..', 'fixtures', 'xmp');
const REAL = readFileSync(join(FIXTURES, 'acr-full-sidecar.xmp'), 'utf8');

function blockOf(xmp: string, tag: string): string {
  const m = new RegExp(`<crs:${tag}>[\\s\\S]*?</crs:${tag}>`).exec(xmp);
  return m ? m[0] : '';
}

describe('xmp-crs — top-level scoping', () => {
  it('finds the first rdf:Description and stops at its closing bracket', () => {
    const tag = findTopLevelDescription(REAL);
    expect(tag).not.toBeNull();
    // Everything before the tag end must be attributes, not nested content.
    const head = REAL.slice(0, tag!.tagEnd);
    expect(head).not.toContain('<crs:Look>');
    expect(head).not.toContain('<crs:MaskGroupBasedCorrections>');
  });

  it('is not confused by a > inside a quoted attribute value', () => {
    const xmp =
      '<rdf:RDF><rdf:Description rdf:about="" crs:CameraProfile="a &gt; b" ' +
      'crs:Exposure2012="0.00"><crs:Look/></rdf:Description></rdf:RDF>';
    const tag = findTopLevelDescription(xmp)!;
    expect(xmp.slice(tag.attrsStart, tag.attrsEnd)).toContain('crs:Exposure2012');
    expect(xmp.slice(tag.attrsStart, tag.attrsEnd)).not.toContain('<crs:Look');
  });

  it('readTopLevelCrs excludes attributes nested inside Look and mask blocks', () => {
    const top = readTopLevelCrs(REAL);
    // The Look block declares its own crs:Name / crs:LookTable; the mask
    // corrections declare crs:LocalExposure2012. None are the document's own.
    expect(top).not.toHaveProperty('Name');
    expect(top).not.toHaveProperty('LookTable');
    expect(top).not.toHaveProperty('LocalExposure2012');
    expect(top).not.toHaveProperty('MaskDigest');
    // ...while the document's own settings are present.
    expect(top).toHaveProperty('Exposure2012');
    expect(top).toHaveProperty('ProcessVersion');
  });
});

describe('xmp-crs — preservation (the digest-safety property)', () => {
  it('leaves the Look block byte-identical after a merge', () => {
    const before = blockOf(REAL, 'Look');
    expect(before).toContain('crs:LookTable=');
    const after = blockOf(mergeCrsIntoSidecar(REAL, { fields: { exposure: -2 } }), 'Look');
    expect(after).toBe(before);
  });

  it('leaves mask-based corrections byte-identical after a merge', () => {
    const before = blockOf(REAL, 'MaskGroupBasedCorrections');
    expect(before).toContain('crs:MaskDigest=');
    expect(before).toContain('crs:ReferencePoint=');
    const after = blockOf(
      mergeCrsIntoSidecar(REAL, { fields: { exposure: 1.5, clarity: 40 } }),
      'MaskGroupBasedCorrections'
    );
    expect(after).toBe(before);
  });

  it('does not disturb unrelated namespaces', () => {
    const merged = mergeCrsIntoSidecar(REAL, { fields: { vibrance: 25 } });
    for (const attr of [
      'tiff:Make="Canon"',
      'aux:Lens="EF100mm f/2.8L Macro IS USM"',
      'photoshop:SidecarForExtension="CR2"',
      'xmpMM:OriginalDocumentID="39B881911C59EC160E16046FA5418EC8"',
    ]) {
      expect(merged).toContain(attr);
    }
  });

  it('changes only the fields it was asked to change', () => {
    const before = readTopLevelCrs(REAL);
    const after = readTopLevelCrs(mergeCrsIntoSidecar(REAL, { fields: { exposure: -2 } }));
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    // Exposure2012 plus HasSettings, which the writer always asserts.
    expect(changed.sort()).toEqual(
      ['Exposure2012', 'HasSettings'].filter((k) => after[k] !== before[k]).sort()
    );
    expect(after.Exposure2012).toBe('-2.00');
  });
});

describe('xmp-crs — validation refuses rather than clamps', () => {
  it('refuses an out-of-range value and names the valid range', () => {
    // Measured live: PerspectiveRotate applies at 5.0 and is SILENTLY
    // discarded at 30.0. Passing it through would produce a no-op edit that
    // reports success, which is the failure mode this guard exists for.
    const errors = validateCrsChanges({ fields: { rotate: 30 } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('-10');
    expect(errors[0]).toContain('10');
    expect(errors[0]).toContain('discarded silently');
  });

  it('accepts the in-range value that the same field applies at', () => {
    expect(validateCrsChanges({ fields: { rotate: 5 } })).toEqual([]);
  });

  it('rejects unknown fields instead of writing them', () => {
    const errors = validateCrsChanges({ fields: { look_name: 'Adobe Vivid' } });
    expect(errors[0]).toContain("Unknown develop field 'look_name'");
  });

  it('rejects a wrong-typed value', () => {
    expect(validateCrsChanges({ fields: { exposure: 'lots' as unknown as number } })[0]).toContain(
      'must be a number'
    );
  });

  it('rejects malformed curve points', () => {
    expect(
      validateCrsChanges({
        curves: {
          curve: [
            [0, 0],
            [300, 10],
          ],
        },
      })[0]
    ).toContain('0-255');
  });

  it('mergeCrsIntoSidecar throws on invalid input rather than writing a bad sidecar', () => {
    expect(() => mergeCrsIntoSidecar(REAL, { fields: { exposure: 99 } })).toThrow(
      /between -5 and 5/
    );
  });
});

describe('xmp-crs — ACR value formatting', () => {
  it('writes zero unsigned and positives with an explicit +', () => {
    expect(formatCrsValue(CRS_FIELDS.exposure, 0)).toBe('0.00');
    expect(formatCrsValue(CRS_FIELDS.exposure, 3)).toBe('+3.00');
    expect(formatCrsValue(CRS_FIELDS.exposure, -3)).toBe('-3.00');
    expect(formatCrsValue(CRS_FIELDS.contrast, 50)).toBe('+50');
    expect(formatCrsValue(CRS_FIELDS.contrast, 0)).toBe('0');
  });

  it('writes booleans capitalised the way ACR does', () => {
    expect(formatCrsValue(CRS_FIELDS.has_crop, true)).toBe('True');
    expect(formatCrsValue(CRS_FIELDS.convert_to_grayscale, false)).toBe('False');
  });

  it('writes crop edges at ACR precision and temperature unsigned', () => {
    expect(formatCrsValue(CRS_FIELDS.crop_top, 0.25)).toBe('0.250000');
    expect(formatCrsValue(CRS_FIELDS.temperature, 5550)).toBe('5550');
  });
});

describe('xmp-crs — authoring a fresh sidecar', () => {
  it('creates a valid sidecar when none exists', () => {
    const xmp = mergeCrsIntoSidecar(null, { fields: { exposure: -3, auto_tone: true } });
    expect(xmp).toContain('xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"');
    expect(xmp).toContain('crs:ProcessVersion="15.4"');
    expect(xmp).toContain('crs:HasSettings="True"');
    expect(xmp).toContain('crs:Exposure2012="-3.00"');
    expect(xmp).toContain('crs:AutoTone="True"');
  });

  it('round-trips through describeSidecar', () => {
    const xmp = mergeCrsIntoSidecar(null, {
      fields: { exposure: 1.25, has_crop: true, camera_profile: 'Camera Landscape' },
    });
    const described = describeSidecar(xmp);
    expect(described.exposure).toBe(1.25);
    expect(described.has_crop).toBe(true);
    expect(described.camera_profile).toBe('Camera Landscape');
  });

  it('updates an existing attribute in place rather than duplicating it', () => {
    const once = mergeCrsIntoSidecar(null, { fields: { exposure: 1 } });
    const twice = mergeCrsIntoSidecar(once, { fields: { exposure: -1 } });
    expect(twice.match(/crs:Exposure2012=/g)).toHaveLength(1);
    expect(twice).toContain('crs:Exposure2012="-1.00"');
  });
});

describe('xmp-crs — tone curves (child elements)', () => {
  it('opens a self-closing Description to add a curve', () => {
    const xmp = mergeCrsIntoSidecar(null, {
      curves: {
        curve: [
          [0, 0],
          [128, 255],
          [255, 255],
        ],
      },
    });
    expect(xmp).toContain('<crs:ToneCurvePV2012>');
    expect(xmp).toContain('<rdf:li>128, 255</rdf:li>');
    expect(xmp).toContain('</rdf:Description>');
    expect(xmp).not.toContain('/>\n </rdf:RDF>');
  });

  it('replaces an existing curve without touching the other channels', () => {
    const withCurves = mergeCrsIntoSidecar(null, {
      curves: {
        curve: [
          [0, 0],
          [255, 255],
        ],
        curve_red: [
          [0, 0],
          [128, 200],
          [255, 255],
        ],
      },
    });
    const updated = mergeCrsIntoSidecar(withCurves, {
      curves: {
        curve: [
          [0, 64],
          [255, 255],
        ],
      },
    });
    expect(updated).toContain('<rdf:li>0, 64</rdf:li>');
    expect(updated.match(/<crs:ToneCurvePV2012>/g)).toHaveLength(1);
    expect(updated).toContain('<rdf:li>128, 200</rdf:li>'); // red curve untouched
  });

  it("preserves the real fixture's existing curves when only scalars change", () => {
    const before = blockOf(REAL, 'ToneCurvePV2012');
    expect(before).toContain('<rdf:li>');
    const after = blockOf(mergeCrsIntoSidecar(REAL, { fields: { dehaze: 20 } }), 'ToneCurvePV2012');
    expect(after).toBe(before);
  });
});
