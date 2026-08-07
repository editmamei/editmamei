/**
 * Turns what a platform runner read off Photoshop's stdout back into a value.
 *
 * Both runners produced a byte-identical copy of this logic. One copy now, so a
 * change to the convention is a change in one file.
 *
 * The wrapper (`src/api/photoshop-api.ts`) hands back one of three things:
 *   - a JSON document, for any object or string result;
 *   - a bare scalar rendered with `String()`, for numbers and booleans;
 *   - a failure line, marked by a leading `ERROR:`.
 */

/**
 * Leading token marking a failure that happened *outside* Photoshop's script
 * engine — the runner could not reach or attach to the application at all.
 *
 * This is the only remaining use of the in-band marker. Scripts that actually
 * ran report their outcome in the envelope below instead, which is what stopped
 * a returned string beginning with these characters from being mistaken for a
 * thrown error.
 */
const TRANSPORT_FAILURE_MARKER = 'ERROR:';

/** Marks a payload as one of our envelopes rather than an arbitrary object. */
const ENVELOPE_TAG = '__em';

/** The envelope the ExtendScript wrapper emits around every outcome. */
interface ResultEnvelope {
  __em: number;
  ok: boolean;
  value?: unknown;
  error?: { message?: unknown; number?: unknown; line?: unknown };
}

function isEnvelope(payload: unknown): payload is ResultEnvelope {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    ENVELOPE_TAG in (payload as Record<string, unknown>)
  );
}

/**
 * A script ran in Photoshop and failed there.
 *
 * Distinct from the transport errors raised around it (a timed-out child, a
 * non-zero `osascript` exit) so callers can tell "Photoshop rejected this
 * script" apart from "we never got Photoshop to answer."
 */
export class PhotoshopScriptError extends Error {
  /** Photoshop's own error number, when it reported one. */
  readonly psErrorNumber: number | null;
  /** Line within the executed script, when Photoshop reported one. */
  readonly psLine: number | null;

  constructor(message: string, psErrorNumber: number | null = null, psLine: number | null = null) {
    super(message);
    this.name = 'PhotoshopScriptError';
    this.psErrorNumber = psErrorNumber;
    this.psLine = psLine;
  }
}

/** Narrow an envelope field to a number, tolerating whatever the wrapper sent. */
function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Decode one raw stdout payload.
 *
 * Three shapes arrive here:
 *   - an envelope from the wrapper, carrying either a value or a script error;
 *   - a transport failure line, when the runner never reached Photoshop;
 *   - a bare payload, from a script sent without the wrapper (the liveness
 *     probe is the one that does this).
 *
 * @throws {PhotoshopScriptError} for either failure shape.
 */
export function decodeScriptResult(raw: string): unknown {
  const payload = raw.trim();

  if (payload.startsWith(TRANSPORT_FAILURE_MARKER)) {
    throw new PhotoshopScriptError(payload.slice(TRANSPORT_FAILURE_MARKER.length).trim());
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // Not JSON — a bare scalar or an unwrapped script's return. Hand back the
    // trimmed string, which is what it already is.
    return payload;
  }

  if (!isEnvelope(parsed)) return parsed;

  if (parsed.ok) return parsed.value;

  const detail = parsed.error ?? {};
  throw new PhotoshopScriptError(
    typeof detail.message === 'string' ? detail.message : '',
    asNumberOrNull(detail.number),
    asNumberOrNull(detail.line)
  );
}
