import type { Tool, CallToolResult } from '@modelcontextprotocol/server';
import { Logger } from '../utils/logger.js';
import { getToolTimeoutMs } from '../utils/operation-timeouts.js';
import { budgetContextFor, runWithToolBudget } from '../utils/tool-budget-context.js';
import { missingRequiredArg } from '../utils/validate.js';

/** A JSON Schema for an object, as the engine writes one (validate.ts's JsonSchemaObject is one). */
export interface ObjectSchema {
  [k: string]: unknown;
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
}

/**
 * A tool as the engine declares it: the protocol's Tool, with its schemas typed the way the
 * engine writes them. The SDK types a schema as a JSON value, which the engine's interface-typed
 * schemas (readonly enums, `unknown` defaults) don't match structurally, though they serialize
 * to exactly that; `list()` hands them over as the protocol's type.
 */
export type ToolSpec = NamedFieldsWithout<Tool, 'inputSchema' | 'outputSchema'> & {
  inputSchema: ObjectSchema;
  outputSchema?: ObjectSchema;
};

/**
 * `Omit` for the SDK's schema-inferred types: they carry a string index signature, which a plain
 * `Omit` turns every named field into. This keeps the named fields and drops the signature.
 */
type NamedFieldsWithout<T, K extends PropertyKey> = {
  [P in keyof T as string extends P ? never : P extends K ? never : P]: T[P];
};

/**
 * A tool call's result: the protocol's, with an object `structuredContent`. Every engine tool
 * returns one; the 2026-07-28 revision also allows other values there, which the engine never sends.
 */
export type ToolResult = CallToolResult & { structuredContent?: Record<string, unknown> };

/** Runs one tool call. Owns its own input validation and error shaping. */
export interface ToolHandler {
  (args: Record<string, unknown>): Promise<ToolResult>;
}

/** A tool's advertised schema paired with the handler that answers for it. */
export interface ToolDefinition {
  tool: ToolSpec;
  handler: ToolHandler;
  /**
   * This call's budget in ms, shared by every script it runs. Takes precedence
   * over the budget table, for a tool that doesn't have an entry there.
   */
  budgetMs?: number;
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

  /**
   * Remove a single tool by name. Exists for the module-load forward-compat
   * per-tool degrade (a newer module's tool this host doesn't recognize yet
   * gets dropped on its own, rather than rolling back the whole module) — not
   * part of normal tool flow.
   */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** The tools as the protocol lists them (see ToolSpec for why the schemas need the cast). */
  list(): Tool[] {
    return Array.from(this.tools.values()).map((def) => def.tool as Tool);
  }

  /**
   * Look up a tool and invoke its handler.
   *
   * Only throws when the name itself is unknown. A call missing a `required`
   * argument is refused here, so no handler runs without one. Handlers own the
   * rest of their validation and report failure as an error-flagged result, and exceptions
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
      const missing = missingRequiredArg(definition.tool.inputSchema, args);
      // Every script the handler runs — however many — is bounded by this
      // call's deadline, computed once here. A nested Kernel.invokeTool call
      // re-enters this same method while still inside the outer context, so
      // budgetContextFor caps the inner deadline at the outer's remaining
      // time automatically — see its doc comment. Read side: run-script.ts.
      result = missing
        ? {
            content: [{ type: 'text', text: `Missing required argument: ${missing}` }],
            isError: true,
          }
        : await runWithToolBudget(
            budgetContextFor(name, getToolTimeoutMs(name, definition.budgetMs)),
            () => definition.handler(args)
          );
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
