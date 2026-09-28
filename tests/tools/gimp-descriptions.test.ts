/**
 * The gimp_* descriptions are what the model learns the engine's rules from, so every rule the
 * bridge enforces is pinned here in the words the model reads. Each block names the engine
 * behaviour it mirrors.
 */
import { describe, it, expect } from 'vitest';
import { gimpFactories } from '@editmamei/modules/gimp/index.ts';
import { GIMP_OVERVIEW_MARKDOWN } from '@editmamei/tools/gimp-core-tools.ts';
import { makeGimpBackend } from '../fixtures/fake-gimp-session.ts';

const tools = gimpFactories.flatMap((f) => f(makeGimpBackend().asBackend()));
const byName = new Map(tools.map((t) => [t.tool.name, t.tool]));

function description(name: string): string {
  const tool = byName.get(name);
  expect(tool, `${name} is registered`).toBeDefined();
  return tool!.description ?? '';
}

function field(name: string, prop: string): string {
  const schema = byName.get(name)!.inputSchema as {
    properties: Record<string, { description?: string }>;
  };
  return schema.properties[prop]?.description ?? '';
}

function overviewSection(title: string): string {
  const start = GIMP_OVERVIEW_MARKDOWN.indexOf(`## ${title}`);
  expect(start, `overview has a "${title}" section`).toBeGreaterThanOrEqual(0);
  const next = GIMP_OVERVIEW_MARKDOWN.indexOf('\n## ', start + 3);
  return GIMP_OVERVIEW_MARKDOWN.slice(start, next === -1 ? undefined : next);
}

describe('every gimp_* description names its editor', () => {
  it('starts with "Headless GIMP: " so the model can tell it from the ps_* twin', () => {
    const gimpTools = tools.filter((t) => t.tool.name.startsWith('gimp_'));
    expect(gimpTools.length).toBeGreaterThanOrEqual(17);
    for (const t of gimpTools) {
      expect(t.tool.description, t.tool.name).toMatch(/^Headless GIMP: /);
    }
  });

  it('the overview says when to prefer gimp_* over ps_*', () => {
    expect(GIMP_OVERVIEW_MARKDOWN).toContain(
      'use `gimp_*` only when the user asked for GIMP or\nPhotoshop is unavailable'
    );
  });
});

describe('geometry refusals name BOTH conditions (masked filters and filters Editmamei did not create)', () => {
  // ops.py _refuse_if_masked_filters refuses on either.
  const places: Array<[string, string]> = [
    ['gimp_resize_image', description('gimp_resize_image')],
    ['gimp_transform_canvas', description('gimp_transform_canvas')],
    ['gimp_add_adjustment', description('gimp_add_adjustment')],
    ['gimp_add_adjustment mask', field('gimp_add_adjustment', 'mask')],
    ['gimp_create_mask', description('gimp_create_mask')],
    [
      'overview Order matters',
      overviewSection('Order matters: geometry before masked adjustments'),
    ],
  ];
  it.each(places)('%s', (_where, text) => {
    expect(text.replace(/\s+/g, ' ')).toMatch(/any filter not created by Editmamei/);
  });
});

describe('re-editing a filter Editmamei did not create is refused, and the model is told so', () => {
  // ops.py _existing_ledger_params raises for an unledgered filter_id.
  it('on gimp_add_adjustment filter_id', () => {
    const text = field('gimp_add_adjustment', 'filter_id').replace(/\s+/g, ' ');
    expect(text).toMatch(/Only filters Editmamei created can be re-edited/);
    expect(text).toMatch(/is refused/);
  });
  it('in the overview ledger section', () => {
    const text = overviewSection('Ledger truth vs. readback').replace(/\s+/g, ' ');
    expect(text).toMatch(/can't be re-edited by `filter_id` — that is refused/);
  });
});

describe('gimp_filter op=list reports params the model can pass back', () => {
  // ops.py op_list_filters reports lib.user_params for ledgered filters, raw GEGL for readback.
  it('says editmamei params are in gimp_add_adjustment units and readback params are raw GEGL', () => {
    const text = field('gimp_filter', 'op').replace(/\s+/g, ' ');
    expect(text).toMatch(/gimp_add_adjustment's own field names and units/);
    expect(text).toMatch(/raw GEGL property names and units/);
    expect(text).toMatch(/inside groups/);
  });
  it('the overview ledger section says the same', () => {
    const text = overviewSection('Ledger truth vs. readback').replace(/\s+/g, ' ');
    expect(text).toMatch(/`gimp_add_adjustment`'s own field names and units/);
    expect(text).toMatch(/raw GEGL property names and units/);
  });
  it('gimp_add_adjustment filter_id says listed values can be passed straight back', () => {
    expect(field('gimp_add_adjustment', 'filter_id').replace(/\s+/g, ' ')).toMatch(
      /same field names and units, so they can be passed straight back/
    );
  });
});

describe('gimp_add_effect: allow-listed GEGL effect filters (dev-tier sibling of gimp_add_adjustment)', () => {
  const EFFECTS = [
    'vignette',
    'black_white',
    'motion_blur',
    'lens_blur',
    'add_noise',
    'drop_shadow',
  ];

  it('the tool description names every effect and the shared merge/mask conventions', () => {
    const text = description('gimp_add_effect').replace(/\s+/g, ' ');
    for (const effect of EFFECTS) {
      expect(text, effect).toContain(effect);
    }
    expect(text).toMatch(/MERGES/);
    expect(text).toMatch(/gimp_filter/); // the shared stack this tool's filters live on
  });

  it('filter_id says a re-edit is a merge, same contract as gimp_add_adjustment', () => {
    expect(field('gimp_add_effect', 'filter_id').replace(/\s+/g, ' ')).toMatch(
      /MERGE, not a reset/
    );
  });

  it('mask says this tool follows the same order-matters rule as gimp_add_adjustment', () => {
    expect(field('gimp_add_effect', 'mask').replace(/\s+/g, ' ')).toMatch(/ORDER MATTERS/);
  });

  it('lens_blur says it is a uniform blur, not a depth-of-field falloff', () => {
    expect(field('gimp_add_effect', 'highlight_factor').replace(/\s+/g, ' ')).toMatch(
      /uniformly across the whole/
    );
  });

  it('points a plain blur request at gimp_add_adjustment type=gaussian_blur', () => {
    expect(description('gimp_add_effect').replace(/\s+/g, ' ')).toMatch(
      /gimp_add_adjustment type=gaussian_blur/
    );
  });

  it('vignette and drop_shadow say their color is black and not configurable yet', () => {
    expect(field('gimp_add_effect', 'center_y').replace(/\s+/g, ' ')).toMatch(
      /color is black and not configurable yet/
    );
    expect(field('gimp_add_effect', 'opacity').replace(/\s+/g, ' ')).toMatch(
      /color is black and not configurable yet/
    );
  });

  it('gimp_filter itself has no apply op — just list/set_visibility/delete', () => {
    const opEnum = (
      byName.get('gimp_filter')!.inputSchema as unknown as {
        properties: { op: { enum: string[] } };
      }
    ).properties.op.enum;
    expect(opEnum).toEqual(['list', 'set_visibility', 'delete']);
  });

  it('lens_blur states its own much lower cap (150, not the union bound)', () => {
    expect(field('gimp_add_effect', 'radius').replace(/\s+/g, ' ')).toMatch(
      /lens_blur: blur radius in pixels at full resolution, 0\.\.150/
    );
  });

  it('drop_shadow says it is clipped to the layer bounds, not grown', () => {
    expect(field('gimp_add_effect', 'radius').replace(/\s+/g, ' ')).toMatch(
      /clipped to the layer bounds rather than growing it/
    );
  });

  it('vignette/motion_blur/drop_shadow stay locked to content through flip/rotate/resize, and op=list reflects it', () => {
    const text = description('gimp_add_effect').replace(/\s+/g, ' ');
    expect(text).toMatch(/stay locked to the content through flip, resize, and an exact/);
    expect(text).toMatch(/90\/180\/270-degree rotate/);
    expect(text).toMatch(/gimp_filter op=list reflects the new values afterward/);
    expect(text).toMatch(/rotating by any OTHER angle is refused/);
  });

  it('center_x/center_y say they are fractions of the LAYER, and that crop re-centres the vignette', () => {
    const centerX = field('gimp_add_effect', 'center_x').replace(/\s+/g, ' ');
    const centerY = field('gimp_add_effect', 'center_y').replace(/\s+/g, ' ');
    expect(centerX).toMatch(/fraction of the LAYER's own width/);
    expect(centerY).toMatch(/fraction of the LAYER's own height/);
    expect(centerX).toMatch(/Cropping re-centres the vignette/);
  });

  it('motion_blur angle states its own convention (0 horizontal, positive clockwise)', () => {
    expect(field('gimp_add_effect', 'angle').replace(/\s+/g, ' ')).toMatch(
      /0 is horizontal, positive angles rotate clockwise/
    );
  });

  it('gimp_transform_canvas describes the arbitrary-angle refusal generically, without naming a dev-tier tool', () => {
    const text = description('gimp_transform_canvas').replace(/\s+/g, ' ');
    expect(text).toMatch(/refused while a position\/direction-dependent filter is present/);
    expect(text).not.toContain('gimp_add_effect');
  });

  it('the arbitrary-angle refusal says to delete and re-add, never "bake"', () => {
    expect(description('gimp_transform_canvas')).not.toMatch(/\bbake\b/);
  });
});

describe('gimp_add_adjustment scope: one layer, one range', () => {
  it('says a filter applies to ONE layer, and that a layer inside a group can be named', () => {
    expect(description('gimp_add_adjustment')).toMatch(/A filter applies to ONE layer/);
    const layer = field('gimp_add_adjustment', 'layer').replace(/\s+/g, ' ');
    expect(layer).toMatch(/applies to that ONE layer/);
    expect(layer).toMatch(/inside a layer group/);
  });
  it('says hue_saturation and color_balance carry one range per filter', () => {
    expect(description('gimp_add_adjustment').replace(/\s+/g, ' ')).toMatch(
      /hue_saturation and color_balance likewise carry ONE `range` per filter/
    );
    expect(field('gimp_add_adjustment', 'range')).toMatch(/ONE range per filter/);
  });
});

describe('gimp_add_adjustment field units', () => {
  it('sharpen amount is a multiplier, not a percent', () => {
    expect(field('gimp_add_adjustment', 'amount')).toMatch(/MULTIPLIER, not a percent/);
    expect(field('gimp_add_adjustment', 'amount')).toMatch(/1\.0 is strong/);
  });
  it.each(['whitepoint', 'compress', 'shadows_ccorrect', 'highlights_ccorrect'])(
    'shadows_highlights %s says what it does, not just its default',
    (prop) => {
      const text = field('gimp_add_adjustment', prop);
      expect(text).not.toMatch(/^shadows_highlights only\. Default \(when creating\): [\d.]+\.$/);
      expect(text.length).toBeGreaterThan(60);
    }
  );
  it('gaussian_blur is a type, with its radius described', () => {
    expect(description('gimp_add_adjustment')).toMatch(
      /gaussian_blur: radius in pixels at full resolution/
    );
    expect(field('gimp_add_adjustment', 'radius')).toMatch(/gaussian_blur: blur radius/);
  });
});

describe('geometry is irreversible; adjustments are not', () => {
  it.each(['gimp_crop_document', 'gimp_resize_image', 'gimp_transform_canvas'])(
    '%s says it is irreversible and to save first',
    (name) => {
      const text = description(name).replace(/\s+/g, ' ');
      expect(text).toMatch(/IRREVERSIBLE in this session: there is no undo/);
      expect(text).toMatch(/gimp_save_xcf first when in doubt/);
    }
  );
  it('the overview has the rule, including that adjustments come off with op=delete', () => {
    const text = overviewSection('No undo: geometry is permanent, adjustments are not').replace(
      /\s+/g,
      ' '
    );
    expect(text).toMatch(/Crop, resize, rotate, and flip are IRREVERSIBLE/);
    expect(text).toMatch(/`gimp_filter` \(op=delete\) removes one/);
  });
});

describe('long full-resolution work warns that a timeout loses unsaved work', () => {
  it('gimp_get_histogram exact says to save first', () => {
    expect(field('gimp_get_histogram', 'exact').replace(/\s+/g, ' ')).toMatch(
      /if it times out the GIMP session restarts and unsaved work is lost, so save \(gimp_save_xcf\) first/
    );
  });
  it('gimp_save_xcf says to save early', () => {
    expect(description('gimp_save_xcf').replace(/\s+/g, ' ')).toMatch(
      /if any call times out the GIMP session restarts and every unsaved open image and filter is lost/
    );
  });
});

describe('raw handling matches op_open (the load is always tried first)', () => {
  it('the overview no longer says raw is always refused', () => {
    const text = overviewSection('Raw files need a raw-develop plug-in').replace(/\s+/g, ' ');
    expect(text).toMatch(/always tries the load/);
    expect(GIMP_OVERVIEW_MARKDOWN).not.toMatch(/## No raw support/);
  });
});

describe('annotations', () => {
  it.each(['gimp_filter', 'gimp_export', 'gimp_create_mask'])(
    '%s is marked destructive',
    (name) => {
      expect(byName.get(name)!.annotations?.destructiveHint).toBe(true);
    }
  );
});

describe('levels input rules match lib.validate_levels', () => {
  it('in_low/in_high say the input range must not be empty or inverted, and gamma states its bound', () => {
    expect(field('gimp_add_adjustment', 'in_low')).toMatch(/must stay below in_high/);
    expect(field('gimp_add_adjustment', 'in_high')).toMatch(/must stay above in_low/);
    expect(field('gimp_add_adjustment', 'gamma')).toMatch(/0\.1\.\.10/);
  });
});

describe('open clears a selection saved in the file (op_open)', () => {
  it('is stated on gimp_open_document and in the overview', () => {
    expect(description('gimp_open_document').replace(/\s+/g, ' ')).toMatch(
      /Any selection saved in the file is cleared on open/
    );
    expect(overviewSection('.xcf vs export').replace(/\s+/g, ' ')).toMatch(
      /Opening a file clears any selection saved in it/
    );
  });
});
