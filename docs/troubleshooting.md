# Troubleshooting

Organised by what you're seeing, not by what's broken underneath. Most answers differ depending on
how you installed Editmamei, so start here.

## Which install do you have?

Two install types, and they update and store settings differently.

| | **Claude Desktop extension** | **npm / npx** |
|---|---|---|
| You installed it by | dragging `editmamei.mcpb` onto the Extensions page | a config entry, or `npm install -g editmamei` |
| Settings live in | Claude Desktop → **Settings → Extensions → Editmamei** | `~/.editmamei/`, and the `editmamei` CLI |
| Updates | only when you install a new bundle | see [Did my update apply?](#did-my-update-apply) |

If you're not sure, run `editmamei status`. It reports which MCP clients Editmamei is registered
with and how.

Either way, your templates, session logs and license live in `~/.editmamei/` and survive updates,
reinstalls and uninstalls.

---

## Pro tools are missing, or Pro shows as Community

Start here, always:

```bash
editmamei license
```

That prints your license and, on the last line, whether Pro is unlocked and why not:

```
Editmamei license
  License:    ****-A1B2C3
  Status:     granted
  Expires:    never (perpetual)
  Last check: 2026-01-15T09:00:00.000Z
  Pro:        locked (grace-expired)
```

Read the reason in brackets and follow the matching row:

| Reason | What it means | What to do |
|---|---|---|
| `granted` | Pro is unlocked | If tools are still missing, restart your AI client. A newly downloaded module only loads on the next start. |
| `grace-expired` | Your license hasn't checked in recently enough | Usually [the restart loop](#the-restart-loop) below. If your system clock has been wrong, see [a clock set behind](#a-clock-set-behind) instead. |
| `revoked` / `disabled` | The license is no longer active | Check your subscription status. Once it's running again, run `editmamei license` to re-check it, then restart your AI client so the Pro tools load. |
| `expired` | The license has an end date that has passed | Renew, then run `editmamei activate YOUR-KEY` and restart your AI client so the Pro tools load. |

If `editmamei license` says **"No license activated on this device"** instead of printing the
block above, there's no license stored here at all. See [Activating Pro](installation.md#pro).

### The restart loop

If you see `grace-expired` while your subscription is perfectly fine, the usual cause is that your
AI client is restarting Editmamei faster than the license check can finish. Each start tries to
check in, gets cut off, and the next start tries again.

Break the cycle by giving it one clean run:

1. Quit your AI client **completely**. Not just the window: check the system tray or menu bar.
2. Wait about a minute.
3. Start it once, and leave it running.

Give it time before you judge it. If checks have been failing repeatedly, Editmamei deliberately
waits before trying again, so Pro can take a few hours to come back rather than returning at the
next start. Restarting does not shorten that wait, so leave the client running rather than cycling
it. If checks haven't been failing, the next start picks one up straight away and Pro should return
on it.

Then run `editmamei license`. `Last check` should show today's date and `Pro` should read
`unlocked`. Restart the client once more so the Pro tools load.

If it still says `grace-expired` after that, check the section below before emailing
support@editmamei.com, because a wrong clock produces the same reason and the steps above can't
cure it.

### A clock set behind

`grace-expired` also appears when this machine's clock has been set **ahead** at some point and
then corrected. Editmamei remembers the latest date it has seen, and a clock that is now earlier
than that makes the stored license unreadable as current. Restarting can't change it, and neither
can re-running `editmamei activate` on its own, because that keeps the stored record.

**How to tell it's this and not the restart loop:** `editmamei license` says `locked
(grace-expired)`, but `Last check` is within the past week (or even in the future). A license that
has genuinely gone a week without checking in shows an older date than that.

Fix it while connected to the internet:

1. Correct your system clock, or turn on automatic time.
2. Run `editmamei deactivate`. This clears the stored record and frees this machine's device slot.
3. Run `editmamei activate YOUR-KEY`.
4. Restart your AI client so the Pro tools load.

Do steps 2 and 3 online. Deactivating offline clears the record here but leaves the device slot
held on the server, so the activate that follows can be refused for having too many devices.

### After updating the Claude Desktop extension

Installing a new bundle can reset the extension's settings, including the **Pro license key**
field. Your stored license in `~/.editmamei/` keeps working for a while on its own, so Pro won't
break immediately. It stops days later, which makes it easy to miss the connection to the update.

After installing a new bundle, open **Settings → Extensions → Editmamei** and check the **Pro
license key** field still has your key in it. If it's empty, paste it back, save, and restart
Claude Desktop.

### If Pro still won't unlock

```bash
editmamei repair
```

This re-downloads the Pro module and touches nothing else. Your templates, settings, session logs
and license stay where they are. Restart your AI client afterwards.

Reach for `repair` **after** you've checked `editmamei license`, not before. `repair` fixes a
damaged download; it does nothing for a license that isn't checking in.

---

## "Photoshop did not respond"

Work through these in order:

1. **Is Photoshop actually running, with a document open?** Editmamei drives a running copy. It
   won't launch one for you.
2. **Restart Photoshop, then your AI client**, in that order.
3. **Check you're on a supported version.** See [Requirements](installation.md#requirements-photoshop-2026-node-22-windows-or-macos).
4. **If you have more than one Photoshop installed**, Editmamei may be talking to the wrong one.
   Pin the one you want with `--photoshop-path`, described under
   [Optional: pin a specific Photoshop install](installation.md#optional-pin-a-specific-photoshop-install).
5. **On a slow machine or with very large files**, scripts can time out before Photoshop answers.
   See [Optional: raise script timeouts](installation.md#optional-raise-script-timeouts-on-a-slow-machine).

Some specific Photoshop builds have shown this on one machine while working on another with the
same version. If none of the above helps, run `editmamei report` and open an issue with the bundle
attached so we can see what your setup looks like.

---

## Did my update apply?

What you need to do depends entirely on how Editmamei starts.

**If your client config uses `npx -y editmamei`** (this is what every example config in
[installation.md](installation.md) uses), there is **nothing to do**. `npx` fetches the latest
published version each time it starts, so you're current every time your client restarts.

**If you installed globally** with `npm install -g editmamei`, you are pinned to whatever you
installed until you update it yourself:

```bash
npm install -g editmamei@latest
```

Then restart your AI client.

**If you use the Claude Desktop extension**, the bundle is a frozen copy. It never updates on its
own. Download the current
[`editmamei.mcpb`](https://github.com/editmamei/editmamei/releases/latest/download/editmamei.mcpb),
drag it onto **Settings → Extensions** in Claude Desktop to replace the installed one, then restart
Claude Desktop. Afterwards, check your **Pro license key** field is still populated.

To see what you're actually running, ask your assistant to run `ps_ping`, which reports the
Editmamei version along with the Photoshop connection.

---

## Two installs on one machine

You can end up with both the Claude Desktop extension and an npm install on the same computer, for
example by using Claude Desktop and Claude Code side by side. That's supported, and one Pro license
covers it.

Be aware of two things:

- **They can be on different versions.** The extension is frozen at whatever bundle you installed;
  an `npx` config is always current. So the same machine can behave differently in two clients.
- **They can hold separate settings.** If the two run under different home directories, each keeps
  its own copy of `~/.editmamei/`, including its own license state. One can be working while the
  other isn't.

If one client has Pro and the other doesn't, run `editmamei license` from a terminal to see what
the npm side thinks, and check the **Pro license key** field for what the extension side thinks.

---

## Reporting a bug

```bash
editmamei report
```

This writes an anonymised diagnostic bundle and prints the path. Attach it to a new issue at
[github.com/editmamei/editmamei/issues](https://github.com/editmamei/editmamei/issues). Add
`--note "what you were doing"` to include a short description in the bundle.

Your own per-call session logs live in `~/.editmamei/sessions/` as `.ndjson` files, one per
session. They record which tools ran, whether they succeeded, and how long each took. They never
contain your images.

For account or billing questions, email support@editmamei.com rather than opening a public issue.
For security issues, follow [SECURITY.md](../SECURITY.md).
