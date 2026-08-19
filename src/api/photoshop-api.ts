import { Logger } from '../utils/logger.js';
import { PhotoshopConnection } from '../platform/connection.js';

export interface PhotoshopAPI {
  /**
   * Run a script in Photoshop, wrapped in the standard preamble and postamble.
   *
   * `timeoutMs` raises the platform runner's default budget for this one call —
   * used by handlers that legitimately run long, such as an annotated preview
   * over a deep layer stack.
   */
  executeScript(script: string, timeoutMs?: number): Promise<unknown>;
}

export class PhotoshopAPIFactory {
  private logger: Logger;
  private connection: PhotoshopConnection;

  constructor(connection: PhotoshopConnection) {
    this.logger = new Logger('PhotoshopAPIFactory');
    this.connection = connection;
  }

  async createAPI(): Promise<PhotoshopAPI> {
    // AWAIT detection rather than reading whatever happens to be cached.
    //
    // This is the FIRST gate every runScript call passes, so it — not
    // connection.executeScript — is where a boot race actually surfaces. Boot
    // fires session.initialize() without awaiting it (the boot-ordering
    // invariant), so a tool call arriving in that window used to find
    // getPhotoshopInfo() still null and fail with "Please detect Photoshop
    // first" even though detection completed moments later. Live 2026-07-30:
    // the first ps_ping of a session returned connected:false at 607ms and
    // succeeded on retry; `live-smoke call` failed ~28ms in while detection
    // finished ~670ms later. ensureDetected() is single-flight, so this awaits
    // the in-flight boot probe instead of starting a competing one.
    const info = await this.connection.ensureDetected();

    if (!info) {
      throw new Error(
        'Photoshop info not available — the local install could not be detected. ' +
          'Check that Photoshop is installed (set PHOTOSHOP_PATH to override detection).'
      );
    }

    // There is no branch to take here. External automation can only drive
    // ExtendScript: the alternative in-process scripting runtime is reachable
    // only from a plugin loaded inside Photoshop, never from outside it. The
    // factory shape is kept because it is where detection is awaited, not
    // because there is a choice to make.
    //
    // Debug rather than info: this used to fire at every call site — around a
    // hundred and eighty of them — at the default level, filling the diagnostic
    // ring buffer with a line per script that told a reader nothing.
    this.logger.debug(`Photoshop ${info.version} ready for scripting`);
    return new ExtendScriptPhotoshopAPI(this.connection);
  }
}

/**
 * The one `PhotoshopAPI` implementation: wraps a caller's snippet in the
 * standard preamble and postamble and hands it to the connection.
 */
class ExtendScriptPhotoshopAPI implements PhotoshopAPI {
  private connection: PhotoshopConnection;

  constructor(connection: PhotoshopConnection) {
    this.connection = connection;
  }

  async executeScript(script: string, timeoutMs?: number): Promise<unknown> {
    const wrappedScript = this.wrapInErrorHandling(script);
    try {
      return await this.connection.executeScript(wrappedScript, timeoutMs);
    } catch (err) {
      // Photoshop can fail with no message at all, usually when a previous
      // modal or timeout left it in a bad state. That arrives here as an Error
      // with an empty message, and each tool handler then prefixes its own
      // "Error doing X: " onto nothing — leaving the caller with no idea what
      // went wrong or what to try next. Substituting a real message at this one
      // platform-agnostic chokepoint covers both platforms and every tool,
      // which per-tool guards never did. Deliberately generic: this layer does
      // not know which tool called it.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.trim().length === 0) {
        throw new Error(
          'Photoshop returned an empty error — the script failed with no message. ' +
            'This usually means PS is in a stuck/modal state (a leaked preview duplicate ' +
            'or a pending dialog from a prior timeout), or there is no active document. ' +
            'Check that a document is open and try once more; if it persists, dismiss any ' +
            'open Photoshop dialog.',
          { cause: err }
        );
      }
      throw err instanceof Error ? err : new Error(msg);
    }
  }

  private wrapInErrorHandling(script: string): string {
    // Photoshop's scripting runtime predates JSON and has no encoder of its
    // own, so the postamble carries a small one. Encoding in-script is what
    // lets every handler receive a real object in `structuredContent` instead
    // of parsing a stringified source representation on this side. Failures
    // leave through the marker line that `decodeScriptResult` turns back into
    // a thrown error.
    //
    // Return-value capture supports three patterns:
    //   1. Top-level `return X;` inside the script body (preferred for
    //      go-core-emitted snippets).
    //   2. Side-channel: setting `$.__mcp__ = value;` anywhere in the script,
    //      including from inside nested IIFEs. The wrapper reads and clears it.
    //   3. The executeCustomScript snippet auto-wraps bare IIFE expressions
    //      with `return ...;` so `(function(){...; return X;})();` also works.
    //
    // Ruler and type units are temporarily forced to pixels/points so that
    // every DOM API that accepts plain numbers (translate, textItem.size,
    // textItem.position, doc.crop bounds, etc.) behaves consistently
    // regardless of the user's Photoshop preferences. The user's original
    // preferences are restored in the finally block.
    //
    // displayDialogs is forced to DialogModes.NO for the duration (Layer A of
    // the transport-resilience design). It suppresses the script-command
    // dialogs PS would otherwise raise — chiefly missing-font and ICC
    // color-profile-mismatch prompts — each of which blocks the synchronous
    // COM/AppleScript call until a human dismisses it, which the MCP client
    // can only see as a dropped connection.
    // It does NOT suppress app/OS-level modals (linked-asset, "disk changed",
    // license, GPU, rasterize warnings); those are Layer B's job. Restored in
    // finally so the user's interactive PS session is unchanged.
    return `
(function() {
  var __originalRulerUnits = null;
  var __originalTypeUnits = null;
  var __originalDisplayDialogs = null;
  try { __originalRulerUnits = app.preferences.rulerUnits; } catch (e) {}
  try { __originalTypeUnits = app.preferences.typeUnits; } catch (e) {}
  try { __originalDisplayDialogs = app.displayDialogs; } catch (e) {}

  try { $.__mcp__ = undefined; } catch (e) {}

  // In-script JSON encoder. ExtendScript Photoshop has no JSON object, so
  // we walk the result tree ourselves. Handles strings (with escape),
  // numbers, booleans, null/undefined, arrays, and plain objects. Cycles
  // and very deep nesting are capped via __depth to avoid stack overflow
  // on pathological inputs.
  //
  // Everything outside printable ASCII is escaped as a JSON u-escape, not
  // just the control range. The Windows cscript stdout transport is
  // codepage-bound and flattens raw non-ASCII to '?' (measured live,
  // PS 27.2.0), so a layer Photoshop named itself — 'Farbfuellung 1' spelled
  // with the u-umlaut, on a German install — used to reach the caller as
  // 'Farbf?llung 1'. Naming that layer back at us then missed, because '?'
  // is not what the layer is called. The escape is valid JSON, survives the
  // transport, and JSON.parse restores the exact character, so the round trip
  // is lossless rather than merely legible. Every outcome the script itself
  // produces routes through here, errors included, so this covers messages as
  // well as values. It does NOT cover the Windows shim's own COM failures
  // (windows-runner.ts echoes Err.Description straight to stdout), nor raw
  // non-ASCII sitting in a snippet's own source text — that arrives by a
  // different path and is not addressed here.
  function __mcpJsonEncode(v, __depth) {
    if (__depth === undefined) __depth = 0;
    if (__depth > 32) return '"<<truncated:max-depth>>"';
    if (v === null || v === undefined) return 'null';
    var t = typeof v;
    if (t === 'string') {
      var s = '';
      for (var i = 0; i < v.length; i++) {
        var c = v.charAt(i);
        var cc = v.charCodeAt(i);
        if (c === '\\\\') s += '\\\\\\\\';
        else if (c === '"') s += '\\\\"';
        else if (c === '\\n') s += '\\\\n';
        else if (c === '\\r') s += '\\\\r';
        else if (c === '\\t') s += '\\\\t';
        else if (c === '\\b') s += '\\\\b';
        else if (c === '\\f') s += '\\\\f';
        else if (cc < 32 || cc > 126) {
          var hex = cc.toString(16);
          while (hex.length < 4) hex = '0' + hex;
          s += '\\\\u' + hex;
        }
        else s += c;
      }
      return '"' + s + '"';
    }
    if (t === 'number') return (isFinite(v) ? String(v) : 'null');
    if (t === 'boolean') return v ? 'true' : 'false';
    if (v instanceof Array) {
      var arr = [];
      for (var j = 0; j < v.length; j++) arr.push(__mcpJsonEncode(v[j], __depth + 1));
      return '[' + arr.join(',') + ']';
    }
    // Plain object — enumerate own properties.
    var parts = [];
    for (var k in v) {
      try {
        if (v.hasOwnProperty(k)) {
          parts.push(__mcpJsonEncode(String(k), __depth + 1) + ':' + __mcpJsonEncode(v[k], __depth + 1));
        }
      } catch (e) {
        // skip property that throws on access
      }
    }
    return '{' + parts.join(',') + '}';
  }

  try {
    try { app.preferences.rulerUnits = Units.PIXELS; } catch (e) {}
    try { app.preferences.typeUnits = TypeUnits.POINTS; } catch (e) {}
    try { app.displayDialogs = DialogModes.NO; } catch (e) {}

    var result = (function() {
      ${script}
    })();

    if (typeof result === 'undefined' || result === null) {
      try {
        if (typeof $.__mcp__ !== 'undefined' && $.__mcp__ !== null) {
          result = $.__mcp__;
          $.__mcp__ = undefined;
        }
      } catch (e) {}
    }

    // Every outcome leaves inside an envelope, so the value a script returned
    // is never confused with how it ended. A script that legitimately returns
    // a string beginning with the failure marker used to come back as a thrown
    // error; inside an envelope it round-trips untouched.
    return __mcpJsonEncode({ __em: 1, ok: true, value: result });
  } catch (error) {
    // Photoshop's error carries more than a message. Passing the number and
    // line through means a failure can be identified rather than string-matched
    // on prose that changes between releases and locales.
    var __message = '';
    try { __message = (error && error.message) ? String(error.message) : String(error); } catch (e) { __message = 'unreadable error'; }
    var __number = null;
    try { if (error && typeof error.number === 'number') __number = error.number; } catch (e) {}
    var __line = null;
    try { if (error && typeof error.line === 'number') __line = error.line; } catch (e) {}
    return __mcpJsonEncode({
      __em: 1,
      ok: false,
      error: { message: __message, number: __number, line: __line }
    });
  } finally {
    try { if (__originalRulerUnits !== null) app.preferences.rulerUnits = __originalRulerUnits; } catch (e) {}
    try { if (__originalTypeUnits !== null) app.preferences.typeUnits = __originalTypeUnits; } catch (e) {}
    try { if (__originalDisplayDialogs !== null) app.displayDialogs = __originalDisplayDialogs; } catch (e) {}
  }
})();
    `.trim();
  }
}
