/**
 * `editmamei report` — write an anonymized diagnostic bundle to Downloads.
 *
 * The terminal equivalent of the `ps_report_problem` MCP tool, for users
 * on the npm/CLI install path (the .mcpb / Claude Desktop path uses the tool).
 * Because this runs as a short-lived CLI process, its own in-memory log ring
 * buffer is nearly empty — the value here is the system info, recent session
 * summaries, and the Claude Desktop log tail. Same content-free bundle either way.
 */

import { collectDiagnostics, writeDiagnosticBundle, ISSUES_URL } from '../diagnostics/collect.js';

export interface ReportOptions {
  /** Optional problem description embedded (sanitized) in the bundle. */
  note?: string;
  /** stdout sink. Test hook; defaults to `process.stdout.write`. */
  stdout?: (s: string) => void;
  /** Collector/writer seam (tests pass fakes); defaults to the real ones. */
  collect?: typeof collectDiagnostics;
  write?: typeof writeDiagnosticBundle;
}

export async function runReport(opts: ReportOptions = {}): Promise<void> {
  const out = opts.stdout ?? ((s) => process.stdout.write(s));
  const collect = opts.collect ?? collectDiagnostics;
  const write = opts.write ?? writeDiagnosticBundle;
  const bundle = await collect({ note: opts.note });
  const { path } = await write(bundle);
  out(`\n  Wrote an anonymized diagnostic bundle to:\n    ${path}\n\n`);
  out(
    `  It contains recent logs + system info — no images, no full file paths, no tool arguments.\n`
  );
  out(`  Attach this file to a new issue at ${ISSUES_URL} so the maintainers can debug.\n\n`);
}
