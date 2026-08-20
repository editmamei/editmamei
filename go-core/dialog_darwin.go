//go:build darwin

package main

import (
	"context"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// The macOS backend drives System Events through `osascript`. No cgo, no
// framework linkage, no module dependency — the binary still cross-compiles
// with CGO_ENABLED=0 like every other target.
//
// It addresses Photoshop BY PROCESS NAME, not by PID: System Events has no PID
// addressing, and the detector already records the name in PhotoshopInfo
// because AppleScript needs it elsewhere. A PID is still accepted and used for
// the token and OwnerPID, but it is not how anything is located.
//
// Everything here collects; dialog.go decides. The one thing this file must
// never do is return `clear` on an error path — an un-consented or broken probe
// reporting "no dialog" is worse than no probe at all, because the caller then
// acts on a confident lie.

// osascriptTimeout bounds the whole AppleScript. System Events can itself block
// when the target app is wedged, and a probe that hangs turns the recovery
// mechanism into a second hang — the same reasoning as SendMessageTimeout on
// the Windows side.
const osascriptTimeout = 6 * time.Second

// The record protocol this file's scripts emit, and the parser for it, live in
// dialog_axparse.go — untagged on purpose so they are testable off a Mac.

// Failure classification lives in dialog_axparse.go with the rest of the
// untagged, testable half.

// probeScript reads the blocking dialog, if any.
//
// Photoshop puts some dialogs in a SHEET on a document window and some in a
// separate window with subrole AXDialog, so both are checked — and the sheet
// search covers every window, not just window 1, because the blocked document
// is not reliably frontmost.
//
// Emits one record per line in a fixed field order. Any read that fails is
// emitted as empty rather than aborting the script: a partial description of a
// real dialog is far more useful than an error, and the caller is told the
// status either way.
const probeScript = `
on joinList(theList, sep)
	set out to ""
	repeat with i from 1 to count of theList
		if i > 1 then set out to out & sep
		set out to out & (item i of theList)
	end repeat
	return out
end joinList

set FS to (ASCII character 31)
set RS to (ASCII character 30)

tell application "System Events"
	set procs to (every application process whose name is "%APPNAME%")
	if procs is {} then return "STATUS" & FS & "noproc"
	set psProc to item 1 of procs

	set wins to windows of psProc
	if (count of wins) is 0 then return "STATUS" & FS & "nowindow"

	-- Locate the dialog container: sheet on any window first, then a
	-- standalone AXDialog window. Depth counts every candidate found.
	set dlgRef to missing value
	set dlgIndex to 0
	set depthCount to 0
	set wi to 0
	repeat with w in wins
		set wi to wi + 1
		try
			if (exists sheet 1 of w) then
				set depthCount to depthCount + 1
				if dlgRef is missing value then
					set dlgRef to sheet 1 of w
					set dlgIndex to wi
				end if
			end if
		end try
	end repeat
	set wi to 0
	repeat with w in wins
		set wi to wi + 1
		try
			if (subrole of w) is "AXDialog" then
				set depthCount to depthCount + 1
				if dlgRef is missing value then
					set dlgRef to w
					set dlgIndex to wi
				end if
			end if
		end try
	end repeat

	if dlgRef is missing value then return "STATUS" & FS & "clear"

	set outLines to {}

	set theTitle to ""
	try
		set theTitle to (name of dlgRef) as text
	end try
	set end of outLines to "TITLE" & FS & theTitle

	-- Static text is the message body; join every fragment in order.
	set theText to ""
	try
		set txts to {}
		repeat with t in (static texts of dlgRef)
			try
				set end of txts to (value of t) as text
			on error
				try
					set end of txts to (name of t) as text
				end try
			end try
		end repeat
		set theText to my joinList(txts, " ")
	end try
	set end of outLines to "TEXT" & FS & theText

	-- A progress indicator means an operation is RUNNING. This is the single
	-- most important bit in the whole report: it is what stops a lone Cancel
	-- from being treated as a harmless one-button notice.
	set hasProg to "0"
	try
		if (count of progress indicators of dlgRef) > 0 then set hasProg to "1"
	end try
	set end of outLines to "PROGRESS" & FS & hasProg

	set otherCount to 0
	try
		set otherCount to otherCount + (count of text fields of dlgRef)
	end try
	try
		set otherCount to otherCount + (count of checkboxes of dlgRef)
	end try
	try
		set otherCount to otherCount + (count of pop up buttons of dlgRef)
	end try
	try
		set otherCount to otherCount + (count of radio buttons of dlgRef)
	end try
	try
		set otherCount to otherCount + (count of sliders of dlgRef)
	end try
	set end of outLines to "OTHER" & FS & otherCount

	set end of outLines to "DEPTH" & FS & depthCount
	set end of outLines to "HANDLE" & FS & dlgIndex

	-- Buttons, in list order. The index IS the address — button names are
	-- localized and unstable, so nothing else may be used to click.
	set defaultName to ""
	try
		set defaultName to (name of (value of attribute "AXDefaultButton" of dlgRef)) as text
	end try
	try
		set btns to buttons of dlgRef
		repeat with bi from 1 to count of btns
			set b to item bi of btns
			set bName to ""
			try
				set bName to (name of b) as text
			end try
			set isDefault to "0"
			if defaultName is not "" and bName is defaultName then set isDefault to "1"
			set end of outLines to "BTN" & FS & bi & FS & isDefault & FS & bName
		end repeat
	end try

	return "STATUS" & FS & "dialog" & RS & my joinList(outLines, RS)
end tell
`

// clickScript presses one button by INDEX inside the same container the probe
// found. Index, never name — §5.2 of the design: the evidencing customer runs a
// German Photoshop, and a caption-addressed click is broken for every non-
// English user.
const clickScript = `
set FS to (ASCII character 31)
tell application "System Events"
	set procs to (every application process whose name is "%APPNAME%")
	if procs is {} then return "noproc"
	set psProc to item 1 of procs
	set wins to windows of psProc
	if (count of wins) is 0 then return "nowindow"

	set dlgRef to missing value
	repeat with w in wins
		try
			if (exists sheet 1 of w) then
				set dlgRef to sheet 1 of w
				exit repeat
			end if
		end try
	end repeat
	if dlgRef is missing value then
		repeat with w in wins
			try
				if (subrole of w) is "AXDialog" then
					set dlgRef to w
					exit repeat
				end if
			end try
		end repeat
	end if
	if dlgRef is missing value then return "nodialog"

	try
		set btns to buttons of dlgRef
		if (count of btns) < %INDEX% then return "noindex"
		click (item %INDEX% of btns)
		return "clicked"
	on error errMsg number errNum
		return "error " & errNum & ": " & errMsg
	end try
end tell
`

// runOsascript executes a script and returns its trimmed stdout. The bool
// reports whether the script itself ran; a false means we know nothing, which
// the callers must translate into `unknown` and never into `clear`.
func runOsascript(script string) (string, bool, string) {
	ctx, cancel := context.WithTimeout(context.Background(), osascriptTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "/usr/bin/osascript", "-e", script)
	out, err := cmd.Output()
	if ctx.Err() == context.DeadlineExceeded {
		// System Events itself can block against a wedged app. Time out and
		// say so rather than becoming the second hang.
		return "", false, "probe-timeout"
	}
	if err != nil {
		stderr := ""
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			stderr = string(ee.Stderr)
		}
		return "", false, classifyOsascriptFailure(stderr)
	}
	return strings.TrimSpace(string(out)), true, ""
}

// appNameFor picks the process name to address. An empty name is a caller bug
// rather than a runtime condition, but it must not become a wrong answer, so it
// degrades to `unknown` upstream.
func appNameFor(target probeTarget) string {
	return strings.TrimSpace(target.AppName)
}

func firstPID(target probeTarget) int {
	if len(target.PIDs) > 0 {
		return target.PIDs[0]
	}
	return 0
}

func probeModal(target probeTarget, started time.Time) Report {
	name := appNameFor(target)
	if name == "" {
		return withMs(unknown("no-app-name"), started)
	}

	script := strings.ReplaceAll(probeScript, "%APPNAME%", escapeForAppleScript(name))
	out, ok, reason := runOsascript(script)
	if !ok {
		return withMs(unknown(reason), started)
	}

	r, _ := parseProbeOutput(out, firstPID(target))
	return withMs(r, started)
}

// clickButton re-probes, verifies the token still matches, clicks by index,
// then re-probes to report what actually happened.
//
// The token gate is the whole safety story: without it a click lands on
// whatever dialog happens to be up now, which may not be the one the caller
// read and agreed to.
func clickButton(target probeTarget, token string, buttonIndex int32, started time.Time) Report {
	name := appNameFor(target)
	if name == "" {
		return withMs(unknown("no-app-name"), started)
	}

	current := probeModal(target, started)
	if current.Status != StatusDialog {
		return withMs(Report{Status: StatusStale, Reason: "no-dialog-to-click"}, started)
	}
	if current.Token != token {
		return withMs(Report{
			Status: StatusStale, Reason: "token-mismatch", Token: current.Token,
			Title: current.Title, Buttons: current.Buttons,
		}, started)
	}
	if buttonIndex < 1 {
		return withMs(Report{Status: StatusStale, Reason: "button-not-found"}, started)
	}

	script := strings.ReplaceAll(clickScript, "%APPNAME%", escapeForAppleScript(name))
	script = strings.ReplaceAll(script, "%INDEX%", strconv.Itoa(int(buttonIndex)))
	out, ok, reason := runOsascript(script)
	if !ok {
		return withMs(unknown(reason), started)
	}
	switch strings.TrimSpace(out) {
	case "clicked":
		// fall through to verification
	case "noindex":
		return withMs(Report{Status: StatusStale, Reason: "button-not-found"}, started)
	case "nodialog":
		return withMs(Report{Status: StatusStale, Reason: "dialog-vanished"}, started)
	default:
		return withMs(unknown("click-failed"), started)
	}

	time.Sleep(150 * time.Millisecond) // let the dialog tear down
	after := probeModal(target, started)
	switch {
	case after.Status == StatusClear:
		return withMs(Report{Status: StatusCleared}, started)
	case after.Status == StatusDialog && after.Token != token:
		// The click opened ANOTHER dialog. Report and stop; never chain.
		after.Status = StatusReplaced
		return after
	case after.Status == StatusDialog:
		after.Status = StatusUnchanged
		return after
	default:
		return after
	}
}

func withMs(r Report, started time.Time) Report {
	r.ProbeMs = time.Since(started).Milliseconds()
	return r
}
