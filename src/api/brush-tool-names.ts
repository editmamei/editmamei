/**
 * Brush tool-name configuration — kept OUT of the sealed snippet tree
 * (`src/api/extendscript/*`) because it's shipped config, not snippet IP:
 * `brush-tools.ts` needs `SUPPORTED_BRUSH_TOOLS` for its input-schema enum,
 * and the Go core carries its own copy of the ToolType mapping. Lives here
 * so the Go-sidecar seal can exclude the extendscript category files from the
 * shipped bundle without dropping this map.
 *
 * Maps the schema's lowercase-snake tool names to the ExtendScript
 * `ToolType.<UPPERCASE>` constant name. Subset is the 16 PS 27.x-accepted
 * constants confirmed via live testing.
 */
export const TOOL_NAMES: Record<string, string> = {
  // Headline retouch surface (7).
  healing_brush: 'HEALINGBRUSH',
  clone_stamp: 'CLONESTAMP',
  burn: 'BURN',
  dodge: 'DODGE',
  blur: 'BLUR',
  sharpen: 'SHARPEN',
  smudge: 'SMUDGE',
  // Bonus paint/erase/special surface (9).
  brush: 'BRUSH',
  pencil: 'PENCIL',
  eraser: 'ERASER',
  pattern_stamp: 'PATTERNSTAMP',
  art_history_brush: 'ARTHISTORYBRUSH',
  history_brush: 'HISTORYBRUSH',
  color_replacement: 'COLORREPLACEMENTTOOL',
  background_eraser: 'BACKGROUNDERASER',
  sponge: 'SPONGE',
};

export const SUPPORTED_BRUSH_TOOLS = Object.keys(TOOL_NAMES);
