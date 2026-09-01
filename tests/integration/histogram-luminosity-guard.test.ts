import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const METADATA_FRAGMENTS = join(
  REPO_ROOT,
  'go-core',
  'cmd',
  'buildtemplates',
  'fragments_metadata.go'
);

/**
 * Guard against the marginal-histogram luminosity bug (2026-09-01).
 *
 * GetHistogram's `luminosity` path used to synthesize, for an RGB document,
 * a Rec.709 weighted sum of the three MARGINAL channel histograms:
 *
 *     lum[i] = 0.2126 * red[i] + 0.7152 * green[i] + 0.0722 * blue[i]
 *
 * That is not a luminosity histogram, and it is not an approximation of one.
 * A weighted mixture of marginals is not the distribution of the weighted
 * sum. Bin i counted pixels whose RED is i, PLUS pixels whose GREEN is i,
 * PLUS pixels whose BLUE is i — so a pixel dark in one channel landed in a
 * dark bin even when the other two were bright and the pixel was not dark.
 *
 * The mean stayed exact (linearity of expectation), which is why the error
 * survived review and why the code called stdev/median "approximations."
 * Every shape-derived read was wrong: clipping, percentiles, median, stdev.
 * It failed WORST on saturated images — the ones this product exists to
 * grade — because saturation is precisely the condition where one channel
 * approaches zero while the others stay high.
 *
 * Measured on a deep blue-water frame: 521,101 px reported at level 0, read
 * downstream by ps_template_verify as ~4.3 percent shadow clipping, on an
 * image whose true per-pixel composite held 30 px at level 0 and whose green
 * channel — carrying 0.7152 of the weight — held 35. The reported figure was
 * arithmetically impossible and no caller could have detected it.
 *
 * This bug passed the entire suite. It was invisible because nothing asserted
 * anything about the SHAPE of a synthesized histogram — only that a call
 * returned bins. These are the narrowest assertions that would have caught it.
 */

const KEY_MARKER_PATTERN = /vault\.(\w+):/g;

/** Return the source text of one `vault.<Key>: \`...\`` fragment body. */
function fragmentBody(src: string, key: string): string {
  const markers: { key: string; offset: number }[] = [];
  for (const m of src.matchAll(KEY_MARKER_PATTERN)) {
    markers.push({ key: m[1], offset: m.index ?? 0 });
  }
  markers.sort((a, b) => a.offset - b.offset);

  const idx = markers.findIndex((m) => m.key === key);
  if (idx === -1) throw new Error(`fragment vault.${key} not found in source`);
  const start = markers[idx].offset;
  const end = idx + 1 < markers.length ? markers[idx + 1].offset : src.length;
  return src.slice(start, end);
}

describe('GetHistogram luminosity: no marginal-histogram synthesis', () => {
  const src = readFileSync(METADATA_FRAGMENTS, 'utf8');
  const body = fragmentBody(src, 'GetHistogram');

  it('locates the GetHistogram fragment (sanity check the scan works)', () => {
    expect(body).toContain("chName === 'luminosity'");
    expect(body.length).toBeGreaterThan(500);
  });

  it('does not combine per-channel histogram bins with Rec.709 luminance weights', () => {
    // The specific defect: literal Rec.709 coefficients applied to bin arrays.
    // Their presence anywhere in this fragment means someone has reintroduced
    // a marginal-mixture synthesis.
    for (const weight of ['0.2126', '0.7152', '0.0722']) {
      expect(
        body.includes(weight),
        `Rec.709 weight ${weight} reappeared in GetHistogram. A weighted sum of ` +
          `MARGINAL channel histograms is not a luminosity histogram — it reports ` +
          `false clipping on saturated images. Read the true per-pixel composite ` +
          `(doc.histogram, via readCompositeBins) instead.`
      ).toBe(false);
    }
  });

  it('resolves RGB luminosity through the true per-pixel composite', () => {
    expect(
      body,
      'The RGB branch of the luminosity dispatch must call readCompositeBins() so it ' +
        'reads a real distribution of real pixels rather than a mixture of marginals.'
    ).toContain('readCompositeBins()');
    expect(body).toContain('luminosity (per-pixel composite');
  });

  it('still prefers exact channels when the document mode provides them', () => {
    // Lab Lightness and Grayscale ARE luminosity, exactly. The fix must not
    // regress those to the composite approximation.
    expect(body).toContain("resolvedChannel = 'luminosity (Lab Lightness)'");
    expect(body).toContain("resolvedChannel = 'luminosity (Grayscale)'");
  });

  it('labels the last-resort marginal mixture as shape-unreliable', () => {
    // readCompositeBins still falls back to a marginal mixture when
    // doc.histogram throws on every layer AND there is no Lightness/Gray
    // channel. That path cannot be made correct without duplicating the
    // document, so it must at minimum announce itself in the channel field
    // so a caller can refuse rather than silently trust it.
    expect(
      body,
      'The rgb marginal-mixture fallback must surface its unreliability in the ' +
        'source name — a caller reading clipping off it needs to know.'
    ).toContain('rgb-marginal-mixture: shape unreliable');
  });
});
