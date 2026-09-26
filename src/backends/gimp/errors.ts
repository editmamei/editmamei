/**
 * Stable error codes for the GIMP backend, as one array so the runtime
 * lookup (`session.ts`'s `KNOWN_ERROR_CODES`, used to validate a code the
 * bridge hands back) and the compile-time union type below can never drift
 * apart.
 *
 * `message` always starts with `<code>: ` followed by an actionable sentence —
 * the client-side error classifier keys on that prefix (mirrors the `ps_*`
 * error-message convention). `code` is the machine-readable part; the message
 * after the prefix is free to change without breaking anything that reads
 * `code`.
 */
export const GIMP_ERROR_CODES = [
  'gimp_not_installed',
  'gimp_start_failed',
  'gimp_python_missing',
  'gimp_version_unsupported',
  'gimp_session_restarted',
  'gimp_timeout',
  'gimp_unsupported_file',
  'gimp_op_failed',
  'invalid_argument',
  'file_not_found',
] as const;

export type GimpErrorCode = (typeof GIMP_ERROR_CODES)[number];

export class GimpError extends Error {
  constructor(
    readonly code: GimpErrorCode,
    sentence: string
  ) {
    super(`${code}: ${sentence}`);
    this.name = 'GimpError';
  }
}
