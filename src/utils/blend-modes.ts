/**
 * Canonical blend-mode enum lists, shared between the layer and group
 * blend-mode setter tools.
 *
 * Each name here is the ExtendScript `BlendMode` enum member name (not the
 * Photoshop UI label). Both `setLayerBlendMode` and `setGroupBlendMode`
 * snippets ultimately do `BlendMode[name]`, so the string must match the
 * ExtendScript identifier exactly.
 *
 * Note: the "Color" blend mode is `COLORBLEND` in ExtendScript (Adobe could
 * not call it `COLOR` because that collides with the SolidColor class).
 */
export const LAYER_BLEND_MODES = [
  'NORMAL',
  'DISSOLVE',
  'DARKEN',
  'MULTIPLY',
  'COLORBURN',
  'LINEARBURN',
  'DARKERCOLOR',
  'LIGHTEN',
  'SCREEN',
  'COLORDODGE',
  'LINEARDODGE',
  'LIGHTERCOLOR',
  'OVERLAY',
  'SOFTLIGHT',
  'HARDLIGHT',
  'VIVIDLIGHT',
  'LINEARLIGHT',
  'PINLIGHT',
  'HARDMIX',
  'DIFFERENCE',
  'EXCLUSION',
  'SUBTRACT',
  'DIVIDE',
  'HUE',
  'SATURATION',
  'COLORBLEND',
  'LUMINOSITY',
] as const;

/**
 * Group (LayerSet) blend modes are the layer set + `PASSTHROUGH`.
 * `PASSTHROUGH` is group-only and is the default for new groups (adjustments
 * inside the group affect the layers below). `NORMAL` on a group composites
 * the group as a unit, useful when you want a single mask on a stack of
 * adjustments.
 */
export const GROUP_BLEND_MODES = ['PASSTHROUGH', ...LAYER_BLEND_MODES] as const;
