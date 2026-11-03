/**
 * Builds the argv `detect.ts` hands to `session.ts`, keyed on how the install
 * was found. `session.ts` appends GIMP's own batch args (`-i
 * --batch-interpreter=python-fu-eval -b <BATCH_LINE> --quit`) after these —
 * this module only knows how to reach the `gimp-console` binary itself, not
 * what to tell it to do once running.
 */

export interface LaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
}

/** A `gimp-console` executable found directly on disk (env override, conventional path, or PATH). */
export function exeLaunchSpec(exePath: string): LaunchSpec {
  return { command: exePath, args: [] };
}

/**
 * Launch a Flatpak-packaged GIMP. Unverified: whether the Flatpak sandbox can
 * read/write the session dir under the per-user cache root and load
 * `bridge/ops.py` from the host filesystem — both live under the user's real
 * home directory, outside anything Flatpak grants by default. If the
 * sandbox can't see them, every call fails at the readiness handshake rather
 * than silently, which is the safer failure shape for an unverified path.
 */
export function flatpakLaunchSpec(): LaunchSpec {
  return { command: 'flatpak', args: ['run', '--command=gimp-console-3.2', 'org.gimp.GIMP'] };
}
