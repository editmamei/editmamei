/**
 * MCP Apps panels: HTML pages a host draws in the chat next to a tool's result
 * (the MCP Apps extension, `io.modelcontextprotocol/ui`). A module registers a
 * page under a `ui://` URI through `HostApi.registerPanels`, and a tool links to
 * it with `_meta.ui.resourceUri`.
 *
 * A panel is served only while a registered tool links to it, so the tool
 * registry stays the single source of truth: a module rollback that restores the
 * registry takes its panels with it, and a host with no linked panel announces no
 * resources at all.
 */

import type { Tool } from '@modelcontextprotocol/server';

/** The MCP Apps HTML profile. */
export const PANEL_MIME = 'text/html;profile=mcp-app';

/** The MCP Apps extension, announced in the server's `capabilities.extensions`. */
export const MCP_APPS_EXTENSION = 'io.modelcontextprotocol/ui';

/** Longest page the registry accepts, in characters. */
const MAX_HTML = 4_000_000;

const URI_SHAPE = /^ui:\/\/[a-z0-9][a-z0-9.-]{0,62}\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const NAME_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;

/** One page a module serves. */
export interface PanelDefinition {
  /** `ui://<host>/<file>`, the value a tool's `_meta.ui.resourceUri` names. */
  uri: string;
  /** Resource name, e.g. `markup-panel`. */
  name: string;
  /** Human-readable title. */
  title: string;
  /** The whole page. Self-contained: the host's default sandbox allows no network. */
  html: string;
}

/** A panel's `resources/list` entry. */
export type PanelResource = {
  uri: string;
  name: string;
  title: string;
  mimeType: string;
};

/** A panel's `resources/read` result. */
export type PanelRead = {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
};

/** The `ui://` URI a tool links to, or undefined. Reads both the nested and the flat key. */
export function linkedPanelUri(tool: Pick<Tool, '_meta'>): string | undefined {
  const meta = tool._meta as Record<string, unknown> | undefined;
  if (!meta) return undefined;
  const ui = meta.ui as { resourceUri?: unknown } | undefined;
  const nested = ui && typeof ui === 'object' ? ui.resourceUri : undefined;
  const value = nested ?? meta['ui/resourceUri'];
  return typeof value === 'string' ? value : undefined;
}

export class PanelRegistry {
  private readonly panels = new Map<string, PanelDefinition>();

  /** Add pages. Throws on a malformed or duplicate URI, so a module's mistake fails its own load. */
  register(defs: readonly PanelDefinition[]): void {
    const batch = new Set<string>();
    for (const def of defs) {
      if (!URI_SHAPE.test(def.uri))
        throw new Error(`Panel URI is not a ui:// address: ${String(def.uri).slice(0, 200)}`);
      if (!NAME_SHAPE.test(def.name))
        throw new Error(`Panel name is not valid: ${String(def.name).slice(0, 80)}`);
      if (typeof def.title !== 'string' || def.title.length === 0 || def.title.length > 120) {
        throw new Error(`Panel title must be 1 to 120 characters: ${def.uri}`);
      }
      if (typeof def.html !== 'string' || def.html.length === 0 || def.html.length > MAX_HTML) {
        throw new Error(`Panel page must be 1 to ${MAX_HTML} characters: ${def.uri}`);
      }
      if (this.panels.has(def.uri) || batch.has(def.uri)) {
        throw new Error(`Panel already registered: ${def.uri}`);
      }
      batch.add(def.uri);
    }
    for (const def of defs) this.panels.set(def.uri, { ...def });
  }

  /** The panels some tool in `tools` links to, in registration order. */
  linked(tools: readonly Pick<Tool, '_meta'>[]): PanelDefinition[] {
    const named = new Set(
      tools.map(linkedPanelUri).filter((uri): uri is string => uri !== undefined)
    );
    return [...this.panels.values()].filter((p) => named.has(p.uri));
  }

  /** `resources/list` entries for the linked panels. */
  resources(tools: readonly Pick<Tool, '_meta'>[]): PanelResource[] {
    return this.linked(tools).map((p) => ({
      uri: p.uri,
      name: p.name,
      title: p.title,
      mimeType: PANEL_MIME,
    }));
  }

  /** `resources/read` for a linked panel, or null for any other URI. */
  read(uri: string, tools: readonly Pick<Tool, '_meta'>[]): PanelRead | null {
    const panel = this.linked(tools).find((p) => p.uri === uri);
    return panel
      ? { contents: [{ uri: panel.uri, mimeType: PANEL_MIME, text: panel.html }] }
      : null;
  }
}
