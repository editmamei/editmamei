import type { ToolResult } from './tool-registry.js';

/**
 * `privacy.send_previews_to_llm`, enforced where every tool result leaves the server
 * (`EditmameiServer.handleToolCall`) rather than inside each tool, so a tool added later can't
 * forget it. The GIMP preview tools also check the setting themselves; this is a no-op for them.
 *
 * Image blocks are removed wherever they sit, not only in the top-level `content`: a tool that
 * wraps another tool's result (ps_sequence keeps its last step's result in structuredContent)
 * carries that result's image blocks nested inside it.
 */

/** An MCP content block that carries image bytes: an `image` block, or an embedded `resource`
 * whose blob is an image. */
function isImageBlock(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const block = value as {
    type?: unknown;
    data?: unknown;
    mimeType?: unknown;
    resource?: { mimeType?: unknown; blob?: unknown };
  };
  // data + mimeType, not `type` alone: plain output objects can carry type: 'image' (a layer
  // kind, say) and must not be dropped.
  if (block.type === 'image') {
    return typeof block.data === 'string' && typeof block.mimeType === 'string';
  }
  return (
    block.type === 'resource' &&
    typeof block.resource?.blob === 'string' &&
    typeof block.resource.mimeType === 'string' &&
    block.resource.mimeType.startsWith('image/')
  );
}

/** A copy of `value` with every image block removed from every array, at any depth. */
function strip(value: unknown, counter: { n: number }): unknown {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      if (isImageBlock(item)) counter.n++;
      else out.push(strip(item, counter));
    }
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = strip(v, counter);
    return out;
  }
  return value;
}

/** True when the result carries an image block anywhere, including nested results. */
export function hasImageContent(result: ToolResult): boolean {
  const counter = { n: 0 };
  strip(result, counter);
  return counter.n > 0;
}

/**
 * The result with every image block removed (content and structuredContent, at any depth) and
 * one text note saying so. Text and numbers are kept. Returns the result unchanged when it has
 * no image. The note deliberately doesn't say how to turn the setting back on: that is the
 * user's choice, not the model's.
 */
export function withholdImages(result: ToolResult): ToolResult {
  const counter = { n: 0 };
  const stripped = strip(result, counter) as ToolResult;
  if (counter.n === 0) return result;
  const what = counter.n === 1 ? 'An image was' : `${counter.n} images were`;
  return {
    ...stripped,
    content: [
      ...(stripped.content ?? []),
      {
        type: 'text' as const,
        text:
          `${what} withheld because the user's privacy.send_previews_to_llm setting is off. ` +
          'Work from the text and numbers; ask the user if you need to see the image.',
      },
    ],
  };
}
