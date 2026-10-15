/**
 * Text renderings of GIMP bridge results that are otherwise only in `structuredContent`.
 *
 * Some MCP clients show the model a tool's text content and nothing else, so a listing
 * whose text is just a count leaves the model without the ids and values it needs for the
 * next call. These helpers put the key fields into the text, with caps so a large stack or
 * layer tree stays readable. `structuredContent` still carries the full result.
 */

/** Lines a listing shows before summarising the rest as "...and N more". */
export const MAX_LISTED_LINES = 60;
/** Characters of one filter's settings shown before the rest is cut. */
export const MAX_PARAMS_CHARS = 240;
/** Characters of one name shown before the rest is cut. */
export const MAX_NAME_CHARS = 120;
/** Channels a channel list names before summarising the rest. */
export const MAX_LISTED_CHANNELS = 30;

/** A user-supplied name, quoted so quotes, newlines and control characters can't break the line. */
export function quoted(name: unknown): string {
  const s = String(name ?? '');
  return JSON.stringify(s.length > MAX_NAME_CHARS ? `${s.slice(0, MAX_NAME_CHARS)}...` : s);
}

/**
 * A string shown bare when it is a plain token (`cyan`, `gegl:curves`), quoted otherwise —
 * setting keys and values can come from an image file, so they get the same protection as names.
 */
function token(s: string): string {
  return /^[\w.:#+-]+$/.test(s) ? s : quoted(s);
}

function valueText(v: unknown): string {
  if (typeof v === 'number') return String(Number.isInteger(v) ? v : Number(v.toFixed(3)));
  if (typeof v === 'string') return token(v);
  if (typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** `k=v` pairs for a filter's settings, nulls and the mask left out, cut at `cap` characters. */
export function paramsText(params: unknown, cap = MAX_PARAMS_CHARS): string {
  if (!params || typeof params !== 'object') return '';
  const text = Object.entries(params as Record<string, unknown>)
    .filter(([k, v]) => v !== null && v !== undefined && k !== 'mask')
    .map(([k, v]) => `${token(k)}=${valueText(v)}`)
    .join(' ');
  return text.length > cap ? `${text.slice(0, cap)}...` : text;
}

/** The lines, capped, with a count of the ones left out. */
export function capLines(lines: string[], max = MAX_LISTED_LINES): string[] {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `...and ${lines.length - max} more`];
}

interface FilterRecord {
  layer?: unknown;
  layer_id?: unknown;
  filter_id?: unknown;
  name?: unknown;
  operation?: unknown;
  type?: unknown;
  visible?: unknown;
  source?: unknown;
  mask?: unknown;
  params?: unknown;
}

/** One filter on one line: id, name, type, layer, visibility, mask, source and settings. */
export function filterLine(f: FilterRecord): string {
  const kind = token(typeof f.type === 'string' && f.type ? f.type : String(f.operation ?? ''));
  const hidden = f.visible === false ? ', hidden' : '';
  const mask = f.mask ? `, mask ${quoted(f.mask)}` : '';
  const source = String(f.source ?? 'unknown');
  // Readback settings are GIMP's own property names and units, not gimp_add_adjustment fields.
  const sourceText = source === 'readback' ? 'readback (GEGL names and units)' : token(source);
  const params = paramsText(f.params);
  return (
    `#${String(f.filter_id)} ${quoted(f.name)} ${kind} on layer ${quoted(f.layer)} ` +
    `(id ${String(f.layer_id)})${hidden}${mask}, ${sourceText}` +
    (params ? `: ${params}` : '')
  );
}

interface LayerNode {
  layer_id?: unknown;
  name?: unknown;
  opacity?: unknown;
  mode?: unknown;
  visible?: unknown;
  is_group?: unknown;
  is_text_layer?: unknown;
  children?: unknown;
}

function layerFlags(n: LayerNode): string {
  const flags: string[] = [];
  if (n.is_group) flags.push('group');
  if (n.is_text_layer) flags.push('text');
  if (n.visible === false) flags.push('hidden');
  if (typeof n.opacity === 'number' && n.opacity < 100)
    flags.push(`opacity ${valueText(n.opacity)}`);
  if (typeof n.mode === 'string' && !n.mode.startsWith('normal'))
    flags.push(`mode ${token(n.mode)}`);
  return flags.length ? `, ${flags.join(', ')}` : '';
}

/** The layer tree, top of stack first, children indented under their group. */
export function layerTreeLines(nodes: unknown): string[] {
  const lines: string[] = [];
  const stack: Array<{ node: LayerNode; depth: number }> = [];
  const push = (list: unknown, depth: number): void => {
    if (!Array.isArray(list)) return;
    for (let i = list.length - 1; i >= 0; i--) stack.push({ node: list[i] as LayerNode, depth });
  };
  push(nodes, 0);
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    lines.push(
      `${'  '.repeat(depth)}- ${quoted(node.name)} (id ${String(node.layer_id)}${layerFlags(node)})`
    );
    push(node.children, depth + 1);
  }
  return lines;
}

interface ChannelRecord {
  name?: unknown;
  fraction?: unknown;
}

/** Channel names, with each one's coverage when the result carries it. */
export function channelsText(channels: unknown): string {
  if (!Array.isArray(channels) || channels.length === 0) return '(none)';
  const named = (channels as ChannelRecord[])
    .slice(0, MAX_LISTED_CHANNELS)
    .map((c) =>
      typeof c.fraction === 'number'
        ? `${quoted(c.name)} (${(c.fraction * 100).toFixed(1)}% selected)`
        : quoted(c.name)
    )
    .join(', ');
  const rest = channels.length - MAX_LISTED_CHANNELS;
  return rest > 0 ? `${named}, ...and ${rest} more` : named;
}

interface ChannelStats {
  mean?: unknown;
  median?: unknown;
  p5?: unknown;
  p95?: unknown;
}

function statsText(s: ChannelStats | undefined): string {
  if (!s) return 'n/a';
  return (
    `mean=${valueText(s.mean)} median=${valueText(s.median)} ` +
    `p5=${valueText(s.p5)} p95=${valueText(s.p95)}`
  );
}

/** One line per channel: each region's stats, then the difference in means (B minus A). */
export function regionStatsLines(
  a: Record<string, ChannelStats> | undefined,
  b: Record<string, ChannelStats> | undefined
): string[] {
  const channels = Object.keys(a ?? {});
  return channels.map((ch) => {
    const sa = a?.[ch];
    const sb = b?.[ch];
    const delta =
      typeof sa?.mean === 'number' && typeof sb?.mean === 'number' ? sb.mean - sa.mean : undefined;
    const deltaText =
      delta === undefined ? '' : `; B-A mean ${delta >= 0 ? '+' : ''}${valueText(delta)}`;
    return `${ch}: A ${statsText(sa)} | B ${statsText(sb)}${deltaText}`;
  });
}
