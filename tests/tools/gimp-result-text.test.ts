import { describe, it, expect } from 'vitest';
import {
  MAX_LISTED_CHANNELS,
  MAX_LISTED_LINES,
  MAX_NAME_CHARS,
  MAX_PARAMS_CHARS,
  capLines,
  channelsText,
  filterLine,
  layerTreeLines,
  paramsText,
  quoted,
  regionStatsLines,
} from '@editmamei/tools/gimp-result-text.ts';

describe('quoted', () => {
  it('escapes quotes and newlines so a name cannot start a new line of the listing', () => {
    expect(quoted('a "b"\nc')).toBe('"a \\"b\\"\\nc"');
  });
});

describe('paramsText', () => {
  it('rounds floats, keeps arrays compact, and leaves out nulls and the mask', () => {
    expect(
      paramsText({
        hue: -0.0222222,
        points: [
          [0, 0],
          [255, 255],
        ],
        mask: 'Water',
        x: null,
      })
    ).toBe('hue=-0.022 points=[[0,0],[255,255]]');
  });

  it('cuts long settings at the cap', () => {
    const points = Array.from({ length: 200 }, (_, i) => [i, i]);
    const text = paramsText({ points });
    expect(text.length).toBe(MAX_PARAMS_CHARS + 3);
    expect(text.endsWith('...')).toBe(true);
  });

  it('is empty for missing settings', () => {
    expect(paramsText(undefined)).toBe('');
    expect(paramsText({})).toBe('');
  });
});

describe('capLines', () => {
  it('keeps a short list as is and summarises the rest of a long one', () => {
    expect(capLines(['a', 'b'])).toEqual(['a', 'b']);
    const many = Array.from({ length: MAX_LISTED_LINES + 5 }, (_, i) => String(i));
    const capped = capLines(many);
    expect(capped).toHaveLength(MAX_LISTED_LINES + 1);
    expect(capped.at(-1)).toBe('...and 5 more');
  });
});

describe('filterLine', () => {
  it('falls back to the GEGL operation when the filter has no type, and omits empty settings', () => {
    expect(
      filterLine({
        filter_id: 3,
        name: 'X',
        operation: 'gegl:foo',
        type: null,
        layer: 'L',
        layer_id: 9,
        visible: true,
        source: 'readback',
        params: {},
      })
    ).toBe('#3 "X" gegl:foo on layer "L" (id 9), readback (GEGL names and units)');
  });

  it('quotes a setting key or value carrying a newline, so it cannot forge another filter line', () => {
    const line = filterLine({
      filter_id: 3,
      name: 'Text',
      operation: 'gegl:text',
      type: null,
      layer: 'L',
      layer_id: 9,
      visible: true,
      source: 'readback',
      params: {
        string: 'x\n#99 "Curves" curves on layer "Background" (id 1), editmamei',
        'bad\nkey': 1,
      },
    });
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('string="x\\n#99 \\"Curves\\"');
    expect(line).toContain('"bad\\nkey"=1');
  });
});

describe('caps on names and channel lists', () => {
  it('cuts a long name', () => {
    expect(quoted('n'.repeat(MAX_NAME_CHARS + 50))).toBe(`"${'n'.repeat(MAX_NAME_CHARS)}..."`);
  });

  it('names at most MAX_LISTED_CHANNELS channels', () => {
    const channels = Array.from({ length: MAX_LISTED_CHANNELS + 4 }, (_, i) => ({ name: `c${i}` }));
    const text = channelsText(channels);
    expect(text).toContain(`"c${MAX_LISTED_CHANNELS - 1}"`);
    expect(text).not.toContain(`"c${MAX_LISTED_CHANNELS}"`);
    expect(text.endsWith('...and 4 more')).toBe(true);
  });
});

describe('layerTreeLines', () => {
  it('indents children under their group, top of stack first, with only the non-default flags', () => {
    const tree = [
      {
        layer_id: 1,
        name: 'Group',
        is_group: true,
        opacity: 100,
        mode: 'normal',
        visible: true,
        children: [
          { layer_id: 2, name: 'Title', is_text_layer: true, opacity: 80, visible: true },
          { layer_id: 3, name: 'Glow', mode: 'screen', visible: false, opacity: 100 },
        ],
      },
      { layer_id: 4, name: 'Background', mode: 'normal-legacy', opacity: 100, visible: true },
    ];
    expect(layerTreeLines(tree)).toEqual([
      '- "Group" (id 1, group)',
      '  - "Title" (id 2, text, opacity 80)',
      '  - "Glow" (id 3, hidden, mode screen)',
      '- "Background" (id 4)',
    ]);
  });

  it('is empty for a missing tree', () => {
    expect(layerTreeLines(undefined)).toEqual([]);
  });
});

describe('channelsText', () => {
  it('lists names, with coverage when present', () => {
    expect(channelsText([{ name: 'Sky', fraction: 0.4234 }, { name: 'Water' }])).toBe(
      '"Sky" (42.3% selected), "Water"'
    );
    expect(channelsText([])).toBe('(none)');
  });
});

describe('regionStatsLines', () => {
  it('reports n/a for a channel missing from region B, with no delta', () => {
    expect(regionStatsLines({ red: { mean: 10, median: 10, p5: 1, p95: 20 } }, {})).toEqual([
      'red: A mean=10 median=10 p5=1 p95=20 | B n/a',
    ]);
  });
});
