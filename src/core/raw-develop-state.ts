/**
 * One-slot "raw opened, no develop pass yet" flag.
 *
 * Set when ps_open_document reports is_raw_source: true in a session where
 * a camera-raw develop tool is registered; cleared when a develop pass runs
 * (any ps_apply_camera_raw mode), when a non-raw document is opened, or when
 * a document closes. ps_add_adjustment_layer reads it to attach a soft
 * advisory ("consider the develop pass first") to its result.
 *
 * One slot matches the ps_detect / ps_read_scene caches: the consumer is one
 * MCP session working one document, so alternating documents thrashes but
 * stays correct — never stale. The flag is advisory-only; a misfire (user
 * manually switches documents in Photoshop) costs one ignorable sentence,
 * never a failed call.
 */

export interface PendingRawDevelop {
  documentName: string;
  filePath: string;
}

let pending: PendingRawDevelop | null = null;

/** A raw-sourced document was opened and no develop pass has run yet. */
export function markRawOpened(documentName: string, filePath: string): void {
  pending = { documentName, filePath };
}

/** A develop pass ran, or the active document changed to a non-raw one. */
export function clearPendingRawDevelop(): void {
  pending = null;
}

export function getPendingRawDevelop(): PendingRawDevelop | null {
  return pending;
}

/** Test-only: reset the flag between cases. */
export function __clearRawDevelopState(): void {
  pending = null;
}
