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
 * This only bites in the hydrated overlay, which is the tree that has a
 * `docs/archive/`. The published docs here have none — so the filter is inert
 * in this repo and load-bearing in the overlay.
 *
 * Deliberately narrow: it exempts the archive, NOT the rest of the overlay's
 * docs. Everything else there stays covered, which matters — a live doc is
 * where a floor claim can still send someone at an install that will not run.
 */

/**
 * True for a `readdirSync(..., { recursive: true })` entry directly under a
 * TOP-LEVEL `archive/`. The path is relative to the docs root being walked, so
 * `archive/x.md` is exempt while `engineering/archive/x.md` is not.
 *
 * Compares the leading path segment rather than testing a prefix string, so it
 * behaves the same with either separator and a sibling like `archived-notes/`
 * cannot be caught by an accidental prefix match. Widening this to match any
 * segment is the dangerous direction: it silently drops coverage.
 */
export function isArchived(docsRelativePath: string): boolean {
  return docsRelativePath.split(/[\\/]/)[0] === 'archive';
}
