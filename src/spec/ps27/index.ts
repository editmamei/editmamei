/**
 * PS 27 spec registry — populated from the 2026-06-03 AM Descriptor Audit.
 *
 * Add new specs by importing them and appending to `ps27Registry.specs`.
 * Re-export every spec from a category index file too, so consumers can
 * import either `import { spec } from '...'` (dispatched) or import a
 * single spec module directly.
 */

import type { SpecRegistry } from '../types.js';
import * as adjustments from './adjustments/index.js';
import * as filters from './filters/index.js';
import * as layerStyles from './layer-styles/index.js';
import * as layerOps from './layer-ops/index.js';
import * as masks from './masks/index.js';
import * as selection from './selection/index.js';
import * as place from './place/index.js';
import * as retouch from './retouch/index.js';

const allSpecs = {
  ...adjustments,
  ...filters,
  ...layerStyles,
  ...layerOps,
  ...masks,
  ...selection,
  ...place,
  ...retouch,
};

export const ps27Registry: SpecRegistry = {
  psMajor: '27',
  specs: Object.fromEntries(
    Object.values(allSpecs)
      .filter(
        (s): s is import('../types.js').AmEventSpec => !!s && typeof s === 'object' && 'id' in s
      )
      .map((s) => [s.id, s])
  ),
};
