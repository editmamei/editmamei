/**
 * Camera Raw develop settings as XMP (`crs:`) — field registry, validation,
 * and a surgical sidecar merger.
 *
 * Why this exists: Photoshop exposes no scriptable route to a raw file's
 * develop settings. The Camera Raw *Filter* can be driven (see the Pro
 * `ps_apply_camera_raw` tool), but it is a filter on already-rasterised
 * pixels — it cannot reach the geometry panel, and Adobe silently discards
 * the Upright/Perspective keys it otherwise accepts. `CameraRAWOpenOptions`
 * exposes only the legacy PV2003 slider set and ignores the tone controls.
 *
 * XMP is the route that works, because it is Camera Raw's *own* persistence
 * format. Writing a `.xmp` sidecar beside a raw and then opening the raw
 * applies the settings with no dialog and no UI automation. Measured live
 * (PS 27.10 / ACR 18.6): the same CR2 opened with `crs:Exposure2012="-3.00"`
 * vs `"+3.00"` gives histogram means of 16.1 and 208.6.
 *
 * Three findings shape this module:
 *
 *  1. **Out-of-range values are dropped SILENTLY.** `PerspectiveRotate="5.0"`
 *     applies; `"30.0"` does nothing and reports nothing (ACR caps that
 *     slider at +/-10). A writer that passes values through inherits that
 *     silence, so every field carries a range and out-of-range is refused.
 *
 *  2. **Name-only references to a resource do NOT resolve.** A `<crs:Look>`
 *     naming "Adobe Vivid", and `ToneCurveName2012="Strong Contrast"`, both
 *     no-op. Only explicit values work, so this registry exposes no
 *     name-reference fields at all.
 *
 *  3. **Nested blocks must survive untouched.** Local/AI-mask corrections
 *     carry integrity digests (`MaskDigest`, `InputDigest`) — hand-editing
 *     their parameters makes ACR discard the whole correction. We therefore
 *     never re-serialise a parsed model: we edit the original text in place,
 *     scoped to the top-level `rdf:Description` attributes, and copy every
 *     nested element through byte-for-byte. That way a user's existing masks,
 *     Looks and point colours survive a merge whether or not they would have
 *     applied.
 *
 * Range provenance: only `PerspectiveRotate` has had its boundary measured
 * live. Every other range is taken from Camera Raw's UI and is marked
 * `verified: false` — see the T2 entry in the open-tests list.
 */

/** Groups mirror the `ps_apply_camera_raw` parameter groups, plus the four
 *  that only the raw-file path can reach: geometry, crop, lens, auto. */
export type CrsGroup =
  | 'basic'
  | 'auto'
  | 'geometry'
  | 'crop'
  | 'lens'
  | 'detail'
  | 'hsl'
  | 'split_tone'
  | 'effects'
  | 'bw'
  | 'curve'
  | 'profile';

/** How a value is rendered into the XMP attribute. ACR's own conventions:
 *  zero is unsigned ("0", "0.00"), positives carry an explicit "+". */
export type CrsFormat =
  | 'signed2' // +3.00 / -3.00 / 0.00   (exposure)
  | 'signed1' // +5.0 / 0.0             (perspective rotate)
  | 'signedInt' // +50 / -100 / 0       (most sliders)
  | 'plainInt' // 5550 / 40             (temperature, sharpness)
  | 'decimal6' // 0.124486              (crop edges)
  | 'bool' // True / False
  | 'text'; // verbatim string (profile names)

export interface CrsFieldSpec {
  /** The `crs:` attribute name as ACR writes it. */
  readonly key: string;
  readonly group: CrsGroup;
  readonly format: CrsFormat;
  /** Inclusive bounds for numeric fields. */
  readonly min?: number;
  readonly max?: number;
  /** Allowed values for enumerated string fields. */
  readonly values?: readonly string[];
  /** True only where the boundary has been confirmed against live ACR. */
  readonly verified?: boolean;
  readonly note?: string;
}

const HSL_COLORS = [
  'Red',
  'Orange',
  'Yellow',
  'Green',
  'Aqua',
  'Blue',
  'Purple',
  'Magenta',
] as const;

function hslFields(): Record<string, CrsFieldSpec> {
  const out: Record<string, CrsFieldSpec> = {};
  for (const axis of ['Hue', 'Saturation', 'Luminance'] as const) {
    for (const color of HSL_COLORS) {
      out[`${axis.toLowerCase()}_${color.toLowerCase()}`] = {
        key: `${axis}Adjustment${color}`,
        group: 'hsl',
        format: 'signedInt',
        min: -100,
        max: 100,
      };
    }
  }
  for (const color of HSL_COLORS) {
    out[`bw_mix_${color.toLowerCase()}`] = {
      key: `GrayMixer${color}`,
      group: 'bw',
      format: 'signedInt',
      min: -100,
      max: 100,
    };
  }
  return out;
}

/**
 * The writable surface. Friendly snake_case name → XMP key + constraints.
 *
 * Every field here has been confirmed to APPLY through a sidecar on live
 * ACR 18.6, either directly or as a member of a group whose representative
 * was tested. Fields that measurably do NOT apply are deliberately absent.
 */
export const CRS_FIELDS: Readonly<Record<string, CrsFieldSpec>> = Object.freeze({
  // --- basic tone + colour -------------------------------------------------
  exposure: { key: 'Exposure2012', group: 'basic', format: 'signed2', min: -5, max: 5 },
  contrast: { key: 'Contrast2012', group: 'basic', format: 'signedInt', min: -100, max: 100 },
  highlights: { key: 'Highlights2012', group: 'basic', format: 'signedInt', min: -100, max: 100 },
  shadows: { key: 'Shadows2012', group: 'basic', format: 'signedInt', min: -100, max: 100 },
  whites: { key: 'Whites2012', group: 'basic', format: 'signedInt', min: -100, max: 100 },
  blacks: { key: 'Blacks2012', group: 'basic', format: 'signedInt', min: -100, max: 100 },
  texture: { key: 'Texture', group: 'basic', format: 'signedInt', min: -100, max: 100 },
  clarity: { key: 'Clarity2012', group: 'basic', format: 'signedInt', min: -100, max: 100 },
  dehaze: { key: 'Dehaze', group: 'basic', format: 'signedInt', min: -100, max: 100 },
  vibrance: { key: 'Vibrance', group: 'basic', format: 'signedInt', min: -100, max: 100 },
  saturation: { key: 'Saturation', group: 'basic', format: 'signedInt', min: -100, max: 100 },
  temperature: {
    key: 'Temperature',
    group: 'basic',
    format: 'plainInt',
    min: 2000,
    max: 50000,
    note: 'Kelvin, raw files only. Requires white_balance="Custom" to take effect.',
  },
  tint: { key: 'Tint', group: 'basic', format: 'signedInt', min: -150, max: 150 },
  shadow_tint: { key: 'ShadowTint', group: 'basic', format: 'signedInt', min: -100, max: 100 },
  white_balance: {
    key: 'WhiteBalance',
    group: 'basic',
    format: 'text',
    values: [
      'As Shot',
      'Auto',
      'Daylight',
      'Cloudy',
      'Shade',
      'Tungsten',
      'Fluorescent',
      'Flash',
      'Custom',
    ],
  },

  // --- auto ----------------------------------------------------------------
  auto_tone: {
    key: 'AutoTone',
    group: 'auto',
    format: 'bool',
    note: "Camera Raw's real Auto button. Overrides tone sliders it decides to set.",
  },

  // --- geometry ------------------------------------------------------------
  upright: {
    key: 'PerspectiveUpright',
    group: 'geometry',
    format: 'plainInt',
    min: 0,
    max: 5,
    note: '0=Off 1=Auto 2=Level 3=Vertical 4=Full 5=Guided. Content-dependent: a frame with no detectable geometry is legitimately left unchanged.',
  },
  rotate: {
    key: 'PerspectiveRotate',
    group: 'geometry',
    format: 'signed1',
    min: -10,
    max: 10,
    verified: true,
    note: 'MEASURED: 5.0 applies, 30.0 is silently discarded.',
  },
  perspective_vertical: {
    key: 'PerspectiveVertical',
    group: 'geometry',
    format: 'signedInt',
    min: -100,
    max: 100,
  },
  perspective_horizontal: {
    key: 'PerspectiveHorizontal',
    group: 'geometry',
    format: 'signedInt',
    min: -100,
    max: 100,
  },
  perspective_scale: {
    key: 'PerspectiveScale',
    group: 'geometry',
    format: 'plainInt',
    min: 50,
    max: 150,
  },
  perspective_aspect: {
    key: 'PerspectiveAspect',
    group: 'geometry',
    format: 'signedInt',
    min: -100,
    max: 100,
  },
  perspective_x: { key: 'PerspectiveX', group: 'geometry', format: 'signed2', min: -100, max: 100 },
  perspective_y: { key: 'PerspectiveY', group: 'geometry', format: 'signed2', min: -100, max: 100 },

  // --- crop ----------------------------------------------------------------
  has_crop: { key: 'HasCrop', group: 'crop', format: 'bool' },
  crop_top: { key: 'CropTop', group: 'crop', format: 'decimal6', min: 0, max: 1 },
  crop_left: { key: 'CropLeft', group: 'crop', format: 'decimal6', min: 0, max: 1 },
  crop_bottom: { key: 'CropBottom', group: 'crop', format: 'decimal6', min: 0, max: 1 },
  crop_right: { key: 'CropRight', group: 'crop', format: 'decimal6', min: 0, max: 1 },
  crop_angle: { key: 'CropAngle', group: 'crop', format: 'signed1', min: -45, max: 45 },

  // --- lens ----------------------------------------------------------------
  lens_profile_enable: {
    key: 'LensProfileEnable',
    group: 'lens',
    format: 'plainInt',
    min: 0,
    max: 1,
  },
  manual_distortion: {
    key: 'LensManualDistortionAmount',
    group: 'lens',
    format: 'signedInt',
    min: -100,
    max: 100,
  },
  defringe_purple: {
    key: 'DefringePurpleAmount',
    group: 'lens',
    format: 'plainInt',
    min: 0,
    max: 20,
  },
  defringe_green: {
    key: 'DefringeGreenAmount',
    group: 'lens',
    format: 'plainInt',
    min: 0,
    max: 20,
  },

  // --- detail --------------------------------------------------------------
  sharpness: { key: 'Sharpness', group: 'detail', format: 'plainInt', min: 0, max: 150 },
  sharpen_radius: { key: 'SharpenRadius', group: 'detail', format: 'signed1', min: 0.5, max: 3 },
  sharpen_detail: { key: 'SharpenDetail', group: 'detail', format: 'plainInt', min: 0, max: 100 },
  sharpen_masking: {
    key: 'SharpenEdgeMasking',
    group: 'detail',
    format: 'plainInt',
    min: 0,
    max: 100,
  },
  luminance_noise_reduction: {
    key: 'LuminanceSmoothing',
    group: 'detail',
    format: 'plainInt',
    min: 0,
    max: 100,
  },
  color_noise_reduction: {
    key: 'ColorNoiseReduction',
    group: 'detail',
    format: 'plainInt',
    min: 0,
    max: 100,
  },

  // --- split toning --------------------------------------------------------
  split_shadow_hue: {
    key: 'SplitToningShadowHue',
    group: 'split_tone',
    format: 'plainInt',
    min: 0,
    max: 360,
  },
  split_shadow_saturation: {
    key: 'SplitToningShadowSaturation',
    group: 'split_tone',
    format: 'plainInt',
    min: 0,
    max: 100,
  },
  split_highlight_hue: {
    key: 'SplitToningHighlightHue',
    group: 'split_tone',
    format: 'plainInt',
    min: 0,
    max: 360,
  },
  split_highlight_saturation: {
    key: 'SplitToningHighlightSaturation',
    group: 'split_tone',
    format: 'plainInt',
    min: 0,
    max: 100,
  },
  split_balance: {
    key: 'SplitToningBalance',
    group: 'split_tone',
    format: 'signedInt',
    min: -100,
    max: 100,
  },

  // --- effects -------------------------------------------------------------
  post_crop_vignette: {
    key: 'PostCropVignetteAmount',
    group: 'effects',
    format: 'signedInt',
    min: -100,
    max: 100,
  },
  grain_amount: { key: 'GrainAmount', group: 'effects', format: 'plainInt', min: 0, max: 100 },
  grain_size: { key: 'GrainSize', group: 'effects', format: 'plainInt', min: 0, max: 100 },

  // --- black & white -------------------------------------------------------
  convert_to_grayscale: { key: 'ConvertToGrayscale', group: 'bw', format: 'bool' },

  // --- profile -------------------------------------------------------------
  camera_profile: {
    key: 'CameraProfile',
    group: 'profile',
    format: 'text',
    note: 'Resolves BY NAME (e.g. "Camera Landscape", "Adobe Standard"). Creative Looks do NOT resolve by name and are not exposed.',
  },

  ...hslFields(),
});

/** Curve fields are child ELEMENTS, not attributes, so they take a separate
 *  write path. Values are [input, output] pairs, 0-255. */
export const CRS_CURVES: Readonly<Record<string, string>> = Object.freeze({
  curve: 'ToneCurvePV2012',
  curve_red: 'ToneCurvePV2012Red',
  curve_green: 'ToneCurvePV2012Green',
  curve_blue: 'ToneCurvePV2012Blue',
});

export type CurvePoints = ReadonlyArray<readonly [number, number]>;

export interface CrsChanges {
  /** Scalar fields keyed by the friendly names in CRS_FIELDS. */
  readonly fields?: Readonly<Record<string, number | boolean | string>>;
  /** Tone curves keyed by the names in CRS_CURVES. */
  readonly curves?: Readonly<Record<string, CurvePoints>>;
  /**
   * Whole `crs:` child elements to carry across, keyed by tag name (e.g.
   * `Look`). Used when copying a block out of a preset: a Look only applies
   * when its full payload travels with it — naming one resolves nothing — and
   * it must not be re-serialised, since a `LookTable` hash that no longer
   * matches degrades it to the block's embedded parameters.
   *
   * Precisely: every element, attribute and value is preserved; only each
   * line's LEADING INDENTATION is normalised to sit in the destination file.
   * That is not byte-identical, and the distinction matters — do not restate
   * this as "verbatim". Blocks already present in the file being merged INTO
   * are a different path and genuinely are untouched.
   */
  readonly blocks?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Check every requested change against the registry.
 *
 * Refuses rather than clamps, deliberately: ACR drops an out-of-range value
 * with no error, so a clamp would quietly produce a different edit than the
 * caller asked for, and a pass-through would quietly produce none at all.
 */
export function validateCrsChanges(changes: CrsChanges): string[] {
  const errors: string[] = [];

  for (const [name, raw] of Object.entries(changes.fields ?? {})) {
    const spec = CRS_FIELDS[name];
    if (!spec) {
      errors.push(`Unknown develop field '${name}'.`);
      continue;
    }
    if (spec.format === 'bool') {
      if (typeof raw !== 'boolean')
        errors.push(`'${name}' must be true or false, got ${JSON.stringify(raw)}.`);
      continue;
    }
    if (spec.format === 'text') {
      if (typeof raw !== 'string' || raw.length === 0) {
        errors.push(`'${name}' must be a non-empty string, got ${JSON.stringify(raw)}.`);
      } else if (spec.values && !spec.values.includes(raw)) {
        errors.push(`'${name}' must be one of ${spec.values.join(', ')}; got '${raw}'.`);
      }
      continue;
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      errors.push(`'${name}' must be a number, got ${JSON.stringify(raw)}.`);
      continue;
    }
    if (spec.min !== undefined && raw < spec.min) {
      errors.push(rangeError(name, spec, raw));
    } else if (spec.max !== undefined && raw > spec.max) {
      errors.push(rangeError(name, spec, raw));
    }
  }

  for (const [name, points] of Object.entries(changes.curves ?? {})) {
    if (!CRS_CURVES[name]) {
      errors.push(`Unknown curve '${name}'. Valid: ${Object.keys(CRS_CURVES).join(', ')}.`);
      continue;
    }
    if (!Array.isArray(points) || points.length < 2) {
      errors.push(`'${name}' needs at least 2 [input, output] points.`);
      continue;
    }
    for (const p of points) {
      if (
        !Array.isArray(p) ||
        p.length !== 2 ||
        p.some((n) => typeof n !== 'number' || n < 0 || n > 255)
      ) {
        errors.push(
          `'${name}' points must be [input, output] pairs in 0-255; got ${JSON.stringify(p)}.`
        );
        break;
      }
    }
  }

  return errors;
}

/**
 * Camera Raw ignores some settings unless an enabling field accompanies them —
 * a crop box does nothing without `HasCrop`, and Temperature/Tint do nothing
 * unless white balance is `Custom`. Written alone they produce exactly the
 * silent no-op the range guard exists to prevent: a written sidecar, a
 * settings echo, and no visible change.
 *
 * So complete the obvious dependency rather than refusing, and report what was
 * added. The one case that IS refused is a real contradiction — asking for a
 * colour temperature while explicitly pinning white balance to something else,
 * where guessing which the caller meant would be inventing intent.
 *
 * `callerFields` scopes that refusal to settings the caller actually typed.
 * Camera Raw itself writes `Temperature` alongside `WhiteBalance="As Shot"` —
 * the temperature there records what as-shot WAS, and is not a contradiction —
 * so refusing on it would reject the user's own working presets.
 */
export function applyCrsCoherence(
  changes: CrsChanges,
  callerFields: ReadonlySet<string> = new Set(Object.keys(changes.fields ?? {}))
): { changes: CrsChanges; notes: string[] } {
  const fields = { ...(changes.fields ?? {}) };
  const notes: string[] = [];

  const cropEdges = ['crop_top', 'crop_left', 'crop_bottom', 'crop_right', 'crop_angle'];
  if (cropEdges.some((k) => k in fields) && fields.has_crop === undefined) {
    fields.has_crop = true;
    notes.push('Set has_crop=true: Camera Raw ignores a crop box without it.');
  }

  const wbDriven = 'temperature' in fields || 'tint' in fields;
  if (wbDriven) {
    const wb = fields.white_balance;
    if (wb === undefined) {
      fields.white_balance = 'Custom';
      notes.push(
        'Set white_balance="Custom": Camera Raw ignores temperature/tint under any other white-balance mode.'
      );
    } else if (wb !== 'Custom') {
      const callerAsked =
        (callerFields.has('temperature') || callerFields.has('tint')) &&
        callerFields.has('white_balance');
      if (callerAsked) {
        throw new Error(
          `temperature/tint only take effect with white_balance="Custom", but white_balance="${String(wb)}" was given. ` +
            `Pass white_balance="Custom", or drop the temperature/tint values.`
        );
      }
      // Both came from a file rather than the caller — Camera Raw's own
      // normal output. Leave it exactly as the file has it.
    }
  }

  return { changes: { ...changes, fields }, notes };
}

function rangeError(name: string, spec: CrsFieldSpec, got: number): string {
  const measured = spec.verified
    ? ' (boundary measured against live Camera Raw — out-of-range values are discarded silently)'
    : '';
  return `'${name}' must be between ${spec.min} and ${spec.max}; got ${got}${measured}.`;
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/** Render a value using ACR's own conventions: zero unsigned, positives
 *  carrying an explicit '+', booleans capitalised. */
export function formatCrsValue(spec: CrsFieldSpec, value: number | boolean | string): string {
  switch (spec.format) {
    case 'bool':
      return value ? 'True' : 'False';
    case 'text':
      return escapeXmlAttr(String(value));
    case 'plainInt':
      return String(Math.round(Number(value)));
    case 'decimal6':
      return Number(value).toFixed(6);
    case 'signed2':
      return signed(Number(value).toFixed(2), Number(value));
    case 'signed1':
      return signed(Number(value).toFixed(1), Number(value));
    case 'signedInt':
      return signed(String(Math.round(Number(value))), Number(value));
    default:
      return String(value);
  }
}

function signed(rendered: string, value: number): string {
  return value > 0 ? `+${rendered}` : rendered;
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Surgical merge
// ---------------------------------------------------------------------------

/** The span of the top-level `<rdf:Description ...>` tag's attribute region. */
interface DescriptionTag {
  /** Index just past `<rdf:Description`. */
  readonly attrsStart: number;
  /** Index of the `/` in `/>`, or of `>` for an open tag. */
  readonly attrsEnd: number;
  readonly selfClosing: boolean;
  /** Index just past the full opening tag. */
  readonly tagEnd: number;
}

/**
 * Locate the FIRST `<rdf:Description>` — the top-level one carrying the
 * document's own develop settings.
 *
 * Scoping to this tag is what protects nested `<crs:Look>` and
 * `<crs:MaskGroupBasedCorrections>` blocks, which contain their own
 * `rdf:Description` elements with colliding attribute names (a Look has its
 * own `crs:Saturation`; a mask correction has `crs:LocalExposure2012`). A
 * naive document-wide regex would rewrite those and invalidate their digests.
 */
export function findTopLevelDescription(xmp: string): DescriptionTag | null {
  const open = xmp.indexOf('<rdf:Description');
  if (open < 0) return null;
  const attrsStart = open + '<rdf:Description'.length;

  let i = attrsStart;
  let quote: string | null = null;
  while (i < xmp.length) {
    const c = xmp[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      const selfClosing = xmp[i - 1] === '/';
      return {
        attrsStart,
        attrsEnd: selfClosing ? i - 1 : i,
        selfClosing,
        tagEnd: i + 1,
      };
    }
    i++;
  }
  return null;
}

/** Minimal sidecar for a raw that has none yet. */
function emptySidecar(): string {
  return (
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0">\n' +
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
    '  <rdf:Description rdf:about=""\n' +
    '    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"\n' +
    '   crs:Version="18.2.2"\n' +
    '   crs:ProcessVersion="15.4"\n' +
    '   crs:HasSettings="True"/>\n' +
    ' </rdf:RDF>\n' +
    '</x:xmpmeta>\n'
  );
}

function renderCurve(key: string, points: CurvePoints): string {
  const items = points
    .map(([i, o]) => `    <rdf:li>${Math.round(i)}, ${Math.round(o)}</rdf:li>`)
    .join('\n');
  return `   <crs:${key}>\n    <rdf:Seq>\n${items}\n    </rdf:Seq>\n   </crs:${key}>`;
}

/** Re-indent a block lifted from another file so it sits neatly in this one. */
function indentBlock(block: string): string {
  const lines = block.trim().split('\n');
  const lead = /^\s*/.exec(lines[0])?.[0].length ?? 0;
  return lines
    .map((l) => '   ' + l.slice(Math.min(lead, /^\s*/.exec(l)?.[0].length ?? 0)))
    .join('\n');
}

/**
 * Pull one whole `crs:` child element out of an XMP document, tag included.
 *
 * Returns null when absent. Non-greedy to the first matching close tag, which
 * is correct for the `crs:` blocks Camera Raw writes — none of them nest a
 * second element of the same name.
 */
export function extractChildBlock(xmp: string, tagName: string): string | null {
  const m = new RegExp(`<crs:${tagName}>[\\s\\S]*?</crs:${tagName}>`).exec(xmp);
  return m ? m[0] : null;
}

/**
 * Replace a `crs:` child element if present, otherwise insert it inside the
 * top-level `rdf:Description` — opening a self-closing tag when there is no
 * room for children yet.
 */
function upsertChildBlock(xmp: string, tagName: string, blockText: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(tagName)) {
    // The tag name is interpolated into a RegExp below; anything but a plain
    // XML name could change what the pattern matches.
    throw new Error(`Refusing to write a block with a non-identifier tag name: '${tagName}'.`);
  }
  const existing = new RegExp(`[ \\t]*<crs:${tagName}>[\\s\\S]*?</crs:${tagName}>`);
  // Replacer function for the same reason as the attribute path: `$` sequences
  // in the block text would otherwise be treated as substitution syntax.
  if (existing.test(xmp)) return xmp.replace(existing, () => blockText);

  const tag = findTopLevelDescription(xmp);
  if (!tag) throw new Error('Sidecar structure changed unexpectedly during merge.');
  if (tag.selfClosing) {
    return (
      xmp.slice(0, tag.attrsEnd) +
      '>\n' +
      blockText +
      '\n  </rdf:Description>' +
      xmp.slice(tag.tagEnd)
    );
  }
  return xmp.slice(0, tag.tagEnd) + '\n' + blockText + xmp.slice(tag.tagEnd);
}

/** Blocks a preset can carry across intact, because we measured that they
 *  apply when their full payload travels with them. */
const CARRYABLE_BLOCKS = [
  'Look',
  'ToneCurvePV2012',
  'ToneCurvePV2012Red',
  'ToneCurvePV2012Green',
  'ToneCurvePV2012Blue',
] as const;

/** Blocks we deliberately do NOT carry, with the reason surfaced to the user. */
const UNCARRYABLE_BLOCKS: ReadonlyArray<readonly [string, string]> = [
  [
    'MaskGroupBasedCorrections',
    'local/AI-mask adjustments — hand-moved mask blocks are discarded by Camera Raw, so carrying them would promise an edit that silently would not happen',
  ],
  ['PointColors', 'point-colour adjustments — untested through a written sidecar'],
  ['RetouchAreas', 'healing/spot removal — untested through a written sidecar'],
];

export interface PresetImport {
  readonly changes: CrsChanges;
  /** Friendly names of the scalar settings taken from the preset. */
  readonly applied: string[];
  /** Blocks carried across verbatim, by tag name. */
  readonly carried: string[];
  /** Human-readable notes about parts of the preset that were NOT applied. */
  readonly skipped: string[];
}

/**
 * Turn a Camera Raw preset (`.xmp`) into develop changes.
 *
 * A preset is structurally the same `crs:` document as a sidecar, so this is
 * mostly reuse: take its top-level scalar settings that the registry knows,
 * carry its Look and tone curves across intact, and report by name anything
 * left behind rather than quietly dropping it.
 *
 * Preset identity fields (`Name`, `UUID`, `PresetType`, `Cluster`…) are not
 * develop settings and are deliberately not copied into an image's sidecar.
 */
export function readPresetChanges(presetXmp: string): PresetImport {
  const raw = readTopLevelCrs(presetXmp);
  const byKey = new Map(Object.entries(CRS_FIELDS).map(([name, spec]) => [spec.key, name]));

  const fields: Record<string, number | boolean | string> = {};
  const applied: string[] = [];
  const rangeSkips: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const name = byKey.get(key);
    if (!name) continue;
    const spec = CRS_FIELDS[name];
    let candidate: number | boolean | string;
    if (spec.format === 'bool') candidate = value === 'True';
    else if (spec.format === 'text') candidate = value;
    else {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      candidate = n;
    }
    // A preset is the user's own file, not something the caller typed, and our
    // ranges outside `rotate` are taken from Camera Raw's UI rather than
    // measured. Throwing on one guessed-too-narrow bound would fail the whole
    // import of a working preset, so drop the single value and say which.
    const problems = validateCrsChanges({ fields: { [name]: candidate } });
    if (problems.length > 0) {
      rangeSkips.push(`${name}: ${problems[0]}`);
      continue;
    }
    fields[name] = candidate;
    applied.push(name);
  }

  const blocks: Record<string, string> = {};
  const carried: string[] = [];
  for (const tagName of CARRYABLE_BLOCKS) {
    const block = extractChildBlock(presetXmp, tagName);
    if (block) {
      blocks[tagName] = block;
      carried.push(tagName);
    }
  }

  const skipped: string[] = [...rangeSkips];
  for (const [tagName, why] of UNCARRYABLE_BLOCKS) {
    if (extractChildBlock(presetXmp, tagName)) skipped.push(`${tagName}: ${why}`);
  }

  return { changes: { fields, blocks }, applied: applied.sort(), carried: carried.sort(), skipped };
}

/**
 * Merge develop settings into a sidecar, preserving everything we do not
 * explicitly manage.
 *
 * `original` is the existing sidecar text, or null to author a fresh one.
 * Returns the new sidecar text. Throws if `changes` fails validation — call
 * `validateCrsChanges` first if you want to report all problems at once.
 *
 * Guarantees:
 *  - only attributes inside the top-level `<rdf:Description>` tag are touched
 *  - nested elements (Look, masks, point colours, curves we were not asked to
 *    change) are copied through byte-for-byte, digests intact
 *  - unrelated namespaces (exif, tiff, aux, photoshop, xmpMM) are untouched
 */
export function mergeCrsIntoSidecar(original: string | null, changes: CrsChanges): string {
  const errors = validateCrsChanges(changes);
  if (errors.length > 0) {
    throw new Error(`Invalid develop settings:\n- ${errors.join('\n- ')}`);
  }

  let xmp = original && original.includes('<rdf:Description') ? original : emptySidecar();
  const tag = findTopLevelDescription(xmp);
  if (!tag) {
    throw new Error('Sidecar has no <rdf:Description> element; refusing to guess its structure.');
  }

  // --- 1. scalar attributes, scoped to the top-level tag --------------------
  const attrs: Array<[string, string]> = [['HasSettings', 'True']];
  for (const [name, value] of Object.entries(changes.fields ?? {})) {
    const spec = CRS_FIELDS[name];
    attrs.push([spec.key, formatCrsValue(spec, value)]);
  }

  let region = xmp.slice(tag.attrsStart, tag.attrsEnd);
  for (const [key, rendered] of attrs) {
    const existing = new RegExp(`(\\scrs:${key}=")[^"]*(")`);
    if (existing.test(region)) {
      // Replacer FUNCTION, not a template string: in a replacement string
      // `$&`, `$\``, `$'` and `$n` are substitution syntax, so a value
      // containing one would splice surrounding document text into the
      // attribute. Escaping for XML does not neutralise those.
      region = region.replace(
        existing,
        (_m, open: string, close: string) => open + rendered + close
      );
    } else {
      region = `${region}\n   crs:${key}="${rendered}"`;
    }
  }

  // The crs namespace must be declared if we just introduced crs attributes.
  if (!/xmlns:crs=/.test(region) && !/xmlns:crs=/.test(xmp.slice(0, tag.attrsStart))) {
    region = `\n    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"${region}`;
  }

  xmp = xmp.slice(0, tag.attrsStart) + region + xmp.slice(tag.attrsEnd);

  // --- 2. whole blocks carried across verbatim (e.g. a preset's Look) -------
  // BEFORE curves, deliberately: a carried block is base material, an explicit
  // curve is an instruction. Applying blocks second would let a preset's tone
  // curve overwrite the one the caller just asked for.
  for (const [tagName, blockText] of Object.entries(changes.blocks ?? {})) {
    xmp = upsertChildBlock(xmp, tagName, indentBlock(blockText));
  }

  // --- 3. curve child elements ---------------------------------------------
  for (const [name, points] of Object.entries(changes.curves ?? {})) {
    xmp = upsertChildBlock(xmp, CRS_CURVES[name], renderCurve(CRS_CURVES[name], points));
  }

  return xmp;
}

/**
 * Read the top-level `crs:` attributes only — the document's own develop
 * settings, without the nested Look/mask attributes that a document-wide
 * scan would fold in.
 */
export function readTopLevelCrs(xmp: string): Record<string, string> {
  const tag = findTopLevelDescription(xmp);
  if (!tag) return {};
  const region = xmp.slice(tag.attrsStart, tag.attrsEnd);
  const out: Record<string, string> = {};
  const re = /crs:([A-Za-z0-9_]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region))) out[m[1]] = m[2];
  return out;
}

/** Friendly-name view of `readTopLevelCrs`, grouped as the tool exposes them. */
export function describeSidecar(xmp: string): Record<string, string | number | boolean> {
  const raw = readTopLevelCrs(xmp);
  const byKey = new Map(Object.entries(CRS_FIELDS).map(([name, spec]) => [spec.key, name]));
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = byKey.get(key);
    if (!name) continue;
    const spec = CRS_FIELDS[name];
    if (spec.format === 'bool') out[name] = value === 'True';
    else if (spec.format === 'text') out[name] = value;
    else {
      const n = Number(value);
      out[name] = Number.isFinite(n) ? n : value;
    }
  }
  return out;
}
