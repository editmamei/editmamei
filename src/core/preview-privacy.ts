import type { ToolResult } from './tool-registry.js';

/**
 * `privacy.send_previews_to_llm`, enforced where every tool result leaves the server
 * (`EditmameiServer.handleToolCall`) rather than inside each tool, so a tool added later can't
 * forget it. The GIMP preview tools also check the setting themselves; this is a no-op for them.
 */

/** True when the result carries at least one image block. */
export function hasImageContent(result: ToolResult): boolean {
  return (result.content ?? []).some((c) => c.type === 'image');
}

/**
 * The result with every image block removed and one text note saying so. Text blocks and
 * structuredContent are kept: they carry numbers and file names, never pixels. Returns the
 * result unchanged when it has no image.
 */
export function withholdImages(result: ToolResult): ToolResult {
  const content = result.content ?? [];
  const kept = content.filter((c) => c.type !== 'image');
  const withheld = content.length - kept.length;
  if (withheld === 0) return result;
  return {
    ...result,
    content: [
      ...kept,
      {
        type: 'text' as const,
        text:
          `privacy.send_previews_to_llm is false, so ${withheld} image(s) were not sent to ` +
          'the model. Change it with: editmamei config set privacy.send_previews_to_llm true',
      },
    ],
  };
}
