import { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../utils/logger.js';

/** Runs one tool call. Owns its own input validation and error shaping. */
export interface ToolHandler {
  (args: Record<string, unknown>): Promise<CallToolResult>;
}

export type ToolResult = CallToolResult;

/** A tool's advertised schema paired with the handler that answers for it. */
export interface ToolDefinition {
  tool: Tool;
  handler: ToolHandler;
}

/**
 * Side-channel notification fired after every successful or failed dispatch.
 * Used by the session-log telemetry — fire-and-forget; the registry awaits
 * the callback but never propagates its errors to the tool-call path.
 *
 * `result` carries the full handler return value (or `undefined` when the
 * handler threw). Session-log uses it to compute `result_bytes` and hoist
 * context scalars from `structuredContent`.
 */
export interface ToolCallObserver {
  (entry: {
    tool: string;
    args: Record<string, unknown>;
    success: boolean;
    duration_ms: number;
    error?: string;
    result?: ToolResult;
  }): void | Promise<void>;
}

export class ToolRegistry {
  private logger: Logger;
  private tools: Map<string, ToolDefinition>;
  private onCall?: ToolCallObserver;

  constructor(options: { onCall?: ToolCallObserver } = {}) {
    this.logger = new Logger('ToolRegistry');
    this.tools = new Map();
    this.onCall = options.onCall;
  }

  register(name: string, definition: ToolDefinition): void {
    if (this.tools.has(name)) {
      // Last registration wins. Warned rather than refused because a module
      // deliberately superseding a built-in is legitimate, but doing it by
      // accident is a name collision worth seeing in the log.
      this.logger.warn(`Replacing an already-registered tool: ${name}`);
    }
    this.tools.set(name, definition);
    this.logger.debug(`Registered ${name}`);
  }

  registerAll(definitions: ToolDefinition[]): void {
    for (const def of definitions) {
      this.register(def.tool.name, def);
    }
  }

  /**
   * Shallow copy of the current registry (name → definition). Paired with
   * `restore()` to ROLL BACK a downloaded module whose tools failed the post-load
   * classification assertion. Snapshots DEFINITIONS, not just names: `register`
   * overwrites on a name collision, so a stale module that re-registers a CE tool
   * name would otherwise leave ITS handler live under the CE name after a
   * name-only rollback. Restoring the captured definitions puts the exact
   * pre-load CE handlers back. Not part of normal tool flow.
   */
  snapshot(): Map<string, ToolDefinition> {
    return new Map(this.tools);
  }

  /** Replace the registry contents with a prior `snapshot()`. See `snapshot()`. */
  restore(snap: Map<string, ToolDefinition>): void {
    this.tools = new Map(snap);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values()).map((def) => def.tool);
  }

  /**
   * Look up a tool and invoke its handler.
   *
   * Only throws when the name itself is unknown. Handlers own their own
   * validation and report failure as an error-flagged result, and exceptions
   * that do escape are handled a level up — catching them here as well meant
   * every failure was logged twice.
   *
   * An `onCall` observer, if one was supplied, fires once after the handler
   * settles either way. Its errors are logged and swallowed: observation must
   * never be able to fail a tool call.
   */
  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const definition = this.tools.get(name);
    if (!definition) {
      throw new Error(`No tool is registered under the name '${name}'`);
    }
    this.logger.debug(`Dispatching ${name}`);

    const started = Date.now();
    let success = true;
    let error: string | undefined;
    let result: ToolResult | undefined;
    try {
      result = await definition.handler(args);
      // Handlers signal failure via { isError: true } rather than throwing.
      if (result?.isError) {
        success = false;
        const firstText = result.content?.find((c) => c.type === 'text');
        if (firstText && 'text' in firstText) error = String(firstText.text);
      }
      return result;
    } catch (err) {
      success = false;
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      if (this.onCall) {
        const duration_ms = Date.now() - started;
        try {
          // Fire-and-forget — don't await failures from the observer.
          Promise.resolve(
            this.onCall({ tool: name, args, success, duration_ms, error, result })
          ).catch((e) => this.logger.warn(`onCall observer failed: ${e}`));
        } catch (e) {
          this.logger.warn(`onCall observer threw synchronously: ${e}`);
        }
      }
    }
  }

  count(): number {
    return this.tools.size;
  }
}
