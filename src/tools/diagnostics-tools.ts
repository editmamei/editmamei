import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { collectDiagnostics, writeDiagnosticBundle, ISSUES_URL } from '../diagnostics/collect.js';

/**
 * ps_report_problem — collect an anonymized diagnostic bundle and write it
 * to the user's Downloads folder so they can attach it to a bug report.
 *
 * Meta/diagnostic tool: it does NOT touch Photoshop. The factory signature is the
 * fixed `(connection, snippetClient)` every CE factory takes (both unused here,
 * mirroring `createOverviewTools`). The bundle's privacy contract lives in
 * `src/diagnostics/collect.ts` — content-free, no args, no image data.
 */

const reportSchema = {
  type: 'object' as const,
  properties: {
    note: {
      type: 'string',
      description:
        'Optional short description of the problem (what went wrong, what you were doing). Embedded verbatim after sanitization. No file contents or paths needed.',
    },
  },
};

/** Injectable collector/writer seam — production uses the real ones; tests pass fakes. */
export interface DiagnosticsToolDeps {
  collect?: typeof collectDiagnostics;
  write?: typeof writeDiagnosticBundle;
}

export function createDiagnosticsTools(
  _connection: PhotoshopConnection,
  _snippetClient: SnippetClient,
  deps: DiagnosticsToolDeps = {}
): ToolDefinition[] {
  const collect = deps.collect ?? collectDiagnostics;
  const writeBundle = deps.write ?? writeDiagnosticBundle;
  return [
    {
      tool: {
        name: 'ps_report_problem',
        description:
          "Collect an ANONYMIZED diagnostic bundle and write it to the user's Downloads folder so they can attach it to a bug report — use when Editmamei misbehaves (won't connect, a tool keeps failing, unexpected results). The bundle holds recent server logs, system info (Editmamei/OS/Photoshop versions), and a content-free summary of recent tool calls (name, success, duration, error class). It contains NO image content, NO tool arguments, and file paths reduced to basenames. Does not touch Photoshop; writes one JSON file. After calling, tell the user the file path and that they can attach it to a new issue at " +
          ISSUES_URL +
          '.',
        inputSchema: reportSchema,
        outputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            bytes: { type: 'number' },
            server_log_lines: { type: 'number' },
            recent_session_count: { type: 'number' },
            desktop_log_included: { type: 'boolean' },
            issues_url: { type: 'string' },
          },
        },
        annotations: {
          title: 'Report a problem',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      handler: async (args: Record<string, unknown>): Promise<ToolResult> => {
        const note = typeof args.note === 'string' ? args.note : undefined;
        const bundle = await collect({ note });
        const { path, bytes } = await writeBundle(bundle);
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Wrote an anonymized diagnostic bundle to:\n  ${path}\n\n` +
                `It contains recent logs + system info — no images, no full file paths, no tool arguments. ` +
                `Attach this file to a new issue at ${ISSUES_URL} so the maintainers can debug.`,
            },
          ],
          structuredContent: {
            path,
            bytes,
            server_log_lines: bundle.server_log.length,
            recent_session_count: bundle.recent_sessions.length,
            desktop_log_included: bundle.desktop_log.length > 0,
            issues_url: ISSUES_URL,
          },
        };
      },
    },
  ];
}
