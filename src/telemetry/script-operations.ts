/**
 * Which Photoshop features a script reached for, by name, without keeping any of the script.
 *
 * Scripts reach Photoshop in two fixed shapes: DOM member calls (`doc.resizeCanvas(...)`) and
 * Action Manager calls (`executeAction(stringIDToTypeID('gaussianBlur'), ...)`). This reads those
 * shapes from a token stream. A name is sent only if it is on one of the published lists below;
 * anything else becomes the `unknown` catch-all, which carries a count and never the name. String
 * contents are read only as the id argument of those Action Manager calls, and only to compare
 * against the list, so a file path or on-image text has nowhere to go.
 *
 * Runs on the user's machine. The script is scanned once and not stored by this feature. The scan
 * is linear in a capped input, and no regular expression runs over the script as a whole.
 */

import { SCRIPT_TOOL } from '../core/tool-activity.js';
import { optionValues, toFeatureToken, type FeatureName } from './feature-details.js';

export { SCRIPT_TOOL };

/** Longer scripts aren't scanned, and count as `unknown` / `dynamic`. */
const MAX_SCRIPT_CHARS = 262_144;
/** No listed id comes close. A longer string can't match, so it needn't be kept. */
const MAX_ID_CHARS = 64;

/** Photoshop's scripting DOM methods. */
export const DOM_OPERATIONS: ReadonlySet<string> = new Set([
  // Application
  'batch',
  'bringToFront',
  'doAction',
  'doForcedProgress',
  'doProgress',
  'eraseCustomOptions',
  'executeActionGet',
  'featureEnabled',
  'load',
  'makeContactSheet',
  'makePDFPresentation',
  'makePhotoGallery',
  'makePhotomerge',
  'makePicturePackage',
  'open',
  'openDialog',
  'purge',
  'refresh',
  'refreshFonts',
  'runMenuItem',
  'showColorPicker',
  // Document
  'autoCount',
  'changeMode',
  'close',
  'convertProfile',
  'crop',
  'exportDocument',
  'flatten',
  'flipCanvas',
  'importAnnotations',
  'mergeVisibleLayers',
  'paste',
  'print',
  'printOneCopy',
  'rasterizeAllLayers',
  'recordMeasurements',
  'resizeCanvas',
  'resizeImage',
  'revealAll',
  'rotateCanvas',
  'save',
  'saveAs',
  'splitChannels',
  'suspendHistory',
  'trap',
  'trim',
  // Layers
  'add',
  'adjustBrightnessContrast',
  'adjustColorBalance',
  'adjustCurves',
  'adjustLevels',
  'applyAddNoise',
  'applyAverage',
  'applyBlur',
  'applyBlurMore',
  'applyClouds',
  'applyCustomFilter',
  'applyDeInterlace',
  'applyDespeckle',
  'applyDifferenceClouds',
  'applyDiffuseGlow',
  'applyDisplace',
  'applyDustAndScratches',
  'applyFade',
  'applyFibers',
  'applyFilmGrain',
  'applyGaussianBlur',
  'applyGlassEffect',
  'applyHighPass',
  'applyLensBlur',
  'applyLensFlare',
  'applyMaximum',
  'applyMedianNoise',
  'applyMinimum',
  'applyMotionBlur',
  'applyNTSC',
  'applyOceanRipple',
  'applyOffset',
  'applyPinch',
  'applyPolarCoordinates',
  'applyRadialBlur',
  'applyRipple',
  'applySharpen',
  'applySharpenEdges',
  'applySharpenMore',
  'applyShear',
  'applySmartBlur',
  'applySpherize',
  'applyStyle',
  'applyTextureFill',
  'applyTwirl',
  'applyUnSharpMask',
  'applyWave',
  'applyZigZag',
  'autoContrast',
  'autoLevels',
  'clear',
  'copy',
  'cut',
  'desaturate',
  'duplicate',
  'equalize',
  'link',
  'merge',
  'mixChannels',
  'move',
  'moveAfter',
  'moveBefore',
  'moveToBeginning',
  'moveToEnd',
  'photoFilter',
  'posterize',
  'rasterize',
  'remove',
  'removeAll',
  'resize',
  'rotate',
  'selectiveColor',
  'shadowHighlight',
  'threshold',
  'translate',
  'unlink',
  // Selection
  'contract',
  'deselect',
  'expand',
  'feather',
  'fill',
  'grow',
  'invert',
  'makeWorkPath',
  'resizeBoundary',
  'rotateBoundary',
  'select',
  'selectAll',
  'selectBorder',
  'similar',
  'smooth',
  'store',
  'stroke',
  'translateBoundary',
  // Paths and text
  'convertToShape',
  'createPath',
  'fillPath',
  'makeClippingPath',
  'makeSelection',
  'strokePath',
]);

/** Photoshop's own Action Manager event ids, as string ids and as trimmed char ids. */
export const ACTION_OPERATIONS: ReadonlySet<string> = new Set([
  // String ids
  'addNoise',
  'adobeStock',
  'align',
  'applyImageEvent',
  'applyLocking',
  'autoCutout',
  'autoFixCorrect',
  'axisAlignment',
  'blackAndWhite',
  'calculations',
  'canvasSize',
  'cameraRaw',
  'cameraRawFilter',
  'channelMixer',
  'clearEvent',
  'close',
  'colorBalance',
  'colorLookup',
  'contentAwareFill',
  'contentLayer',
  'convertToProfile',
  'copyEvent',
  'copyToLayer',
  'crop',
  'curves',
  'cut',
  'cutToLayer',
  'delete',
  'desaturate',
  'dustAndScratches',
  'duplicate',
  'exchange',
  'exportDocumentAs',
  'exportSelectionAsFileTypePressed',
  'fade',
  'fill',
  'flattenImage',
  'gaussianBlur',
  'generativeFill',
  'gradientClassEvent',
  'gradientMapEvent',
  'groupEvent',
  'highPass',
  'hueSaturation',
  'imageSize',
  'invert',
  'layerStyle',
  'levels',
  'linkSelectedLayers',
  'make',
  'median',
  'mergeLayers',
  'mergeLayersNew',
  'mergeVisible',
  'motionBlur',
  'move',
  'newPlacedLayer',
  'nextFrame',
  'open',
  'paste',
  'photoFilter',
  'placedLayerConvertToEmbedded',
  'placedLayerEditContents',
  'placedLayerExportContents',
  'placedLayerRelinkToFile',
  'placedLayerReplaceContents',
  'placeEvent',
  'quickSelect',
  'rasterizeLayer',
  'reduceNoise',
  'removeBackground',
  'renameLayer',
  'replaceColor',
  'reset',
  'resetSwatches',
  'revert',
  'rotateEventEnum',
  'save',
  'select',
  'selectAllLayers',
  'selectiveColor',
  'selectNoLayers',
  'set',
  'shadowHighlight',
  'sharpen',
  'skyReplacement',
  'smartBlur',
  'smartSharpen',
  'stroke',
  'surfaceBlur',
  'threshold',
  'transform',
  'trim',
  'ungroupLayersEvent',
  'unsharpMask',
  'vibrance',
  'autoSelectSubject',
  'selectSubject',
  'selectSky',
  'Adobe Camera Raw Filter',
  'CameraRaw',
  'autoMaskGenerate',
  'focusMask',
  'quit',
  'refineSelectionEdge',
  // Char ids
  'AdNs',
  'Algn',
  'BlrM',
  'BrgC',
  'ClrB',
  'Crop',
  'Crvs',
  'CvrP',
  'CnvS',
  'CpTL',
  'Cls',
  'Dlt',
  'Dplc',
  'Dstr',
  'Exch',
  'Expn',
  'Fl',
  'FlIm',
  'Fthr',
  'GsnB',
  'Grdn',
  'GrpL',
  'HStr',
  'HghP',
  'ImgS',
  'Invr',
  'Lvls',
  'Mdn',
  'Mk',
  'MrgL',
  'MrgV',
  'Mtnb',
  'Mxm',
  'Ofst',
  'Opn',
  'PbTL',
  'Plc',
  'Rstr',
  'Rtte',
  'SbtF',
  'Slct',
  'Sv',
  'SvAs',
  'Trnf',
  'UnsM',
  'CamR',
  'Clds',
  'DfrC',
  'Flip',
  'Hd',
  'Ungr',
  'autC',
  'copy',
  'jump',
  'move',
  'past',
  'setd',
  'slct',
]);

/** Reaches outside Photoshop, or loads code this scan can't see. Always worth a count. */
export const SCRIPT_CAPABILITIES: ReadonlySet<string> = new Set([
  'app.system',
  'app.doScript',
  'File',
  'Folder',
  'Socket',
  'BridgeTalk',
  'ExternalObject',
  '$.evalFile',
  '$.eval',
  'eval',
  'Function',
]);

/** JavaScript's and ExtendScript's own methods, which say nothing about Photoshop. */
const LANGUAGE_METHODS: ReadonlySet<string> = new Set([
  'apply',
  'bind',
  'call',
  'push',
  'pop',
  'shift',
  'unshift',
  'join',
  'slice',
  'splice',
  'concat',
  'reverse',
  'sort',
  'indexOf',
  'lastIndexOf',
  'charAt',
  'charCodeAt',
  'fromCharCode',
  'substring',
  'substr',
  'split',
  'replace',
  'match',
  'search',
  'test',
  'exec',
  'toString',
  'toSource',
  'toFixed',
  'toUpperCase',
  'toLowerCase',
  'valueOf',
  'hasOwnProperty',
  'abs',
  'floor',
  'ceil',
  'round',
  'min',
  'max',
  'pow',
  'sqrt',
  'random',
  'atan2',
  'sin',
  'cos',
  'parse',
  'stringify',
  'write',
  'writeln',
  'read',
  'readln',
  'seek',
  'tell',
  'sleep',
  'gc',
  'encode',
  'decode',
  // UnitValue, and the file system object model.
  'as',
  'create',
  'toStream',
  'fromStream',
]);

/** Action descriptor plumbing and lookups (`putString`, `getByName`, `hasKey`). */
function isPlumbing(name: string): boolean {
  return /^(?:put|get|has|is|set)[A-Z]/.test(name) || name.endsWith('IDToTypeID');
}

type Token =
  | { kind: 'id'; text: string }
  | { kind: 'str'; text: string }
  | { kind: 'punct'; text: string }
  | { kind: 'num' };

const isIdStart = (c: string): boolean => /^[A-Za-z_$]$/.test(c);
const isIdPart = (c: string): boolean => /^[A-Za-z0-9_$]$/.test(c);
const isDigit = (c: string): boolean => c >= '0' && c <= '9';

/** One pass over the source. Comments go, and so does the text of any string too long to match. */
function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (c === '"' || c === "'") {
      const start = (i += 1);
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        i += src[i] === '\\' ? 2 : 1;
      }
      const raw = i - start <= MAX_ID_CHARS ? src.slice(start, i) : '';
      tokens.push({ kind: 'str', text: raw });
      i += 1;
    } else if (isIdStart(c)) {
      const start = i;
      while (i < src.length && isIdPart(src[i])) i += 1;
      tokens.push({ kind: 'id', text: src.slice(start, i) });
    } else if (isDigit(c)) {
      while (i < src.length && (isIdPart(src[i]) || src[i] === '.')) i += 1;
      tokens.push({ kind: 'num' });
    } else if (c === '/' && !endsAnExpression(tokens[tokens.length - 1])) {
      // A regular expression literal. Its contents can look like anything.
      i += 1;
      let inClass = false;
      while (i < src.length && src[i] !== '\n' && (inClass || src[i] !== '/')) {
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        i += src[i] === '\\' ? 2 : 1;
      }
      i += 1;
      tokens.push({ kind: 'num' });
    } else {
      tokens.push({ kind: 'punct', text: c });
      i += 1;
    }
  }
  return tokens;
}

function endsAnExpression(token: Token | undefined): boolean {
  if (!token) return false;
  if (token.kind !== 'punct') return true;
  return token.text === ')' || token.text === ']';
}

class TokenReader {
  constructor(private readonly tokens: Token[]) {}

  get length(): number {
    return this.tokens.length;
  }

  id(i: number): string | null {
    const t = this.tokens[i];
    return t?.kind === 'id' ? t.text : null;
  }

  str(i: number): string | null {
    const t = this.tokens[i];
    return t?.kind === 'str' ? t.text : null;
  }

  is(i: number, punct: string): boolean {
    const t = this.tokens[i];
    return t?.kind === 'punct' && t.text === punct;
  }
}

const ID_FUNCTIONS = new Set(['stringIDToTypeID', 'charIDToTypeID']);

/** Index just past an optional `app.` prefix. */
function skipApp(r: TokenReader, i: number): number {
  return r.id(i) === 'app' && r.is(i + 1, '.') ? i + 2 : i;
}

/** The things a script defines for itself, which aren't Photoshop's and aren't unknown. */
function collectDefinitions(r: TokenReader): {
  aliases: Set<string>;
  idVars: Map<string, string>;
  local: Set<string>;
} {
  const aliases = new Set<string>(ID_FUNCTIONS);
  const idVars = new Map<string, string>();
  const local = new Set<string>();

  // `function NAME(x) { return [app.]stringIDToTypeID(x)`, or the same as `NAME = function(x)`.
  const wrapsIdFunction = (afterParams: number): boolean => {
    if (!r.is(afterParams, '{') || r.id(afterParams + 1) !== 'return') return false;
    return ID_FUNCTIONS.has(r.id(skipApp(r, afterParams + 2)) ?? '');
  };
  const isSingleParam = (i: number): boolean =>
    r.is(i, '(') && r.id(i + 1) !== null && r.is(i + 2, ')');

  for (let i = 0; i < r.length; i++) {
    const name = r.id(i);
    if (name === null) continue;
    if (name === 'function' && r.id(i + 1) !== null) {
      const fn = r.id(i + 1) as string;
      local.add(fn);
      if (isSingleParam(i + 2) && wrapsIdFunction(i + 5)) aliases.add(fn);
    } else if (r.is(i + 1, ':') && r.id(i + 2) === 'function') {
      local.add(name);
    } else if (r.is(i + 1, '=') && !r.is(i + 2, '=')) {
      if (r.id(i + 2) === 'function') {
        local.add(name);
        if (isSingleParam(i + 3) && wrapsIdFunction(i + 6)) aliases.add(name);
      } else {
        const target = skipApp(r, i + 2);
        if (ID_FUNCTIONS.has(r.id(target) ?? '') && !r.is(target + 1, '(')) aliases.add(name);
      }
    }
  }

  // A second pass, because an alias can be defined after a function that uses it. `var idMk =
  // charIDToTypeID('Mk  ')` is how ScriptListener writes every call.
  for (let i = 0; i < r.length; i++) {
    const name = r.id(i);
    if (name === null || !r.is(i + 1, '=') || r.is(i + 2, '=')) continue;
    const id = readIdCall(r, i + 2, aliases);
    if (id !== null) idVars.set(name, id);
  }
  return { aliases, idVars, local };
}

/** The string in `[app.]stringIDToTypeID('x')` or an alias's call, or null for any other shape. */
function readIdCall(r: TokenReader, at: number, aliases: Set<string>): string | null {
  const i = skipApp(r, at);
  if (!aliases.has(r.id(i) ?? '') || !r.is(i + 1, '(') || !r.is(i + 3, ')')) return null;
  return r.str(i + 2);
}

/**
 * The feature names one script uses, each counted once. Never throws on odd input: a script that
 * won't scan is a script we can't read, which is what `unknown` / `dynamic` means. `onUnlisted`
 * hands back the names that became `unknown`, for growing the lists from our own session logs.
 * Telemetry never passes it, so those names go nowhere.
 */
export function scriptFeatures(
  code: unknown,
  onUnlisted?: (name: string, kind: 'dom' | 'action') => void
): FeatureName[] {
  if (typeof code !== 'string') return [];
  if (code.length > MAX_SCRIPT_CHARS) return [unknownOf('dynamic')];

  const r = new TokenReader(tokenize(code));
  const { aliases, idVars, local } = collectDefinitions(r);
  const found = new Map<string, FeatureName>();
  const add = (feature: FeatureName): void => {
    found.set(`${feature.kind}|${feature.name}|${feature.value ?? ''}`, feature);
  };
  const operation = (name: string, list: ReadonlySet<string>, unknown: 'dom' | 'action'): void => {
    const token = list.has(name) ? toFeatureToken(name) : null;
    if (token === null) onUnlisted?.(name, unknown);
    add(token ? { kind: 'script_operation', tool: SCRIPT_TOOL, name: token } : unknownOf(unknown));
  };
  const capability = (name: string): void => {
    add({ kind: 'script_capability', tool: SCRIPT_TOOL, name });
  };

  for (let i = 0; i < r.length; i++) {
    const name = r.id(i);
    if (name === null) {
      // `handlers[kind](doc)`: a call whose target isn't readable.
      if (r.is(i, ']') && r.is(i + 1, '(')) add(unknownOf('dynamic'));
      continue;
    }
    const isCall = r.is(i + 1, '(');
    const isMember = r.is(i - 1, '.');

    if (name === 'executeAction' && isCall) {
      const arg = i + 2;
      const id = readIdCall(r, arg, aliases) ?? idVars.get(r.id(arg) ?? '') ?? null;
      if (id === null) add(unknownOf('dynamic'));
      else operation(id.trim(), ACTION_OPERATIONS, 'action');
      continue;
    }
    if (!isCall) {
      // `File.saveDialog(...)`, `Folder.current`: these classes matter even without `new`.
      if (!isMember && r.is(i + 1, '.') && SCRIPT_CAPABILITIES.has(name)) capability(name);
      continue;
    }
    if (isMember) {
      const owner = r.id(i - 2);
      const qualified = owner !== null ? `${owner}.${name}` : null;
      if (qualified !== null && SCRIPT_CAPABILITIES.has(qualified)) {
        capability(qualified);
        if (qualified === '$.eval') add(unknownOf('dynamic'));
      } else if (!LANGUAGE_METHODS.has(name) && !isPlumbing(name) && !local.has(name)) {
        operation(name, DOM_OPERATIONS, 'dom');
      }
      continue;
    }
    // A bare call or `new X(...)`. Helper functions and language built-ins are neither listed
    // nor unknown, so only the capability names count here.
    if (SCRIPT_CAPABILITIES.has(name) && !local.has(name)) {
      capability(name);
      if (name === 'eval' || name === 'Function') add(unknownOf('dynamic'));
    }
  }
  return [...found.values()];
}

/** Everything one tool call says about features: its option values, and for a script, its names. */
export function callFeatures(
  tool: string,
  inputSchema: unknown,
  args: Record<string, unknown>,
  previous: { tool: string; success: boolean } | null
): FeatureName[] {
  const names = optionValues(tool, inputSchema, args);
  if (tool !== SCRIPT_TOOL) return names;
  names.push(...scriptFeatures(args.code));
  if (previous) {
    names.push({
      kind: 'script_before',
      tool: previous.tool,
      name: previous.success ? 'success' : 'failure',
    });
  }
  return names;
}

type UnknownKind = 'dom' | 'action' | 'dynamic';

function unknownOf(value: UnknownKind): FeatureName {
  return { kind: 'script_operation', tool: SCRIPT_TOOL, name: 'unknown', value };
}
