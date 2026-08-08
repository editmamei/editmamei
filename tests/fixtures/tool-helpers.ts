import type { ToolDefinition, ToolResult } from '@editmamei/core/tool-registry.ts';

/**
 * Build a name-keyed map from an array of tool definitions.
 * Throws on duplicate names to surface registry collisions early.
 */
export function indexTools(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  const map = new Map<string, ToolDefinition>();
  for (const t of tools) {
    if (map.has(t.tool.name)) {
      throw new Error(`Duplicate tool name in factory output: ${t.tool.name}`);
    }
    map.set(t.tool.name, t);
  }
  return map;
}

/** Look up a tool by name and run its handler with the given args. */
export async function callTool(
  tools: ToolDefinition[],
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolResult> {
  const def = indexTools(tools).get(name);
  if (!def) {
    throw new Error(`Tool not registered in factory output: ${name}`);
  }
  return def.handler(args);
}

/** Extract the first text content block from a ToolResult. */
export function textOf(result: ToolResult): string {
  const first = result.content?.[0];
  if (!first || first.type !== 'text') {
    throw new Error(`Expected text content, got: ${JSON.stringify(result)}`);
  }
  return first.text;
}

/**
 * Assert every tool has a non-empty name, description, inputSchema, outputSchema,
 * and annotations.title — the full MCP surface contract from
 * docs/engineering/tool-design.md.
 *
 * This is the single guard that future tool additions inherit. If you add a new
 * tool without an outputSchema or title annotation, the matching factory's
 * "returns N well-formed tools" test will fail loudly.
 */
export function assertToolShape(tools: ToolDefinition[]): void {
  for (const t of tools) {
    if (!t.tool.name) throw new Error('tool.name missing');
    if (!t.tool.description) throw new Error(`${t.tool.name}: description missing`);
    if (!t.tool.inputSchema || t.tool.inputSchema.type !== 'object') {
      throw new Error(`${t.tool.name}: inputSchema must be type:'object'`);
    }
    if (typeof t.handler !== 'function') {
      throw new Error(`${t.tool.name}: handler is not a function`);
    }
    // MCP surface conventions (2026-05-27): every tool declares its output
    // shape and a human-readable title so clients can render and validate.
    const tool = t.tool as { outputSchema?: { type?: string }; annotations?: { title?: string } };
    if (!tool.outputSchema || tool.outputSchema.type !== 'object') {
      throw new Error(`${t.tool.name}: outputSchema must be declared as type:'object'`);
    }
    if (!tool.annotations || !tool.annotations.title) {
      throw new Error(`${t.tool.name}: annotations.title missing`);
    }
  }
}
