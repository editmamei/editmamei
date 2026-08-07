/**
 * AM Event Library — shared types.
 *
 * The spec is the single source of truth for what ActionManager (AM)
 * descriptor each Editmamei snippet should emit. Each `AmEventSpec` is
 * a captured-from-Photoshop ground truth that pins event IDs, descriptor
 * keys, value types, units, enum values, and required/optional status.
 *
 * Consumers:
 *   - tests/spec/*.test.ts assert that each snippet's emitted JSX string
 *     contains the typeIDs and structural fragments the spec requires
 *   - scripts/spec-generate-md.ts renders a human-readable reference doc
 *     per version/category/event (do not hand-edit; regen)
 *   - future runtime snippet builders dispatch by detected PS major
 *     version via src/spec/index.ts
 *
 * When PS releases a new major version, copy `src/spec/ps<N>/` to
 * `src/spec/ps<N+1>/`, re-run the AM Descriptor Audit, and diff the
 * resulting capture against the existing spec. Update differing
 * entries, leave matching ones.
 */

/** A Photoshop type identifier — either a 4-char charID or a stringID. */
export type AmTypeID =
  | { kind: 'charID'; value: string } // 4-char code, e.g. "HStr"
  | { kind: 'stringID'; value: string }; // string code, e.g. "hueSaturation"

/** Convenience constructors so spec files stay readable. */
export const charID = (value: string): AmTypeID => ({ kind: 'charID', value });
export const stringID = (value: string): AmTypeID => ({ kind: 'stringID', value });

/** Photoshop value-type primitives carried in AM descriptors. */
export type AmValueKind =
  | 'integer' // putInteger
  | 'double' // putDouble (no unit)
  | 'unitDouble' // putUnitDouble (has a unit type)
  | 'boolean' // putBoolean
  | 'string' // putString
  | 'class' // putClass (typeID only — no inner data)
  | 'enum' // putEnumerated (typeID + value enum)
  | 'object' // putObject (typeID + inner descriptor)
  | 'list' // putList (list of items)
  | 'reference' // putReference
  | 'data'; // putData (binary blob, e.g. LUT bytes)

/** A unit for a unitDouble value. */
export type AmUnit =
  | { charID: '#Prc' } // percent (0..100)
  | { charID: '#Pxl' } // pixels
  | { charID: '#Ang' } // angle (degrees)
  | { charID: '#Rds' } // radians
  | { charID: '#Pnt' } // points
  | { charID: '#Mlm' } // millimeters
  | { charID: '#Rlt' } // relative (1.0 = 100%)
  | { charID: '#Nne' }; // density / unitless

/** Range constraint for numeric fields. */
export interface AmNumericRange {
  min?: number;
  max?: number;
  default?: number;
}

/** A value within an enum. */
export interface AmEnumValue {
  /** PS type ID for the enum value (e.g. `presetKindDefault`). */
  typeID: AmTypeID;
  /** Human-readable label of what the PS UI calls this (optional). */
  label?: string;
  /** When PS emits this value (which UI state triggers it). */
  context?: string;
}

/** Shape of an object-kind value's inner descriptor. */
export interface AmObjectShape {
  /** The class typeID identifying the object kind (e.g. `HStr` for HueSat). */
  classID: AmTypeID;
  /** Fields inside the inner descriptor. */
  fields: AmField[];
}

/** Reference value (e.g. a layer reference, channel reference). */
export interface AmReferenceShape {
  /** Class being referenced (e.g. `Lyr `, `Chnl`, `AdjL`). */
  classID: AmTypeID;
  /**
   * Reference key used to identify the target:
   *   - 'enumerated' → ordinal/target/composite (e.g. `Ordn`/`Trgt`)
   *   - 'name' → by string name
   *   - 'index' → by integer index
   *   - 'property' → property of class (e.g. `fsel` for current selection)
   *   - 'identifier' → by Idnt integer
   *   - 'class' → just the class (used for Make events with `Nw `)
   */
  variant: 'enumerated' | 'name' | 'index' | 'property' | 'identifier' | 'class';
  /** For 'enumerated': the enum type + the value (e.g. `Ordn`+`Trgt`). */
  enumKey?: AmTypeID;
  enumValue?: AmTypeID;
  /** For 'property': the property typeID (e.g. `fsel`). */
  property?: AmTypeID;
}

/** A field within a descriptor. */
export interface AmField {
  /** Human-readable name (matches the PS UI control or the descriptor key). */
  name: string;
  /** The PS type ID identifying this field in the descriptor. */
  typeID: AmTypeID;
  /** Value type. */
  kind: AmValueKind;
  /**
   * Required vs optional. PS emits required keys always; optional only
   * when they differ from the default. Snippets must emit required
   * fields; optional fields can be skipped to fall back to PS defaults.
   */
  required: boolean;
  /** Type-specific details below. */
  /** for kind='unitDouble' */
  unit?: AmUnit;
  /** for kind='integer' | 'double' | 'unitDouble' */
  range?: AmNumericRange;
  /** for kind='enum' — the enum type ID. */
  enumType?: AmTypeID;
  /** for kind='enum' — the allowed values. */
  enumValues?: AmEnumValue[];
  /** for kind='list' — what each item looks like. */
  itemSchema?: AmObjectShape | { primitive: AmValueKind };
  /** for kind='object' — the nested descriptor. */
  innerShape?: AmObjectShape;
  /** for kind='reference' — the reference shape. */
  referenceShape?: AmReferenceShape;
  /** for kind='boolean' — default if not emitted. */
  booleanDefault?: boolean;
  /** for kind='string' — default if not emitted, or allowed-values list. */
  stringDefault?: string;
  stringAllowedValues?: string[];
  /** Description (what this controls in the PS UI). */
  description?: string;
  /** Known gotchas (silent-no-op patterns, version drift, etc.). */
  gotchas?: string[];
}

/** Capture metadata — where the ground truth came from. */
export interface AmCapture {
  /** ISO date the capture was taken. */
  capturedAt: string; // e.g. '2026-06-03'
  /** PS version, e.g. '27.7.0'. */
  psVersion: string;
  /** Platform. */
  platform: 'Windows' | 'macOS';
  /** Repo-relative path to the ScriptListener log. */
  sourceLog: string;
  /** PS UI menu path / action that produced the capture. */
  menuPath: string;
}

/** One AM event in a multi-event sequence. */
export interface AmEvent {
  /** Order in the sequence (1-based for human readability). */
  index: number;
  /** Event typeID (e.g. charID('Mk  '), charID('setd')). */
  event: AmTypeID;
  /** Top-level descriptor (null if event is parameterless, e.g. Invr). */
  descriptor: AmObjectShape | null;
  /**
   * Explicit flag for "this event takes NO descriptor at all" (PS canonical
   * form passes `undefined` as the descriptor arg, e.g. `Invr`). Distinguishes
   * "parameterless by design" from "descriptor not yet captured." When true,
   * `descriptor` MUST be null. Editmamei snippets may still pass an empty
   * `new ActionDescriptor()` instead of `undefined` (an ExtendScript runtime
   * quirk) — semantically identical.
   */
  noDescriptor?: boolean;
  /** Comment explaining what this event does in the sequence. */
  comment?: string;
}

/** The complete spec for one PS UI action / Editmamei tool op. */
export interface AmEventSpec {
  /** Stable identifier for this spec (e.g. 'adjustments/hue-saturation'). */
  id: string;
  /** Human-readable display name (e.g. 'Hue/Saturation adjustment layer'). */
  displayName: string;
  /** Category (corresponds to subdirectory). */
  category:
    | 'adjustments'
    | 'filters'
    | 'layer-styles'
    | 'layer-ops'
    | 'masks'
    | 'selection'
    | 'place'
    | 'retouch';
  /** Sequence of AM events this op emits when the user triggers the PS UI. */
  events: AmEvent[];
  /** Ground-truth capture metadata. */
  groundTruth: AmCapture;
  /** Editmamei tool(s) that emit this op (e.g. `ps_add_adjustment_layer`). */
  emittedBy: string[];
  /** Snippet location for cross-reference (e.g. 'src/api/extendscript.ts:3068'). */
  snippetRef?: string;
  /** Known gotchas / silent-no-op risks at the whole-op level. */
  knownGotchas?: string[];
  /** Notes on cross-version drift (Adobe rotates keys between majors). */
  versionNotes?: string[];
}

/** Registry of all specs for a single PS major version. */
export interface SpecRegistry {
  /** Major version this registry targets (e.g. '27'). */
  psMajor: string;
  /** All event specs keyed by id. */
  specs: Record<string, AmEventSpec>;
}
