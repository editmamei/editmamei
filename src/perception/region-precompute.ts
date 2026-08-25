/**
 * Region precompute — Scene Model v2.1 oversight loop.
 *
 * A managed `scene:<target>` alpha channel caches a derived region so
 * `ps_select_by_reference` can LOAD it BY NAME (instant) instead of re-deriving.
 * Since 2026-08-25 they are written on FIRST USE by a select, not eagerly by
 * every scene read — `PRECOMPUTE_TARGETS` below has the measurements.
 *
 * Loading is by NAME and history-independent — `doc.selection.load(scene:<target>)`.
 * No cache-key / history matching is involved: an alpha channel is a real object
 * stored IN the document, which Photoshop keeps in sync with the canvas (it
 * crops/resizes WITH the image). It also lives only in the document it was saved
 * in, so switching documents naturally finds no channel and the caller re-derives.
 *
 * **Geometrically valid is not semantically current.** Photoshop keeps the mask
 * aligned to the canvas; it has no idea the sky underneath was replaced. Two
 * things bound that, and neither is the channel itself:
 *   - `invalidateSceneChannelsIfStale` purges when a scene read sees the
 *     document's pixels change (this is the one that fires on the default path);
 *   - `refresh:true` on `ps_select_by_reference` skips the channel and derives.
 * A select→edit→select run with no scene read in between consults neither, and
 * will serve the pre-edit mask. That window is documented in the
 * `ps_select_by_reference` description, which is where a caller can act on it.
 *
 * `lastPrecomputedKey`/`cachedMenu` below are ONLY a menu-reuse optimization for a
 * repeated `ps_read_scene` read at the same doc-state — they do NOT gate the
 * channel load. Same-process module state is mostly sufficient (one server, one
 * doc), but the in-memory key alone can't see the document going stale under it
 * (a channel deleted by hand, or the document reopened onto pixel-identical
 * content with a fresh document object that never had these channels) — the
 * `lastPrecomputedKey` match is therefore backed by ONE cheap existence-check PS
 * round trip (`channelsExist`) before the cached menu is trusted; anything
 * missing falls through to a full rebuild (fail-safe).
 */

import type { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from '../utils/run-script.js';
import { SCENE_CHANNEL_TIMEOUT_MS } from '../utils/operation-timeouts.js';
import { jsLit } from '../utils/jsx.js';
import { restoreCompositeChannel, getSelectionInfo } from '../api/extendscript/_helpers.js';
import { Logger } from '../utils/logger.js';
import type { SceneModel } from './scene-model.js';
import {
  resolveSelection,
  type SelectReferenceTarget,
  type ProRefine,
  type SkyContext,
} from './select-recipes.js';
import type { CompositionContext } from './region-scorer.js';

const logger = new Logger('region-precompute');

/** Doc-state key the current scene:* channels were saved for (same-process). */
let lastPrecomputedKey: string | null = null;
/** The menu computed for that state (so a cached scene read need not re-run). */
let cachedMenu: RegionMenuItem[] = [];

/** Test-only reset of the precompute state. */
export function __resetPrecompute(): void {
  lastPrecomputedKey = null;
  cachedMenu = [];
  channelsDocState = null;
  channelsWritten = false;
}

/**
 * The managed-channel namespace. **`scene:` is RESERVED**: every alpha channel
 * whose name starts with this prefix is treated as derived state Editmamei owns,
 * and is deleted without warning by `purgeSceneChannels` (on `ps_save_psd`), at
 * the start of every `precomputeRegions` pass, and by
 * `invalidateSceneChannelsIfStale` when a scene read sees the document change —
 * that third one fires on the DEFAULT path, so it is the one most likely to
 * delete a channel out from under you. A user channel named
 * `scene:mine` is therefore data loss, not a collision — the match is
 * prefix-only, so nothing distinguishes it from a mask we derived.
 *
 * Kept prefix-based rather than, say, tagging channels with metadata, because
 * ExtendScript exposes no per-channel user data — the name is the only carrier.
 * If that changes, prefer a real marker over the prefix and this hazard goes
 * away. Surfaced to users in the `ps_save_psd` / `ps_read_scene` schemas.
 */
export const CHANNEL_PREFIX = 'scene:';

/**
 * Save the CURRENT selection as the managed `scene:<target>` channel (the same
 * convention precomputeRegions uses) so any producer — including the Pro
 * face-feature tool — lands a channel that `select_by_reference` loads by name
 * and `deleteSceneChannelsScript` cleans. Best-effort; throws only on a hard
 * script error.
 */
export async function saveSelectionAsSceneChannel(
  connection: PhotoshopConnection,
  target: string
): Promise<void> {
  await runScript(
    connection,
    saveSelectionToNamedChannelScript(`${CHANNEL_PREFIX}${target}`),
    SCENE_CHANNEL_TIMEOUT_MS
  );
  channelsWritten = true;
}

/** The doc-state key the currently-saved `scene:*` channels were derived at. */
let channelsDocState: string | null = null;

/**
 * Whether anything has written a `scene:*` channel since the last known-clean
 * point. Purely an optimization — see `invalidateSceneChannelsIfStale` — and
 * deliberately conservative: it starts `true`-equivalent (via a null
 * `channelsDocState`, which forces a purge regardless) so an unknown document is
 * never assumed clean.
 */
let channelsWritten = false;

/**
 * Drop the derived `scene:*` channels when the document has moved on.
 *
 * The eager pass opened by deleting them, so no channel could outlive one scene
 * read at a changed doc-state. With the eager pass off by default that purge
 * stopped running, and `ps_save_psd` became the only one left in the tree —
 * which is far too late: replace the sky, read the scene, and
 * `ps_select_by_reference` would load the PRE-replacement mask by name and
 * report `passed:true, confidence:1`.
 *
 * Keyed on the scene model's `cache_key` (document identity + pixel hash), so
 * this costs one round trip when the document actually changed and nothing at
 * all when it did not. A null previous state also purges: the channels live in
 * the DOCUMENT, so they outlive this process and a stale one from an earlier
 * session is exactly the case that must not be trusted.
 *
 * A failed purge FAILS SAFE — the state is recorded only after the purge
 * actually lands, and cleared if it does not, so the next read tries again.
 * Latching the key first would mean one transient PS error (a modal, a busy
 * app, the timeout elapsing) permanently convinces this module the channels
 * belong to the new state: every later read returns at the guard, never
 * retries, and `ps_select_by_reference` serves the pre-edit mask with
 * `passed:true, confidence:1` for the lifetime of that doc-state — the exact
 * bug this function exists to prevent, latched in. This matches
 * `channelsExist`'s policy below: treat "couldn't verify" as "assume stale",
 * because the rebuild path is cheap and the wrong mask is not.
 *
 * Recovery if it does go stale: `ps_select_by_reference {refresh:true}`, which
 * skips the channel entirely and re-derives.
 *
 * **The round trip is skipped when there is provably nothing of ours to
 * delete.** Measured live 2026-08-25 on a 4898x3265 document: the purge cost
 * ~1.68s of a 4.57s read while deleting zero channels, because
 * `deleteSceneChannelsScript` pays a script round trip plus an unconditional
 * `restoreCompositeChannel` slct event regardless of what it finds. Two
 * conditions must BOTH hold to skip it, and they are deliberately narrow:
 *
 *  - `channelsDocState !== null` — we have purged this document at least once in
 *    this process, so we know its starting state. A null means "unknown", which
 *    covers a fresh process meeting channels left in a saved PSD by an earlier
 *    session, and always purges.
 *  - `!channelsWritten` — nothing has written a `scene:*` channel since. Only
 *    two places do (`saveSelectionAsSceneChannel` and the eager pass), and both
 *    set the flag.
 *
 * So the skip applies exactly to the read/edit/read loop where no select ever
 * ran, which is where the cost was pure waste. Any select at all, or any doubt
 * about the document, and the purge runs.
 */
export async function invalidateSceneChannelsIfStale(
  connection: PhotoshopConnection,
  cacheKey: string
): Promise<void> {
  if (channelsDocState === cacheKey) return;
  if (channelsDocState !== null && !channelsWritten) {
    // Known document, nothing written since it was last clean: there is no
    // scene:* channel to be stale. Adopt the new state without a round trip.
    channelsDocState = cacheKey;
    return;
  }
  try {
    await runScript(connection, deleteSceneChannelsScript(), SCENE_CHANNEL_TIMEOUT_MS);
    channelsDocState = cacheKey;
    channelsWritten = false;
  } catch {
    channelsDocState = null; // unknown → purge again on the next read
  }
}

/**
 * Targets precomputed as saved channels (skip the always-there geometric ones).
 *
 * Deriving all seven EAGERLY is now opt-in (`ps_read_scene save_regions:true`),
 * not the default. Measured live 2026-08-24 on a 4898x3265 layered PSD: the
 * eager pass cost 20.8s of derive (sky 9.0s, skin 3.6s, ground 3.5s, subject
 * 2.2s, shadows 1.4s, highlights 1.2s) plus channel saves, making the whole
 * `ps_read_scene` call 29.9s against a 30s executor timeout — while the scene
 * model underneath took 3.2s. Three of the seven targets were rejected and
 * produced nothing, so ~4.8s bought literally no channel.
 *
 * This is the same failure the face mesh hit on 2026-07-31 (see `faceMenu`
 * below), one level up, and it takes the same fix: advertise the menu, derive
 * on first request. A session selects one or two regions, not seven.
 */
const PRECOMPUTE_TARGETS: SelectReferenceTarget[] = [
  'sky',
  'ground',
  'shadows',
  'highlights',
  'skin',
  'subject',
  'face',
];

export interface RegionMenuItem {
  /** The managed channel name, e.g. `scene:sky`. */
  key: string;
  target: string;
  method: string;
  /**
   * The gate score from the derive that produced this entry. **Absent on
   * `on_demand` entries** — nothing has been derived yet, so there is no score
   * to report and inventing one (a confident-looking `1`) would assert a
   * verdict we have not earned. Consumers must treat `undefined` as "unknown",
   * never as zero.
   */
  confidence?: number;
  /** For subject — the COCO label. */
  label?: string;
  bounds: { left: number; top: number; right: number; bottom: number } | null;
  /**
   * True when the region is ADVERTISED as selectable but no channel has been
   * saved yet — `ps_select_by_reference` derives it on first request (and then
   * saves the channel, so repeats are instant). Set for the Pro face-feature
   * set and, since the lazy default, for the CE region set too: see the
   * eager-vs-lazy note above PRECOMPUTE_TARGETS.
   */
  on_demand?: boolean;
}

/**
 * The DEFAULT menu: advertise what `ps_select_by_reference` could resolve,
 * deriving nothing and touching Photoshop not at all.
 *
 * **What this can and cannot claim.** An eager pass reports `confidence`
 * because it ran the gate. This one has not, so entries carry `on_demand: true`
 * and NO confidence, and the caller learns the verdict when it selects. That is
 * a deliberate trade: the alternative (asserting selectability we never tested)
 * is the "authoritative-sounding verdict of absence" that `reconcileRegions`
 * exists to prevent, pointed the other way.
 *
 * **Gating is on ONNX-verified presence ONLY.** `face`/`subject`/`skin` are
 * advertised from the detector's own findings, which are real. The luminance
 * and geometry targets are advertised UNCONDITIONALLY — deliberately, because
 * the only cheap signal available for them is `model.regions[].coverage`, the
 * coarse histogram split that `reconcileRegions` documents as unreliable in
 * both directions (live 2026-07-30: a night cityscape scored 0.08 coarse sky
 * coverage against a genuine 0.83-confidence sky). Gating on it would hide
 * regions that are actually there, which is the worse error.
 */
export function candidateMenu(model: SceneModel): RegionMenuItem[] {
  const advertise = (target: SelectReferenceTarget): RegionMenuItem => ({
    key: `${CHANNEL_PREFIX}${target}`,
    target,
    // The real method is chosen at derive time (sky alone picks between
    // sky_ground_flood and threshold_white depending on context), so naming one
    // here would be a guess presented as fact.
    method: 'on_demand',
    bounds: null,
    on_demand: true,
  });

  const hasFace = model.faces.length > 0;
  const hasSubject = model.subjects.length > 0;
  const hasPerson = model.subjects.some((s) => s.label === 'person');

  const menu: RegionMenuItem[] = [
    advertise('sky'),
    advertise('ground'),
    advertise('shadows'),
    advertise('highlights'),
  ];
  // Matches the eager pass's own short-circuit: skin is a colour range
  // intersected with a person/face box, so with neither present there is
  // nothing to intersect and the derive cannot pass.
  if (hasPerson || hasFace) menu.push(advertise('skin'));
  if (hasSubject) menu.push(advertise('subject'));
  if (hasFace) menu.push(advertise('face'));
  return menu;
}

// ---------- channel glue (managed scene:* alpha channels) ----------
//
// `doc.channels.add()` makes the new alpha channel the sole active+visible
// channel and HIDES the RGB composite. Every script that adds/removes/loads a
// channel MUST therefore have `restoreCompositeChannel` DEFINED in scope AND
// *call* `restoreCompositeChannel(doc)` before returning — otherwise the
// document is left on a non-composite channel and the very next `doc.histogram`
// read throws "You can only get a histogram for visible channels" (it broke
// buildSceneModel's tonal-zone read on the next select_by_reference, caught live
// on PS 27.2 across 10 photos 2026-06-23). This mirrors getSelectionInfo's
// finally block in _helpers.ts.
//
// Two ways to get the definition in scope, and they are mutually exclusive:
// interpolate `${restoreCompositeChannel}` directly, OR interpolate
// `${getSelectionInfo}`, whose own source already opens with that definition.
// Doing BOTH emits two copies of the function body into the same script — legal
// (the later declaration just wins) but pure waste on a string that crosses the
// COM/AppleScript boundary. loadNamedChannelScript takes the getSelectionInfo
// route because it needs the measurement anyway; the other two take the direct
// route. The CALL is required either way.

function deleteSceneChannelsScript(): string {
  return `
    if (app.documents.length === 0) { throw new Error('No document is open in Photoshop'); }
    var doc = app.activeDocument;
    var removed = 0;
    for (var i = doc.channels.length - 1; i >= 0; i--) {
      if (String(doc.channels[i].name).indexOf(${jsLit(CHANNEL_PREFIX)}) === 0) {
        try { doc.channels[i].remove(); removed++; } catch (e) {}
      }
    }
    ${restoreCompositeChannel}
    restoreCompositeChannel(doc);
    return { removed: removed };
  `;
}

/**
 * Remove every managed `scene:*` channel from the active document and return how
 * many went. These are DERIVED state — `precomputeRegions` already wipes them at
 * the start of each pass and rebuilds — so dropping them costs at most a
 * re-derive, never user data.
 *
 * Exists because the channels are full-resolution masks: ~51MB each on a 51MP
 * document, and `ps_save_psd` would otherwise bake the whole set into the user's
 * file (~771MB measured live 2026-07-30 with the old eager face precompute).
 * Also resets the menu-reuse key, so the next scene read rebuilds rather than
 * trusting a menu whose channels this call just deleted.
 */
export async function purgeSceneChannels(connection: PhotoshopConnection): Promise<number> {
  const r = (await runScript(
    connection,
    deleteSceneChannelsScript(),
    SCENE_CHANNEL_TIMEOUT_MS
  )) as { removed?: number };
  lastPrecomputedKey = null;
  cachedMenu = [];
  return r.removed ?? 0;
}

function saveSelectionToNamedChannelScript(name: string): string {
  return `
    var doc = app.activeDocument;
    for (var i = doc.channels.length - 1; i >= 0; i--) {
      if (String(doc.channels[i].name) === ${jsLit(name)}) { try { doc.channels[i].remove(); } catch (e) {} }
    }
    var ch = doc.channels.add();
    doc.selection.store(ch, SelectionType.REPLACE);
    ch.name = ${jsLit(name)};
    ${restoreCompositeChannel}
    restoreCompositeChannel(doc);
    return { saved: true, name: ${jsLit(name)} };
  `;
}

function channelsExistScript(names: string[]): string {
  const namesLit = `[${names.map((n) => jsLit(n)).join(', ')}]`;
  return `
    // __mcp_scene_chk__ cheap existence check for previously-saved scene:* channels
    if (app.documents.length === 0) { throw new Error('No document is open in Photoshop'); }
    var doc = app.activeDocument;
    var have = {};
    for (var i = 0; i < doc.channels.length; i++) {
      have[String(doc.channels[i].name)] = true;
    }
    var names = ${namesLit};
    var allPresent = true;
    for (var j = 0; j < names.length; j++) {
      if (!have[names[j]]) { allPresent = false; break; }
    }
    return { all_present: allPresent };
  `;
}

/**
 * Cheap existence check (ONE PS round trip, or zero when `names` is empty) — do
 * every named `scene:*` channel still exist in the active document? Backs the
 * menu-reuse short-circuit below: the in-memory `cachedMenu` says this doc-state
 * was already precomputed, but the channels it names live IN THE DOCUMENT, which
 * can go stale independently of this process's memory — a channel deleted by
 * hand, or the document reopened onto pixel-identical content with a FRESH
 * document object that never had these channels saved (see scene-model.ts's
 * module doc comment for the matching pixel-identity staleness window). Reusing
 * the menu without this check would leave `ps_select_by_reference`'s by-name
 * channel load failing later, silently.
 */
async function channelsExist(connection: PhotoshopConnection, names: string[]): Promise<boolean> {
  if (names.length === 0) return true; // nothing was ever saved — vacuously present
  try {
    const r = (await runScript(connection, channelsExistScript(names))) as {
      all_present?: boolean;
    };
    return r.all_present === true;
  } catch (err) {
    // A transient PS error on this ONE round trip must not abort the whole
    // precompute pass — precomputeRegions awaits this inside its reuse gate, and
    // an uncaught rejection here used to propagate out of precomputeRegions
    // entirely, which the caller (ps_read_scene) swallows into "no regions" —
    // losing the menu instead of just rebuilding it. Treat "couldn't verify" the
    // same as "channels don't exist": the fail-safe full-rebuild path already
    // exists for exactly this situation.
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(
      `region-precompute: channelsExist check failed (${msg}) — treating as stale, rebuilding`
    );
    return false;
  }
}

function loadNamedChannelScript(name: string): string {
  return `
    // getSelectionInfo's own source begins with the restoreCompositeChannel
    // definition (see _helpers.ts), so interpolating it here brings BOTH into
    // scope. Interpolating restoreCompositeChannel separately as well emitted a
    // second, byte-identical copy of that function body into every load script —
    // legal (a later function declaration just wins) but pure waste in a string
    // that crosses the COM/AppleScript boundary on every select_by_reference.
    // Hoisted to the TOP so the restoreCompositeChannel(doc) call below sits
    // after its definition textually, rather than relying on hoisting across an
    // interpolation boundary.
    ${getSelectionInfo}
    if (app.documents.length === 0) { throw new Error('No document is open in Photoshop'); }
    var doc = app.activeDocument;
    var ch = null;
    for (var i = 0; i < doc.channels.length; i++) {
      if (String(doc.channels[i].name) === ${jsLit(name)}) { ch = doc.channels[i]; break; }
    }
    if (!ch) { return { loaded: false }; }
    doc.selection.load(ch, SelectionType.REPLACE);
    restoreCompositeChannel(doc);
    // Measure in the SAME round trip. The fast path used to return
    // selection_info:null, which forced any caller that wanted to verify the mask
    // into a second PS call — the one thing this path exists to avoid.
    return {
      loaded: true,
      width: doc.width.as('px'),
      height: doc.height.as('px'),
      selection_info: getSelectionInfo()
    };
  `;
}

/**
 * Wrap `connection` so every `executeScript` call (i.e. every PS round trip) is
 * tallied into `tally.scripts` — used ONLY for the trip-count accounting log
 * below. `Proxy<PhotoshopConnection>` types as `PhotoshopConnection` itself (the
 * built-in `Proxy` constructor's generic signature returns `T`), so this needs no
 * unsafe cast and every other member (`ping`, `getVersion`, `getPhotoshopInfo`)
 * passes through untouched. Counts trips made via BOTH the direct `runScript`
 * calls below AND every trip `resolveSelection` (select-recipes.ts) makes on this
 * same connection instance — the two modules share one PS queue per pass.
 */
function countingConnection(
  connection: PhotoshopConnection,
  tally: { scripts: number }
): PhotoshopConnection {
  return new Proxy(connection, {
    get(target, prop, receiver) {
      if (prop === 'executeScript') {
        return (script: string, timeoutMs?: number) => {
          tally.scripts++;
          return target.executeScript(script, timeoutMs);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

// ---------- precompute + fast load ----------

/**
 * Run every precompute target through the gate; save each PASSING region to a
 * `scene:*` channel and return the confident menu. Cleans stale channels first.
 * Records the doc-state key + menu so a REPEAT scene read at the same state can
 * reuse the menu without re-running the methods (this is a menu cache only — it
 * does NOT gate the by-name channel load in `loadPrecomputedRegion`).
 */
export async function precomputeRegions(
  connection: PhotoshopConnection,
  snippet: SnippetClient,
  model: SceneModel,
  composition?: CompositionContext,
  opts: {
    force?: boolean;
    proRefine?: ProRefine;
    skyCtx?: SkyContext;
    /**
     * Pro face-feature ADVERTISEMENT (not a computation). When a face is present
     * on an entitled/dev host, the caller passes the curated face-feature menu
     * so `ps_read_scene` still reports what is selectable — but the mesh does NOT
     * run here and no scene:face_* channel is written. Each entry carries
     * `on_demand: true`; `ps_select_by_reference` materializes it on first
     * request. Absent (CE / no face) → no face presets, which is honest absence.
     *
     * Was an eager `() => Promise<RegionMenuItem[]>` batch hook until 2026-07-31.
     * Running the mesh up front cost ~35s of the cold read and wrote NINE
     * full-resolution alpha channels; on a 51MP document that is ~51MB each,
     * ~463MB of the ~771MB total, which pushed Photoshop into memory pressure and
     * degraded every later channel load (437ms → 5s → a 30s script timeout,
     * measured live 2026-07-30). Sessions typically use one or two features, so
     * the set is now advertised eagerly and materialized lazily.
     */
    faceMenu?: RegionMenuItem[];
  } = {}
): Promise<RegionMenuItem[]> {
  // Menu-reuse: a repeat scene read at the SAME doc-state (pixel + doc identity,
  // scene-model.ts's cache_key) returns the cached menu (the channels are already
  // saved) — PROVIDED they still exist. `force` (refresh) always re-runs. The
  // identity match alone is not sufficient: the channels live in the document,
  // which can go stale independently of this process's in-memory key (deleted by
  // hand, or the doc reopened onto pixel-identical content with a fresh document
  // object) — one cheap existence-check round trip confirms before trusting the
  // cached menu; anything missing falls through to a full rebuild (fail-safe).
  if (
    !opts.force &&
    lastPrecomputedKey !== null &&
    lastPrecomputedKey === model.provenance.cache_key &&
    // Only channels we actually SAVED can be existence-checked. `on_demand`
    // entries are advertisements with no channel behind them yet, so including
    // them here would fail the gate every time and force a needless rebuild.
    (await channelsExist(
      connection,
      cachedMenu.filter((m) => !m.on_demand).map((m) => m.key)
    ))
  ) {
    return cachedMenu;
  }
  // Trip-count accounting (debug-level): tally every PS round trip this pass
  // issues — both directly below and inside resolveSelection's recipes — so a
  // future session can see the number in stderr logs without re-deriving it by
  // hand. Does not cover the on-demand face materialization, which happens later in select_by_reference.
  const tally = { scripts: 0 };
  const countedConnection = countingConnection(connection, tally);
  await runScript(countedConnection, deleteSceneChannelsScript(), SCENE_CHANNEL_TIMEOUT_MS);
  // This pass IS the purge, so record the state its channels belong to — else
  // the lazy path's staleness check would purge them again on the next read.
  channelsDocState = model.provenance.cache_key;
  channelsWritten = false;
  const menu: RegionMenuItem[] = [];
  for (const target of PRECOMPUTE_TARGETS) {
    try {
      const res = await resolveSelection(countedConnection, snippet, model, target, {
        composition,
        proRefine: opts.proRefine,
        skyCtx: opts.skyCtx,
      });
      if (res.passed) {
        const key = `${CHANNEL_PREFIX}${target}`;
        await runScript(
          countedConnection,
          saveSelectionToNamedChannelScript(key),
          SCENE_CHANNEL_TIMEOUT_MS
        );
        // Tell the lazy staleness check there is now something of ours to purge.
        channelsWritten = true;
        menu.push({
          key,
          target,
          method: res.method,
          confidence: res.confidence,
          label: res.detail?.label as string | undefined,
          bounds: (res.selection_info?.bounds ?? null) as RegionMenuItem['bounds'],
        });
      }
    } catch {
      // A method raised (e.g. a Sensei / colour-range op unavailable in this PS,
      // or the AI cloud model off) — skip THIS target; the rest of the menu still
      // builds. Per-target isolation keeps one flaky method from emptying the menu.
      continue;
    }
  }
  // Pro: ADVERTISE the face-feature set without running the mesh. These entries
  // name what `ps_select_by_reference` can materialize on demand; no PS work and
  // no channels are written here (see the `faceMenu` opt for why).
  if (opts.faceMenu?.length) {
    menu.push(...opts.faceMenu);
  }
  // The regions live in their channels now — drop the working selection.
  try {
    await runScript(countedConnection, await snippet.build('deselect'));
  } catch {
    // best-effort
  }
  logger.debug(
    `precompute: ${PRECOMPUTE_TARGETS.length} targets, ${tally.scripts} scripts` +
      ` (7 CE targets ≈ 21 scripts before the 2026-07-29 derive+measure merge → 15 after, ` +
      ` then 14 once skin short-circuits with no person/face (2026-08-01), ` +
      `on the all-fail path; production pass-paths differ)`
  );
  lastPrecomputedKey = model.provenance.cache_key;
  cachedMenu = menu;
  return menu;
}

/**
 * Fast path: load the saved `scene:<target>` channel as the active selection,
 * purely BY NAME. Returns the doc dimensions on success, or null when no such
 * channel exists in the active document (→ the caller derives the region on
 * demand). History-independent: an existing channel is always a valid saved
 * selection (Photoshop keeps it in sync with the canvas); `refresh:true` at the
 * call site is the way to force a fresh derive instead.
 */
export async function loadPrecomputedRegion(
  connection: PhotoshopConnection,
  target: string
): Promise<{
  width: number;
  height: number;
  selection_info: Record<string, unknown> | null;
} | null> {
  const r = (await runScript(
    connection,
    loadNamedChannelScript(`${CHANNEL_PREFIX}${target}`),
    SCENE_CHANNEL_TIMEOUT_MS
  )) as {
    loaded?: boolean;
    width?: number;
    height?: number;
    selection_info?: Record<string, unknown>;
  };
  if (r.loaded !== true) return null;
  return {
    width: r.width ?? 0,
    height: r.height ?? 0,
    selection_info: r.selection_info ?? null,
  };
}
