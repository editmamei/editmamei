/**
 * AM Event Library — version dispatcher.
 *
 * Consumers call `getSpecRegistry(psMajor)` to get the registry for the
 * detected PS major version. Snippet builders that vary per version use
 * the resolved spec to look up the right typeIDs and descriptor shapes.
 *
 * When PS releases a new major (e.g. 28), copy `src/spec/ps27/` to
 * `src/spec/ps28/`, re-run the AM Descriptor Audit, update entries
 * where the capture differs, and add the new registry to the dispatcher
 * below.
 */

import type { SpecRegistry } from './types.js';
import { ps27Registry } from './ps27/index.js';

const registries: Record<string, SpecRegistry> = {
  '27': ps27Registry,
  // Future: '28': ps28Registry, etc.
};

/**
 * Returns the spec registry for the given PS major version, or the
 * highest known registry as a fallback. Logs a warning when the
 * fallback path is taken so the user sees they're running on an
 * unverified PS major.
 */
export function getSpecRegistry(psMajor: string): SpecRegistry {
  const direct = registries[psMajor];
  if (direct) return direct;

  // Fallback to the highest known version.
  const known = Object.keys(registries).sort();
  const fallback = known[known.length - 1];
  if (!fallback) {
    throw new Error('AM spec registry empty — no PS version specs available.');
  }
  return registries[fallback];
}

export type {
  SpecRegistry,
  AmEventSpec,
  AmEvent,
  AmField,
  AmObjectShape,
  AmTypeID,
  AmValueKind,
  AmUnit,
  AmEnumValue,
  AmReferenceShape,
  AmCapture,
  AmNumericRange,
} from './types.js';
export { charID, stringID } from './types.js';
