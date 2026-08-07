# Security policy

Editmamei is a Model Context Protocol (MCP) server that drives Adobe Photoshop. Like every MCP
server, it executes scripts produced by an upstream AI assistant, and it exposes
`ps_execute_script`, an explicit escape hatch that runs arbitrary ExtendScript inside Photoshop on
the user's machine.

Editmamei's trust boundary is "the MCP client is trusted." Where that assumption does not hold on
a given setup, security findings against the package matter a great deal, and we would rather
hear about them early.

## Reporting a vulnerability

Please do not open a public issue for a security-impacting bug. The tracker is public, and so is
the report. Use one of these instead:

- **GitHub private security advisory**, preferred, since it handles disclosure timing for you.
  Open one from this repository's Security tab.
- **Email:** security@editmamei.com.

Please include:

1. What is affected and what an attacker could do.
2. Reproduction steps: a minimal repro, ideally with the MCP client name and version, the OS, the
   Photoshop version, and the triggering input.
3. The affected version. `editmamei report` writes an anonymized diagnostic bundle with the
   version, system info, and recent session summaries.
4. Your disclosure preference. We are happy to coordinate timing, credit you in the advisory, or
   keep your name out of it.

## Scope

In scope:

- The published `editmamei` npm package, all editions, and the source in this repository.
- The CLI, including the license and module-provisioning subcommands (`activate`, `deactivate`,
  `license`, `repair`, `config`, `install`, `uninstall`, `status`, `report`).
- The MCP tool surface, including the `ps_execute_script` safety boundary.
- The licensed module delivery path: signature verification, entitlement checks, and the
  integrity of what gets installed.
- The session log, diagnostic bundles, and template system under `~/.editmamei/`.

Out of scope here:

- Adobe Photoshop itself. Adobe runs its own
  [security disclosure program](https://helpx.adobe.com/security.html).
- The AI client hosting Editmamei (Claude Desktop, Cursor, Claude Code, and others). Each vendor
  has its own process.
- The editmamei.com site and its infrastructure, which has a separate path documented at
  [editmamei.com/security](https://editmamei.com/security).

## What to expect

Editmamei is maintained by a very small team, so these are honest targets and not a contractual
SLA. If something slips, we will tell you where it stands instead of going quiet.

- Acknowledgement within a few business days.
- Triage within about a week: confirmed, not reproduced, or needs more information.
- A fix timeline based on severity, communicated once we understand the issue, with high and
  critical severity taking priority over everything else on the roadmap.
- Credit in the published advisory if you want it.
- Disclosure in the release notes. Security fixes are described when they ship instead of landing
  silently.

There is no paid bug bounty at this time. We are glad to credit your work in the changelog and
release notes.

Thank you for helping keep Editmamei safe to use.

<!-- CLA bot smoke test — branch deleted after the check runs. -->
