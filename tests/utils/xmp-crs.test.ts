import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CRS_FIELDS,
  RAW_EXTENSIONS,
  SIDECAR_DEVELOPABLE_EXTENSIONS,
  applyCrsCoherence,
  describeSidecar,
  extractChildBlock,
  findTopLevelDescription,
  formatCrsValue,
  mergeCrsIntoSidecar,
  readPresetChanges,
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

describe('xmp-crs — Camera Raw preset import', () => {
  const PRESET = readFileSync(join(FIXTURES, 'preset-user.xmp'), 'utf8');

  it("takes the preset's develop settings as changes", () => {
    const { changes, applied } = readPresetChanges(PRESET);
    expect(changes.fields!.exposure).toBe(0.35);
    expect(changes.fields!.contrast).toBe(12);
    expect(changes.fields!.highlights).toBe(-40);
    expect(changes.fields!.vibrance).toBe(14);
    expect(applied).toContain('split_shadow_hue');
    expect(applied).toContain('post_crop_vignette');
  });

  it('does NOT copy preset identity fields into an image sidecar', () => {
    // Scoped to the TOP-LEVEL attributes on purpose: a carried Look carries
    // its own crs:UUID as part of its payload, and that one must survive.
    const { changes } = readPresetChanges(PRESET);
    const top = readTopLevelCrs(mergeCrsIntoSidecar(null, changes));
    for (const identity of [
      'UUID',
      'PresetType',
      'Cluster',
      'CameraModelRestriction',
      'SupportsAmount',
    ]) {
      expect(top).not.toHaveProperty(identity);
    }
    expect(mergeCrsIntoSidecar(null, changes)).not.toContain('Kodak Portra Warm');
  });

  it('carries the Look across with every attribute and value intact', () => {
    // A Look only applies when its full payload travels with it — naming one
    // resolves nothing — and the LookTable hash must survive byte-for-byte.
    const { changes, carried } = readPresetChanges(PRESET);
    expect(carried).toContain('Look');
    const merged = mergeCrsIntoSidecar(null, changes);
    const sourceLook = /<crs:Look>[\s\S]*?<\/crs:Look>/.exec(PRESET)![0];
    const mergedLook = /<crs:Look>[\s\S]*?<\/crs:Look>/.exec(merged)![0];
    // Only leading indentation is renormalised when a block is carried, so
    // compare the ATTRIBUTES — that is the real invariant, and the LookTable
    // hash is the one that decides whether the Look resolves at all.
    const attrs = (x: string) => (x.match(/crs:[A-Za-z0-9_]+="[^"]*"/g) ?? []).sort();
    expect(attrs(mergedLook)).toEqual(attrs(sourceLook));
    expect(mergedLook).toContain('crs:LookTable="E1095149FDB39D7A057BAB208837E2E1"');
    // ...and the element structure is unchanged, not just the attributes.
    const tags = (x: string) => (x.match(/<\/?[A-Za-z:]+/g) ?? []).join(',');
    expect(tags(mergedLook)).toBe(tags(sourceLook));
  });

  it('reports what it could not carry instead of dropping it silently', () => {
    // The real sidecar has mask-based corrections; a preset carrying those
    // cannot be honoured, and saying so is the difference between a partial
    // import and a wrong one.
    const { skipped } = readPresetChanges(REAL);
    expect(skipped.join(' ')).toContain('MaskGroupBasedCorrections');
    expect(skipped.join(' ')).toContain('silently would not happen');
  });

  it('a clean preset reports nothing skipped', () => {
    expect(readPresetChanges(PRESET).skipped).toEqual([]);
  });

  it('explicit settings layer over the preset rather than under it', () => {
    const { changes } = readPresetChanges(PRESET);
    const merged = mergeCrsIntoSidecar(null, {
      ...changes,
      fields: { ...changes.fields, exposure: -2 },
    });
    expect(merged).toContain('crs:Exposure2012="-2.00"');
    expect(merged).toContain('crs:Contrast2012="+12"'); // preset value survives
  });

  it("applying a preset preserves the image's own masks", () => {
    const { changes } = readPresetChanges(PRESET);
    const before = blockOf(REAL, 'MaskGroupBasedCorrections');
    const after = blockOf(mergeCrsIntoSidecar(REAL, changes), 'MaskGroupBasedCorrections');
    expect(after).toBe(before);
  });
});

describe('xmp-crs — precedence between carried blocks and explicit settings', () => {
  const PRESET = readFileSync(join(FIXTURES, 'preset-user.xmp'), 'utf8');

  it('an explicit curve beats a curve carried in from a preset', () => {
    // A carried block is base material; an explicit curve is an instruction.
    // If ordering ever flips, the caller's curve silently loses.
    const withCurveBlock = mergeCrsIntoSidecar(null, {
      blocks: {
        ToneCurvePV2012:
          '<crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 99</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012>',
      },
      curves: {
        curve: [
          [0, 7],
          [255, 255],
        ],
      },
    });
    expect(withCurveBlock).toContain('<rdf:li>0, 7</rdf:li>');
    expect(withCurveBlock).not.toContain('<rdf:li>0, 99</rdf:li>');
    expect(withCurveBlock.match(/<crs:ToneCurvePV2012>/g)).toHaveLength(1);
  });

  it('a carried Look still lands when no explicit curve competes with it', () => {
    const { changes } = readPresetChanges(PRESET);
    expect(mergeCrsIntoSidecar(null, changes)).toContain('crs:LookTable=');
  });
});

describe('xmp-crs — hardening found in QA', () => {
  const PRESET = readFileSync(join(FIXTURES, 'preset-user.xmp'), 'utf8');

  it('a value containing $-substitution syntax is written literally', () => {
    // `$&`, `$'`, `` $` `` and `$n` are replacement-string syntax. Used as a
    // template they would splice surrounding document text into the attribute
    // and corrupt the sidecar; escapeXmlAttr does not neutralise them.
    const once = mergeCrsIntoSidecar(null, { fields: { camera_profile: 'Plain' } });
    // No `&` here on purpose: that is XML-escaped (correctly) and would mask
    // the thing under test, which is `$`-sequence splicing.
    const nasty = "Kodak $' $1 $` Warm";
    const merged = mergeCrsIntoSidecar(once, { fields: { camera_profile: nasty } });
    expect(readTopLevelCrs(merged).CameraProfile).toBe(nasty);
    expect(merged.match(/crs:CameraProfile=/g)).toHaveLength(1);
    // And `&` still escapes properly on the same path.
    const amp = mergeCrsIntoSidecar(once, { fields: { camera_profile: 'A & B' } });
    expect(amp).toContain('crs:CameraProfile="A &amp; B"');
  });

  it('a block text containing $-substitution syntax survives a replace', () => {
    const first = mergeCrsIntoSidecar(null, {
      blocks: { Look: '<crs:Look><rdf:Description crs:Name="a"/></crs:Look>' },
    });
    const second = mergeCrsIntoSidecar(first, {
      blocks: { Look: `<crs:Look><rdf:Description crs:Name="$' $&"/></crs:Look>` },
    });
    expect(second).toContain(`crs:Name="$' $&"`);
    expect(second.match(/<crs:Look>/g)).toHaveLength(1);
  });

  it('refuses a block tag name that is not a plain XML identifier', () => {
    // The tag name is interpolated into a RegExp; anything else could change
    // what the pattern matches.
    expect(() => mergeCrsIntoSidecar(null, { blocks: { 'Look[a-z]+': '<crs:X/>' } })).toThrow(
      /non-identifier tag name/
    );
  });

  it('drops an out-of-range preset value instead of failing the whole import', () => {
    // Only `rotate` has a measured bound; the rest are UI guesses, so one
    // guessed-too-narrow range must not reject a user's working preset.
    const broken = PRESET.replace('crs:Contrast2012="+12"', 'crs:Contrast2012="+400"');
    const { changes, applied, skipped } = readPresetChanges(broken);
    expect(applied).not.toContain('contrast');
    expect(skipped.join(' ')).toContain('contrast');
    expect(changes.fields!.vibrance).toBe(14); // the rest still imports
    expect(() => mergeCrsIntoSidecar(null, changes)).not.toThrow();
  });

  it('a caller-supplied out-of-range value still throws — they asked for it', () => {
    expect(() => mergeCrsIntoSidecar(null, { fields: { rotate: 30 } })).toThrow();
  });

  it('completes has_crop when only crop edges are given', () => {
    const { changes, notes } = applyCrsCoherence(
      { fields: { crop_top: 0.1, crop_bottom: 0.9 } },
      new Set(['crop_top', 'crop_bottom'])
    );
    expect(changes.fields!.has_crop).toBe(true);
    expect(notes.join(' ')).toContain('has_crop');
  });

  it('completes white_balance when temperature is given', () => {
    const { changes, notes } = applyCrsCoherence(
      { fields: { temperature: 8000 } },
      new Set(['temperature'])
    );
    expect(changes.fields!.white_balance).toBe('Custom');
    expect(notes.join(' ')).toContain('Custom');
  });

  it('refuses temperature under an explicitly non-Custom white balance', () => {
    expect(() =>
      applyCrsCoherence(
        { fields: { temperature: 8000, white_balance: 'Daylight' } },
        new Set(['temperature', 'white_balance'])
      )
    ).toThrow(/only take effect with white_balance="Custom"/);
  });

  it('leaves a coherent change set alone', () => {
    const { changes, notes } = applyCrsCoherence(
      { fields: { exposure: 1 } },
      new Set(['exposure'])
    );
    expect(notes).toEqual([]);
    expect(changes.fields).toEqual({ exposure: 1 });
  });
});

describe('xmp-crs — coherence is scoped to caller intent', () => {
  it('does not refuse Temperature alongside "As Shot" when neither came from the caller', () => {
    // Camera Raw writes exactly this pair itself: the temperature records what
    // as-shot WAS. Refusing it would reject the user's own working presets.
    const fromFile = { fields: { temperature: 5550, tint: 8, exposure: 0 } };
    expect(() => applyCrsCoherence(fromFile, new Set())).not.toThrow();
    const { changes, notes } = applyCrsCoherence(
      { fields: { temperature: 5550, white_balance: 'As Shot' } },
      new Set()
    );
    expect(changes.fields!.white_balance).toBe('As Shot');
    expect(notes).toEqual([]);
  });

  it('still refuses when the caller typed both halves of the contradiction', () => {
    expect(() =>
      applyCrsCoherence(
        { fields: { temperature: 8000, white_balance: 'Daylight' } },
        new Set(['temperature', 'white_balance'])
      )
    ).toThrow(/white_balance="Custom"/);
  });

  it('the real ACR sidecar imports as a preset without throwing', () => {
    // Regression guard for the above: this fixture carries Temperature with
    // WhiteBalance="As Shot".
    const { changes } = readPresetChanges(REAL);
    expect(() => applyCrsCoherence(changes, new Set())).not.toThrow();
  });
});

describe('xmp-crs — RAW_EXTENSIONS is the single source', () => {
  it('matches the go-core openDocumentPipeline fragment', () => {
    // The fragment decides is_raw_source from the same set. If they diverge,
    // one half develops a file the other half does not consider raw. Pinned on
    // the CE side so a CE-only edit fails CE's own suite.
    const fragment = readFileSync(
      join(__dirname, '..', '..', 'go-core', 'cmd', 'buildtemplates', 'fragments_documents.go'),
      'utf8'
    );
    const block = /var rawExts = \[([\s\S]*?)\];/.exec(fragment);
    expect(block).not.toBeNull();
    const fromFragment = Array.from(block![1].matchAll(/'([a-z0-9]+)'/g)).map((m) => m[1]);
    expect(fromFragment.sort()).toEqual([...RAW_EXTENSIONS].sort());
  });
});

describe('xmp-crs — sidecar-developable is NOT the same set as is_raw_source', () => {
  it('excludes HEIC/HEIF, which a sidecar measurably does not reach', () => {
    // Measured on ACR 18.6: the same HEIC at -3 and +3 EV gave an identical
    // histogram mean. Photoshop routes HEIC through a different path, so a
    // sidecar written for one is never read.
    expect(RAW_EXTENSIONS).toContain('heic');
    expect(SIDECAR_DEVELOPABLE_EXTENSIONS).not.toContain('heic');
    expect(SIDECAR_DEVELOPABLE_EXTENSIONS).not.toContain('heif');
  });

  it('keeps every measured-working camera raw format', () => {
    for (const ext of ['cr2', 'nef', 'arw', 'dng']) {
      expect(SIDECAR_DEVELOPABLE_EXTENSIONS).toContain(ext);
    }
  });

  it('is a strict subset of the is_raw_source set', () => {
    for (const ext of SIDECAR_DEVELOPABLE_EXTENSIONS) {
      expect(RAW_EXTENSIONS).toContain(ext);
    }
    expect(SIDECAR_DEVELOPABLE_EXTENSIONS.length).toBeLessThan(RAW_EXTENSIONS.length);
  });
});

describe('xmp-crs — child blocks are scoped to the top-level Description', () => {
  const PRESET = readFileSync(join(FIXTURES, 'preset-user.xmp'), 'utf8');

  it("does not mistake a Look's internal curve for the document's own", () => {
    // preset-user.xmp has NO top-level tone curve; its only curves live inside
    // <crs:Look><crs:Parameters>. A document-wide search reported those as the
    // preset's own, which then overwrote the target image's real curve.
    const { carried } = readPresetChanges(PRESET);
    expect(carried).toContain('Look');
    expect(carried).not.toContain('ToneCurvePV2012');
    expect(carried).not.toContain('ToneCurvePV2012Red');
  });

  it("applying a preset leaves the image's own tone curve alone", () => {
    // acr-full-sidecar.xmp has BOTH a top-level curve and one inside its Look.
    const before = blockOf(REAL, 'ToneCurvePV2012');
    expect(before).toContain('<rdf:li>');
    const { changes } = readPresetChanges(PRESET);
    const after = mergeCrsIntoSidecar(REAL, changes);
    const topLevelAfter = extractChildBlock(after, 'ToneCurvePV2012');
    expect(topLevelAfter).toBe(extractChildBlock(REAL, 'ToneCurvePV2012'));
  });

  it('an explicit curve does not get written inside a carried Look', () => {
    // Writing into the Look would mutate a LookTable-hashed payload AND leave
    // the document with no top-level curve, so the caller's curve never lands.
    const { changes } = readPresetChanges(PRESET);
    const merged = mergeCrsIntoSidecar(null, {
      ...changes,
      curves: {
        curve: [
          [0, 42],
          [255, 255],
        ],
      },
    });
    const look = blockOf(merged, 'Look');
    expect(look).not.toContain('<rdf:li>0, 42</rdf:li>');
    expect(extractChildBlock(merged, 'ToneCurvePV2012')).toContain('<rdf:li>0, 42</rdf:li>');
  });

  it('extractChildBlock reads the top-level block, not a nested one', () => {
    const top = extractChildBlock(REAL, 'ToneCurvePV2012')!;
    const insideLook = /<crs:Look>[\s\S]*?<\/crs:Look>/.exec(REAL)![0];
    expect(insideLook).toContain('<crs:ToneCurvePV2012>');
    expect(insideLook).not.toContain(top);
  });
});

describe('xmp-crs — registry lookups are own-property only', () => {
  it('rejects an inherited Object.prototype name as an unknown field', () => {
    // A bare CRS_FIELDS['toString'] is a truthy function, so it slipped past
    // the unknown-field guard and wrote crs:undefined="5" instead of saying
    // the name was wrong.
    for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
      const errors = validateCrsChanges({ fields: { [name]: 5 } });
      expect(errors[0], `expected '${name}' to be rejected`).toContain('Unknown develop field');
    }
  });

  it('rejects an inherited name as an unknown curve', () => {
    const points: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [255, 255],
    ];
    expect(
      validateCrsChanges({
        curves: {
          toString: points,
        },
      })[0]
    ).toContain('Unknown curve');
  });

  it('never writes a crs:undefined attribute', () => {
    expect(() => mergeCrsIntoSidecar(null, { fields: { toString: 5 } })).toThrow(
      /Unknown develop field/
    );
  });
});

describe('xmp-crs — split-namespace sidecars and entity round-trips', () => {
  const SPLIT = [
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"',
    '   dc:format="image/x-canon-cr2"/>',
    '  <rdf:Description rdf:about=""',
    '    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"',
    '   crs:Version="18.2.2"',
    '   crs:Exposure2012="0.00"/>',
    ' </rdf:RDF>',
    '</x:xmpmeta>',
  ].join('\n');

  it('writes onto the Description that already carries crs:, not simply the first', () => {
    // exiftool, older Bridge and some asset managers split namespaces across
    // sibling Descriptions. Writing to the first would leave the user's real
    // develop block untouched in the sibling and create two competing crs
    // blocks — an edit that may never apply.
    const merged = mergeCrsIntoSidecar(SPLIT, { fields: { exposure: -2 } });
    expect(merged).toContain('crs:Exposure2012="-2.00"');
    expect(merged.match(/crs:Exposure2012=/g)).toHaveLength(1);
    // The dc-only Description must not have gained crs attributes.
    const dcBlock = /<rdf:Description[^>]*dc:format[^>]*>/.exec(merged)![0];
    expect(dcBlock).not.toContain('crs:');
  });

  it('still uses the first Description when none declares crs yet', () => {
    const plain = '<rdf:RDF xmlns:rdf="r"><rdf:Description rdf:about="" dc:x="1"/></rdf:RDF>';
    expect(mergeCrsIntoSidecar(plain, { fields: { exposure: 1 } })).toContain(
      'crs:Exposure2012="+1.00"'
    );
  });

  it('round-trips an escaped value without doubling the entities', () => {
    const once = mergeCrsIntoSidecar(null, { fields: { camera_profile: 'A & B < C' } });
    expect(once).toContain('crs:CameraProfile="A &amp; B &lt; C"');
    // Read back as the TEXT, not the entities.
    expect(readTopLevelCrs(once).CameraProfile).toBe('A & B < C');
    expect(describeSidecar(once).camera_profile).toBe('A & B < C');
    // ...and a second write does not escape the escapes.
    const twice = mergeCrsIntoSidecar(once, { fields: { exposure: 1 } });
    expect(twice).toContain('crs:CameraProfile="A &amp; B &lt; C"');
    expect(twice).not.toContain('&amp;amp;');
  });

  it('refuses crop edges the caller explicitly disabled', () => {
    // Symmetric with the white-balance contradiction: Camera Raw would write
    // the edges and ignore them.
    expect(() =>
      applyCrsCoherence(
        { fields: { crop_top: 0.1, has_crop: false } },
        new Set(['crop_top', 'has_crop'])
      )
    ).toThrow(/only take effect with has_crop=true/);
  });

  it('leaves a file-sourced has_crop=false alone', () => {
    expect(() =>
      applyCrsCoherence({ fields: { crop_top: 0.1, has_crop: false } }, new Set())
    ).not.toThrow();
  });

  it('rejects a NaN curve point', () => {
    expect(
      validateCrsChanges({ curves: { curve: [[Number.NaN, 0] as const, [255, 255] as const] } })[0]
    ).toContain('0-255');
  });
});
