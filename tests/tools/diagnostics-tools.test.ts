import { describe, it, expect, vi } from 'vitest';
import { createDiagnosticsTools } from '@editmamei/tools/diagnostics-tools.ts';
import type { DiagnosticBundle } from '@editmamei/diagnostics/collect.ts';
import { makeConnection } from '../fixtures/fake-connection.ts';
import { makeSnippetClient } from '../fixtures/fake-snippet-client.ts';
import { assertToolShape } from '../fixtures/tool-helpers.ts';

function fakeBundle(over: Partial<DiagnosticBundle> = {}): DiagnosticBundle {
  return {
    schema: 1,
    report_id: 'rid123',
    editmamei_version: '0.20.0',
    edition: 'community',
    platform: 'darwin',
    os_release: '24.0.0',
    arch: 'arm64',
    node_version: 'v20.0.0',
    install_id: 'a'.repeat(32),
    ps_version: '27.7.0',
    mcp_client: 'claude-ai 0.1.0',
    settings: {
      telemetry_usage: true,
      telemetry_diagnostics: false,
      update_check: true,
      send_previews_to_llm: true,
    },
    note: null,
    server_log: ['line-1', 'line-2'],
    desktop_log: ['d-1'],
    desktop_log_source: 'mcp.log',
    recent_sessions: [
      {
        session_id: 's1',
        editmamei_version: '0.20.0',
        ps_version: '27.7.0',
        mcp_client: 'claude-ai 0.1.0',
        call_count: 1,
        calls: [
          {
            seq: 1,
            ts: 't',
            tool: 'ps_ping',
            success: true,
            duration_ms: 1,
            error_class: null,
          },
        ],
      },
    ],
    ...over,
  };
}

describe('createDiagnosticsTools', () => {
  it('returns one well-formed ps_report_problem tool', () => {
    const conn = makeConnection();
    const tools = createDiagnosticsTools(conn.asConnection(), makeSnippetClient());
    assertToolShape(tools);
    expect(tools).toHaveLength(1);
    const def = tools[0];
    expect(def.tool.name).toBe('ps_report_problem');
    // Writes a file → not read-only, touches the filesystem (open world).
    expect(def.tool.annotations?.readOnlyHint).toBe(false);
    expect(def.tool.annotations?.openWorldHint).toBe(true);
    // Description states the privacy posture so the LLM relays it accurately.
    expect(def.tool.description).toMatch(/no tool arguments/i);
    expect(def.tool.description).toMatch(/anonymized/i);
  });

  it('collects + writes a bundle and reports the path + content-free counts', async () => {
    const conn = makeConnection();
    const collect = vi.fn(async () => fakeBundle());
    const write = vi.fn(async () => ({
      path: '/dl/editmamei-diagnostics-rid123.json',
      bytes: 4096,
    }));
    const tools = createDiagnosticsTools(conn.asConnection(), makeSnippetClient(), {
      collect,
      write,
    });

    const res = await tools[0].handler({ note: 'it broke on launch' });

    expect(collect).toHaveBeenCalledWith({ note: 'it broke on launch' });
    expect(write).toHaveBeenCalledOnce();
    expect(res.structuredContent).toMatchObject({
      path: '/dl/editmamei-diagnostics-rid123.json',
      bytes: 4096,
      server_log_lines: 2,
      recent_session_count: 1,
      desktop_log_included: true,
      issues_url: expect.stringContaining('github.com'),
    });
    // Human text surfaces the path + where to file it.
    const text = (res.content?.[0] as { text: string }).text;
    expect(text).toContain('/dl/editmamei-diagnostics-rid123.json');
    expect(text).toContain('github.com');
    // The tool must not touch Photoshop.
    expect(conn.executions.length).toBe(0);
  });

  it('omits the note when none is supplied', async () => {
    const conn = makeConnection();
    const collect = vi.fn(async () => fakeBundle());
    const write = vi.fn(async () => ({ path: '/dl/x.json', bytes: 1 }));
    const tools = createDiagnosticsTools(conn.asConnection(), makeSnippetClient(), {
      collect,
      write,
    });
    await tools[0].handler({});
    expect(collect).toHaveBeenCalledWith({ note: undefined });
  });
});
