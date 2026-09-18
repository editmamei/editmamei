# Privacy & data handling

Editmamei is an MCP server that drives Adobe Photoshop on your own machine. This page describes
exactly what it does with your data: what stays on your machine, what you control, how to
control it, and the precise shape of everything that leaves. It's about the npm package you
install (the `editmamei` MCP server), not about the
[editmamei.com](https://editmamei.com) website, which has its own
[privacy policy](https://editmamei.com/privacy).

The short version: your photos aren't uploaded to us. The only thing Editmamei sends to its own
servers is content-free usage data, tied to a random install ID; it's documented field-for-field
below, and you can switch it off with one command. (When your AI assistant needs to see an edit, a downscaled preview
goes to that assistant; covered under "Your AI assistant is a cloud service" below.)

---

## What Editmamei never sends to us

There is one line Editmamei does not cross, on any setting or edition:

- **Your image and document content.** No photos, previews, thumbnails, layer renders, or
  Photoshop document data are ever sent to Editmamei.
- **Your file paths.** Full paths stay local. Where a path is unavoidable in an opt-in
  diagnostic message, it's reduced to a bare filename first (see [Sanitization](#sanitization)).
- **Your metadata.** Camera info, GPS, and author fields are never part of what Editmamei
  transmits.

The previews your AI assistant looks at are a separate matter: that's your AI client talking
to its own cloud, not Editmamei. See [Your AI assistant is a cloud service](#your-ai-assistant-is-a-cloud-service).

---

## Diagnostic reports (you generate, you share)

When something breaks, you — or your assistant, via the `ps_report_problem` tool or the
`editmamei report` command — can generate a **diagnostic bundle**: a single
`editmamei-diagnostics-<id>.json` file saved to your **Downloads** folder. Editmamei never
uploads it. You review the file and attach it to a bug report yourself.

The bundle is sanitized to the same hard line as everything above:

- **No image or document content**, **no tool arguments**, and file paths reduced to basenames.
- It holds recent server log lines, your OS / Editmamei / Photoshop versions, your
  `install_id`, and a content-free summary of recent tool calls (name, success, duration, error
  class — never the arguments). If a Claude Desktop log is present, a redacted tail is included
  with every request and response **body** removed — only method names and timing are kept.

Because it's a local file, you can open it and see exactly what you're sharing before you send it.

---

## What you control

Every setting lives in a single plain-text file, `~/.editmamei/settings.json`, created on first
run. These are the keys:

| Key | Type | Default | What it does |
|---|---|---|---|
| `telemetry.usage` | boolean | `true` (on) | Content-free usage and reliability data. The opt-out tier. |
| `telemetry.diagnostics` | boolean | `false` (off) | Extra sanitized error detail for bug-hunting. The opt-in tier. |
| `telemetry.install_id` | string | random | A random ID, minted once, so installs can be counted without knowing who you are. It is not derived from anything about you, but it is stable, so it is still personal data and you have rights over it — see [Your rights, and the legal basis](#your-rights-and-the-legal-basis). **Read-only**: you can see it, but it isn't something you set. |
| `privacy.send_previews_to_llm` | boolean | `true` | Reserved for an upcoming per-feature control over sending visual previews to your AI assistant. **Not yet enforced**: setting it has no effect in the current build. |
| `ps_path` | string \| null | `null` | Pin a specific Photoshop binary. `null` = auto-detect (the `PHOTOSHOP_PATH` env var still wins if set). |
| `update_check` | boolean | `true` (on) | Check the public npm registry at startup for a newer version (see "Update check" below). The opt-out tier. |

`install_id` is a random value; it is **not** derived from your username, machine name, email,
or any other identifier.

---

## How to control it

Three equivalent ways, all writing the same `~/.editmamei/settings.json`:

**Edit the file directly.** It's plain JSON and yours to inspect at any time:

```json
{
  "telemetry": {
    "usage": true,
    "diagnostics": false,
    "install_id": "…"
  },
  "privacy": {
    "send_previews_to_llm": true
  },
  "update_check": true,
  "ps_path": null
}
```

**Use the CLI.** The `editmamei config` command reads and writes the same file:

```bash
editmamei config list                          # print all current settings as JSON
editmamei config get telemetry.usage           # read one setting
editmamei config set telemetry.usage false     # turn usage telemetry off
editmamei config set telemetry.diagnostics true  # opt in to diagnostic detail
```

Boolean values accept `true`/`false`, `on`/`off`, `yes`/`no`, or `1`/`0`.

**In Claude Desktop.** The one-click extension has no terminal, so the same two switches appear in
the extension's own settings (Settings → Extensions → Editmamei): **Share usage stats**
(opt-out) and **Share error diagnostics** (opt-in). Toggling them there controls telemetry for
Claude Desktop without editing any file.

**First-run notice.** The first time Editmamei creates the settings file, it prints this to its
log so the default is never a surprise:

> First run: Editmamei collects content-free usage telemetry (tool name, success,
> duration, bytes returned, version/edition/OS/PS-version, install channel, which AI client
> connected, Node/OS/architecture versions, and per-session counts like edits made and retries)
> to find what breaks. It never sends image content, file paths, or personal data. Opt out
> anytime: `editmamei config set telemetry.usage false` (or edit `~/.editmamei/settings.json`).
> Opt in to sanitized diagnostics: `editmamei config set telemetry.diagnostics true`.

> **Note:** Editmamei reads the settings file once at startup. After changing a setting, restart
> your AI client so the server picks it up.

---

## Exactly what data leaves

When `telemetry.usage` is on, Editmamei sends a small, content-free subset of the local session
log. Each event is one JSON object. Below is every field that can ever be sent; there are no
hidden fields.

### Usage event: one per tool call (on by default)

```json
{
  "v": 2,
  "type": "usage",
  "install_id": "9f3c…",
  "ts_bucket": "2026-06-15",
  "editmamei_version": "1.0.3",
  "edition": "community",
  "platform": "win32",
  "ps_version": "27.8.0",
  "tool": "ps_add_adjustment_layer",
  "success": true,
  "error_class": null,
  "duration_ms": 612,
  "result_bytes": 842
}
```

| Field | Meaning |
|---|---|
| `v` | Schema version (currently `2`). |
| `type` | `"usage"`. |
| `install_id` | Your random install ID. |
| `ts_bucket` | The **day** only (`YYYY-MM-DD`), never a precise timestamp. |
| `editmamei_version` | Which Editmamei version you're on. |
| `edition` | `community` or `pro`. |
| `platform` | Operating system only (`win32`, `darwin`, `linux`). |
| `ps_version` | Your Photoshop version (e.g. `27.8.0`), or `unknown`. |
| `tool` | The tool name that ran (e.g. `ps_add_adjustment_layer`). |
| `success` | Whether the call succeeded. |
| `error_class` | On failure, a short error **category** (e.g. `wrong_layer_kind`), never a message or free text. `null` on success. |
| `duration_ms` | How long the call took, in milliseconds. |
| `result_bytes` | The **size** of the tool's response, in bytes — never its content. `0` when the tool returned nothing, and omitted entirely if the size wasn't measured. |

### Session start: once when Editmamei launches (on by default)

```json
{
  "v": 2,
  "type": "session_start",
  "install_id": "9f3c…",
  "ts_bucket": "2026-06-15",
  "editmamei_version": "1.0.3",
  "edition": "community",
  "platform": "win32",
  "ps_version": "unknown",
  "channel": "npx",
  "node_major": 22,
  "arch": "x64",
  "os_major": 11
}
```

Sent once when Editmamei starts, so an install can be counted even before you run anything. Same
content-free fields as above, with **no tool name, no counts, no free text**. `ps_version` is usually
`unknown` because Photoshop hasn't been queried yet at startup.

| Field | Meaning |
|---|---|
| `channel` | Which install route you used: `npx`, `npm_global` (installed from the package registry into a global prefix), `npm_local` (installed as a dependency of another local project), `mcpb` (the one-click Claude Desktop extension), or `source` (running from a git checkout). One of those five values; nothing else. |
| `node_major` | The Node.js major version Editmamei is running under (e.g. `22`). Omitted if unknown. |
| `arch` | CPU architecture bucket: `x64`, `arm64`, or `other`. Always present — an unrecognized architecture sends `other`, never omitted. |
| `os_major` | Your OS's major version (e.g. `11` for Windows 11, `15` for macOS Sequoia). Omitted if unparseable. |

### Client connected: once per session, when your AI client finishes connecting (on by default)

```json
{
  "v": 2,
  "type": "client_connected",
  "install_id": "9f3c…",
  "ts_bucket": "2026-06-15",
  "editmamei_version": "1.0.3",
  "edition": "community",
  "platform": "win32",
  "client": "claude_code",
  "client_major": 2,
  "cap_sampling": true,
  "cap_elicitation": false,
  "cap_roots": true
}
```

Sent once the MCP handshake with your AI client completes, so we can tell which clients people
actually connect Editmamei to (and prioritize testing against the popular ones). Content-free: the
client's self-reported name is mapped to a fixed short list, never sent as free text, and its
version is reduced to a bare major number.

| Field | Meaning |
|---|---|
| `client` | Which AI client connected, one of: `claude_desktop`, `claude_code`, `cursor`, `windsurf`, `vscode`, or `other`. Never the raw client name string. |
| `client_major` | The client's major version number, or `null` if it didn't report one or the version doesn't parse. Among the fields added after this event type shipped, it is the only one sent as `null` rather than omitted — a connected client with an unreadable version is still a known fact. (`error_class` is also sent as `null`, on a successful call.) |
| `cap_sampling` / `cap_elicitation` / `cap_roots` | Whether the client declared support for these MCP capabilities. Booleans only. |

If your AI client never completes the handshake, this event is never sent.

### Module status: once at startup, Pro installs only (on by default)

Sent once at startup **only if a Pro license is present on the machine** (a free Community install
never sends it). It reports whether your Pro module actually loaded, so a purchase that failed to
install its module is distinguishable from one that's working:

```json
{
  "v": 2,
  "type": "module_status",
  "install_id": "9f3c…",
  "ts_bucket": "2026-06-15",
  "editmamei_version": "1.0.3",
  "edition": "pro",
  "platform": "win32",
  "module": "pro",
  "outcome": "loaded",
  "module_version": "0.22.1",
  "abi": 2
}
```

| Field | Meaning |
|---|---|
| `module` | Which add-on the status is about (`pro` today). |
| `outcome` | One of a fixed set: `loaded` (Pro is running), `absent` (entitled but the module isn't downloaded yet), `lapsed` (the license is no longer active), `skipped_corrupt` / `skipped_incompatible` (the module was present but couldn't be used this run). |
| `module_version` | The Pro module's version, or `null` if none is installed. |
| `abi` | The module's internal compatibility number, or `null` if unknown. |

No image content, no paths, no tool arguments — an enum outcome plus the module's own version numbers.

### Session summary: one per session (on by default)

```json
{
  "v": 2,
  "type": "session_summary",
  "install_id": "9f3c…",
  "ts_bucket": "2026-06-15",
  "editmamei_version": "1.0.3",
  "edition": "community",
  "platform": "win32",
  "ps_version": "27.8.0",
  "tool_call_count": 47,
  "distinct_tools": 11,
  "any_failures": true,
  "duration_s": 913,
  "retry_count": 2,
  "ended_after_failure": false,
  "edits_ok": 31,
  "kept_work": 4,
  "behind_latest": false,
  "dropped_events": 0,
  "module_update": "none",
  "templates_saved": 6,
  "action_sets": 2
}
```

`tool_call_count`, `distinct_tools`, and `any_failures` are simple totals for the session — how
many tool calls happened, how many distinct tools, whether anything failed. No per-call detail.

| Field | Meaning |
|---|---|
| `duration_s` | Wall-clock from your first tool call to your last, in seconds (capped at 7 days). |
| `retry_count` | How many calls repeated the immediately preceding tool + arguments — a rough "the AI had to try again" signal. |
| `ended_after_failure` | Whether the session's very last recorded call failed. |
| `edits_ok` | Successful calls to a tool that actually changes the open document. |
| `kept_work` | Successful calls to a tool that saves the result to disk (export, save). |
| `behind_latest` | Whether the boot-time update check found a newer published version. Present only when the check actually ran and resolved a verdict — `true` for a confirmed newer version, `false` for confirmed already current. Omitted when the check is off, disabled, still pending, or failed (offline, timeout, malformed response) — a failed check has no verdict to report, so it is never sent as a false `false`. |
| `dropped_events` | Events this client had to drop in memory because too many piled up before they could be sent. Almost always `0`. |
| `module_update` | Whether the background Pro-module refresh installed something (`updated`), failed (`failed`), or did neither (`none`). Sent only for installs with a Pro license on file — a Community install never sends this field. |
| `templates_saved` / `action_sets` | How many templates you've saved and how many Photoshop Action Sets you have loaded, as counts only — never their names or content. `templates_saved` is read from your own disk and is omitted if that read fails; `action_sets` is omitted until a connection to Photoshop has reported it. |

`duration_s`, `ended_after_failure`, `behind_latest`, `module_update`, `templates_saved`, and
`action_sets` are each omitted — never sent as a false zero — when this session never learned
them. `retry_count`, `edits_ok`, `kept_work`, and `dropped_events` are always present: `0` is a
real observation (no retries, no edits kept, nothing dropped), not an unknown.

### Diagnostic event: only if you opt in

Sent **only** when you set `telemetry.diagnostics true`, and only when something fails:

```json
{
  "v": 2,
  "type": "diagnostic",
  "install_id": "9f3c…",
  "ts_bucket": "2026-06-15",
  "editmamei_version": "1.0.3",
  "platform": "win32",
  "ps_version": "27.8.0",
  "tool": "ps_apply_adjustment",
  "error_class": "am_descriptor_no_op",
  "error_message": "…sanitized; paths reduced to filenames…",
  "snippet": "applyShadowsHighlights",
  "stderr_tail": "…last lines of error output, sanitized…",
  "doc_depth": 16,
  "doc_mode": "cmyk",
  "ps_locale": "en_US"
}
```

This adds a sanitized error message, the name of the failing step (`snippet`), and a trimmed
tail of error output, enough to trace a bug without you mailing a log by hand. Still no image
content.

| Field | Meaning |
|---|---|
| `doc_depth` | The open document's bit depth at the last successful connection to Photoshop: `8`, `16`, or `32` — present only for a document at one of those three depths. Omitted if no document was open, or its depth is none of the three. |
| `doc_mode` | The open document's color mode: `rgb`, `cmyk`, `lab`, `grayscale`, or `other`. Omitted if no document was open. |
| `ps_locale` | Photoshop's UI language/region (e.g. `en_US`), read from Photoshop itself. Omitted if it doesn't match a plain language-region token. |

### What is deliberately never in any event

- The arguments you passed a tool (no prompts, no values, no text).
- Any image, preview, thumbnail, or document content.
- Full file paths.
- A precise timestamp (day-granularity only).
- A session ID or anything that links events back to a specific editing session beyond the
  install ID.

---

## Sanitization

Before any diagnostic string leaves, it runs through a fixed cleanup pass:

1. Home directory redacted (`C:\Users\you\…` → `~\…`).
2. Absolute paths collapsed to their final filename (`C:\photos\client\shot.psd` → `shot.psd`).
3. Name-miss detail redacted: everything after a `not found:` marker — the name that was
   asked for and any list of the layer/group/channel names that exist — becomes
   `[redacted]`. Layer names are your content; the full message stays in the local
   session log on your machine only.
4. Backslashes normalized to forward slashes; leading separators stripped.
5. Length capped (error message 2000 chars, step name 128, error-output tail 4000).

As a final backstop, any event that still looks like it contains an absolute path is **dropped
entirely** rather than sent.

---

## Where it goes

Usage and diagnostic events are sent to Editmamei's **own** telemetry endpoint (not a
third-party analytics company), where they're aggregated by day. Sending is batched and
best-effort: it happens in the background, times out quickly, and never blocks your editing.
Events that fail to send — offline, a network hiccup, the endpoint unreachable — are held in a
small, bounded local queue and retried at the next launch; they are never queued indefinitely.

Per-install daily counts derived from Category A events (calls, failures, edits, exports, and
the like) are kept against your install ID for **24 months**, then deleted automatically by a
nightly job — long enough to see how usage changes over the life of an install, and no longer.
Opt-in diagnostic rows (Category B, the sanitized error detail) are deleted after **90 days**.
The day-by-day totals that carry no install ID at all — how many times a tool ran across
everyone, and whether it worked — are not tied to you and are not on that clock.

---

## Update check

When `update_check` is on (the default), Editmamei makes **one** request at startup to the
**public npm registry** (`registry.npmjs.org`) to ask what the latest published version is, and —
if you're behind — tells you so the next time you check the connection. This is the one request
that goes to npm rather than Editmamei's own endpoint; it's an ordinary registry lookup, the same
public data `npm` itself reads.

- It sends **no usage data and no identifiers** — it's a plain "what's the latest version?" GET. No
  images, file paths, install ID, or personal data are involved.
- It's best-effort: it times out quickly, never retries, and never blocks startup. Offline → it's
  silently skipped.
- When a newer version is available, the notice may also mention which tools failed in your
  **previous session**, read from the local session log described above. That read stays on this
  machine — it changes what the notice *says*, not what is sent anywhere.
- Turn it off with `update_check false` (CLI or settings file), or the **Check for updates** toggle
  in the Claude Desktop extension settings.

---

## Local session logs

Separately from telemetry, Editmamei keeps a richer local log of each session at
`~/.editmamei/sessions/<session-id>.ndjson`. This is used for debugging and by the Templates
system to reconstruct an edit. It **stays on your disk**; it is not transmitted, and telemetry
is only the small content-free subset described above, never this file. There's no automatic
cleanup; delete the files whenever you like.

---

## Your AI assistant is a cloud service

The AI assistant you drive Editmamei with (Claude Desktop, Cursor, and the like) is a cloud
service governed by its own privacy policy. When you ask it to look at an image (for example,
the visual-verification preview), Editmamei hands a downscaled JPEG to **that AI provider** on
your behalf, exactly as if you'd dropped the file into a chat with it. That's a property of
using a cloud AI, and a function of which assistant you choose, not a hop Editmamei adds.

---

## Pro

Validating a Pro license is a content-free check. Confirming your license sends the license key
and a device identifier (Pro covers two devices per license) to the licensing service, and never
any document, image, or path data. Activation also downloads the signed, encrypted Pro module
itself from Editmamei's delivery endpoint; that request carries your license entitlement and no
document data. Your photos stay on your machine, exactly as with the rest of Editmamei.

---

## Your rights, and the legal basis

Who is responsible for this data, the basis for collecting each kind, how long it is kept, and
what you can require us to do. This applies to everyone, not only to people in the EU or UK.

**Controller.** EMBD Artifacts LLC, doing business as Editmamei. Contact:
[editmamei.com/contact](https://editmamei.com/contact).

**The install ID.** A random value generated on your machine. It is not derived from your name,
account, email, hardware, or anything else about you, and on its own it identifies nobody. It is
stable across sessions, and stable identifiers can be correlated with other information, so data
protection law classifies it as *pseudonymous* rather than anonymous: personal data, and subject
to the rights below.

**Lawful basis.**

- **Usage and reliability data** (on by default) — legitimate interests: identifying defects, and
  establishing which features are used and on which Photoshop versions. You have the right to
  object, and the setting is the mechanism.
- **Diagnostic detail** (off by default) — consent, given by enabling it and withdrawn by
  disabling it.

The two settings are independent. Disabling usage telemetry stops that stream entirely, including
anything already queued on disk; it does not disable diagnostics.

```sh
editmamei config set telemetry.usage false
editmamei config set telemetry.diagnostics false
```

**Retention.** Per-install records: 24 months, deleted automatically. Opt-in diagnostic records:
90 days, deleted automatically. Aggregate daily totals carry no install ID and are not subject to
these windows.

**Your rights.** Access, rectification, erasure, and objection. Your install ID is the reference
for all of them:

```sh
editmamei config get telemetry.install_id
```

Send it via [the contact page](https://editmamei.com/contact) with your request. Two limits apply:

- Erasure removes the stored records. It does not stop collection, because the same ID remains in
  your settings file. Disable telemetry first if you want both.
- Aggregate daily totals were summed on arrival with no ID attached, and cannot be recalculated to
  exclude a single install.

Without an install ID we cannot locate your records. No email address, account, or IP address is
stored alongside it.

**Processing.** Editmamei's own Cloudflare infrastructure. No third-party analytics processor.
Telemetry is not sold, shared, or used for advertising. Your IP address reaches that
infrastructure with the request, as it does with any web request, and is used only to rate-limit
abuse. It is never written to the telemetry store and never joined to your install ID.

---

## Questions & disclosures

- Full website privacy policy: [editmamei.com/privacy](https://editmamei.com/privacy)
- Security disclosures: [SECURITY.md](../SECURITY.md)
- Anything else: [open an issue](https://github.com/editmamei/editmamei/issues) or
  [get in touch](https://editmamei.com/contact).
