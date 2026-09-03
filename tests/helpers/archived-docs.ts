/**
 * `docs/archive/` holds dated snapshots — a description as it was written, a
 * one-off analysis, a plan that has since been superseded. They record what was
 * true when they were written, so correcting a number inside one rewrites the
 * record rather than fixing a claim anybody acts on.
 *
 * The docs-wide sync guards (the Node and macOS floor checks) walk `docs/`
 * recursively and assert every stated floor matches what the build produces.
 * That is right for live documentation and wrong for an archive: an archived
 * doc is not an install path, and holding it to today's floor would force a
 * choice between falsifying history and living with a permanently red suite.
 *
 * This only bites in the hydrated commercial tree, which is the one with an
 * `docs/archive/`. The published docs here have none — so the filter is inert
 * in this repo and load-bearing in the overlay.
 *
 * Deliberately narrow: it exempts the archive, NOT the rest of the overlay's
 * docs. Live private copy (the outbound product description, for one) states
 * floors a user acts on and stays covered — a stale macOS claim was found
 * there exactly this way.
 */

/**
 * True for a `readdirSync(..., { recursive: true })` entry under `archive/`.
 * Compares path segments rather than a prefix string so it behaves the same
 * with either separator, and so a sibling like `archived-notes/` is not caught
 * by an accidental prefix match.
 */
export function isArchived(relativePath: string): boolean {
  return relativePath.split(/[\\/]/)[0] === 'archive';
}
