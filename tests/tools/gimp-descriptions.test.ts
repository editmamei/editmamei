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
    expect(gimpTools.length).toBeGreaterThanOrEqual(16);
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

describe('gimp_checkpoint: disk-backed undo substitute', () => {
  it('explains create/restore/list/delete and the replace-semantics recovery phrasing', () => {
    const text = description('gimp_checkpoint').replace(/\s+/g, ' ');
    expect(text).toMatch(/op=create exports the image's CURRENT state/);
    expect(text).toMatch(/replace semantics, not a copy/);
    expect(text).toMatch(/closed; restored as image M — use M from now on/);
  });
  it('says a checkpoint still works after a gimp_session_restarted error', () => {
    expect(description('gimp_checkpoint').replace(/\s+/g, ' ')).toMatch(
      /still works right after a gimp_session_restarted error/
    );
  });
  it('states the 5-per-image cap and that it refuses rather than evicts', () => {
    const text = description('gimp_checkpoint').replace(/\s+/g, ' ');
    expect(text).toMatch(/at most 5 checkpoints/);
    expect(text).toMatch(/REFUSES outright rather than silently evicting the oldest/);
  });
  it("says checkpoint files are kept while the server runs and removed at exit, and a crashed server's leftovers are removed on the next checkpoint", () => {
    const text = description('gimp_checkpoint').replace(/\s+/g, ' ');
    expect(text).toMatch(
      /Checkpoint files are kept while this server runs and removed when it exits/
    );
    expect(text).toMatch(
      /files left by a server that crashed are removed the next time a checkpoint is made/
    );
  });
  it('qualifies "the old image id stops working" for when close fails', () => {
    const text = description('gimp_checkpoint').replace(/\s+/g, ' ');
    expect(text).toMatch(/the old image id stops working once the close succeeds/);
    expect(text).toMatch(/if it fails instead.*close_failed: true.*the old image stays open/);
  });
  it('says a stale checkpoint (its image since closed) is still restorable and excluded from that images cap/scoped list', () => {
    const text = description('gimp_checkpoint').replace(/\s+/g, ' ');
    expect(text).toMatch(/open: false for a checkpoint whose image has since closed/);
    expect(text).toMatch(/still restorable/);
  });
  it('says list never reports a file path, and why', () => {
    expect(description('gimp_checkpoint').replace(/\s+/g, ' ')).toMatch(
      /never a file path \(a full path carries the username\)/
    );
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

describe('gimp_inspect describe-by-id targets (document/layers/channels/filter)', () => {
  // ops.py op_describe's layer tree addresses by layer_id, not name -- duplicate layer names
  // are legal in GIMP, so only the id is a reliable handle.
  it('the what field says layer tree nodes are addressed by layer_id, and flag is_text_layer', () => {
    const text = field('gimp_inspect', 'what').replace(/\s+/g, ' ');
    expect(text).toMatch(/addressed by `?layer_id`?/);
    expect(text).toMatch(/is_text_layer/);
  });
  it('the tool description repeats the same two facts', () => {
    const text = description('gimp_inspect').replace(/\s+/g, ' ');
    expect(text).toMatch(/addressed by `?layer_id`?/);
    expect(text).toMatch(/is_text_layer/);
  });
  it('image says it is required for every what except documents', () => {
    expect(field('gimp_inspect', 'image').replace(/\s+/g, ' ')).toMatch(
      /Required for every `?what`? except 'documents'/
    );
  });
  it("filter_id says it is required for what='filter'", () => {
    expect(field('gimp_inspect', 'filter_id')).toMatch(/Required for what='filter'/);
  });
  it("what='filter' says it reuses gimp_filter op=list's own shape", () => {
    expect(field('gimp_inspect', 'what').replace(/\s+/g, ' ')).toMatch(
      /same shape gimp_filter \(op=list\) reports it in/
    );
  });
  // ops.py's MAX_DESCRIBE_LAYER_NODES caps the tree and reports `truncated: true` on the way out.
  it('the what field and the tool description both state the 2000-node cap and truncated flag', () => {
    const whatText = field('gimp_inspect', 'what').replace(/\s+/g, ' ');
    const descText = description('gimp_inspect').replace(/\s+/g, ' ');
    for (const text of [whatText, descText]) {
      expect(text).toMatch(/2000 nodes/);
      expect(text).toMatch(/truncated.*true/);
    }
  });
  // ops.py's _channels_summary (document) vs _channels_described (channels): coverage reads a
  // full pixel buffer per channel, so `document` deliberately skips it.
  it("document's channel listing is id/name only; channels carries coverage instead", () => {
    const whatText = field('gimp_inspect', 'what').replace(/\s+/g, ' ');
    expect(whatText).toMatch(/id\/name only \(no coverage\)/);
    expect(whatText).toMatch(/coverage \(selected_pixels\/fraction\)/);
    const descText = description('gimp_inspect').replace(/\s+/g, ' ');
    expect(descText).toMatch(/no coverage/);
    expect(descText).toMatch(/coverage \(selected_pixels\/fraction\)/);
  });
});

describe('gimp_layer: gimp_group is folded in', () => {
  it('the tool description says create_group + reorder cover it', () => {
    expect(description('gimp_layer').replace(/\s+/g, ' ')).toMatch(
      /gimp_group is folded in as create_group \+ reorder's parent_group/
    );
  });
});

describe('gimp_layer: addressing is layer_id (canonical) or layer (name)', () => {
  it('the tool description and layer_id field both say layer_id is canonical', () => {
    const desc = description('gimp_layer').replace(/\s+/g, ' ');
    expect(desc).toMatch(/layer_id \(canonical/);
    expect(field('gimp_layer', 'layer_id').replace(/\s+/g, ' ')).toMatch(
      /only way to address two layers that happen to share a name/
    );
  });
});

describe('gimp_layer op=duplicate refuses on an Editmamei filter', () => {
  // ops.py's op_layer duplicate branch: DrawableFilter.set_name does not exist on this GIMP
  // build (verified live), and the ledger is keyed by filter name.
  it('the tool description and op field both name DrawableFilter.set_name and the ledger-name collision', () => {
    const desc = description('gimp_layer').replace(/\s+/g, ' ');
    expect(desc).toMatch(/DrawableFilter\.set_name does not exist/);
    expect(desc).toMatch(/bake it first \(gimp_bake\) or delete it, then duplicate/i);
    const opField = field('gimp_layer', 'op').replace(/\s+/g, ' ');
    expect(opField).toMatch(/REFUSED when the layer/);
    expect(opField).toMatch(/silently rewrite the original's own record/);
  });
});

describe('gimp_layer op=move refuses on a masked or unverifiable filter', () => {
  // ops.py's _refuse_if_masked_filters_on: a filter's mask does not travel with set_offsets
  // (verified live), the same physics gimp_transform_canvas already refuses on.
  it('the tool description, op field, and x/y fields all say move is an ABSOLUTE offset that refuses on a masked filter', () => {
    const desc = description('gimp_layer').replace(/\s+/g, ' ');
    expect(desc).toMatch(/ABSOLUTE x\/y \(not a delta\)/);
    expect(desc).toMatch(/does not travel with the layer when it moves/);
    const opField = field('gimp_layer', 'op').replace(/\s+/g, ' ');
    expect(opField).toMatch(/ABSOLUTE x\/y \(not a delta\)/);
    expect(opField).toMatch(/does not travel with the layer/);
    expect(field('gimp_layer', 'x')).toMatch(/ABSOLUTE horizontal offset/);
    expect(field('gimp_layer', 'y')).toMatch(/ABSOLUTE vertical offset/);
  });
});

describe('gimp_layer merge_down/flatten bake filters and can rasterize text', () => {
  it('the tool description says masked filters survive the merge, text is rasterized, and flatten drops alpha', () => {
    const desc = description('gimp_layer').replace(/\s+/g, ' ');
    expect(desc).toMatch(/masked filters included.{0,40}verified correct through the merge/);
    expect(desc).toMatch(/rasterize any text layer.*rasterized_text/);
    expect(desc).toMatch(/flatten always drops alpha \(has_alpha: false\)/);
  });
});

describe('gimp_layer: no undo in this session', () => {
  it('says gimp_checkpoint or gimp_save_xcf first, matching the checkpoint/save framing elsewhere', () => {
    expect(description('gimp_layer').replace(/\s+/g, ' ')).toMatch(
      /there is no undo in this session: gimp_checkpoint or gimp_save_xcf first when in doubt/
    );
  });
});

describe('gimp_layer set: a fixed blend-mode list, not raw GEGL/GIMP names', () => {
  it('the op field and mode field both say so', () => {
    expect(field('gimp_layer', 'op').replace(/\s+/g, ' ')).toMatch(
      /mode is a blend mode from a fixed list, not a raw GEGL\/GIMP name/
    );
    expect(field('gimp_layer', 'mode')).toMatch(/not a raw GEGL\/GIMP mode name/);
  });
});

describe('gimp_bake: probed and verified, clears the masked-filter refusal', () => {
  it('the tool description says a masked filter survives the bake, and baking clears the geometry refusal', () => {
    const desc = description('gimp_bake').replace(/\s+/g, ' ');
    expect(desc).toMatch(
      /Verified live that a MASKED filter's confinement survives the bake exactly/
    );
    expect(desc).toMatch(/Baking clears any masked-filter refusal/);
    expect(desc).toMatch(
      /sanctioned way to make a masked adjustment safe to move, resize, rotate, or flip/
    );
  });
  it('says group layers are always skipped for all: true', () => {
    expect(description('gimp_bake').replace(/\s+/g, ' ')).toMatch(
      /group layers are always skipped \(GIMP cannot merge filters on a group item\)/
    );
  });
  it('is marked destructive and says there is no undo', () => {
    expect(byName.get('gimp_bake')!.annotations?.destructiveHint).toBe(true);
    expect(description('gimp_bake').replace(/\s+/g, ' ')).toMatch(
      /IRREVERSIBLE in this session: there is no undo/
    );
  });
});
