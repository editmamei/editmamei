package main

// Parsing for the macOS accessibility probe's output.
//
// Deliberately NOT in dialog_darwin.go and deliberately not build-tagged: the
// AppleScript can only be exercised on a Mac, but the parsing of what it
// returns is pure string handling, and gating it behind //go:build darwin would
// leave the most test-able half of the backend unrun on the platform most of
// this project's CI and development happens on. The transport is Mac-only; the
// contract is not.

import (
	"strconv"
	"strings"
)

// Field and record separators. Captions are user-facing text in an unknown
// language and may contain any printable character, so the protocol between
// the AppleScript and Go uses control codes that cannot appear in a caption.
const (
	fieldSep  = "\x1f"
	recordSep = "\x1e"
)

// parseProbeOutput turns the AppleScript's record stream into a Report.
//
// The bool reports whether the output described a state we actually observed.
// A false is always paired with an `unknown` report — every failure path here
// must resolve to "could not tell", never to `clear`, because a confident
// "no dialog" about a Photoshop we failed to inspect is the one answer that
// makes the caller act on a lie.
func parseProbeOutput(out string, pid int) (Report, bool) {
	records := strings.Split(out, recordSep)
	if len(records) == 0 {
		return unknown("probe-empty"), false
	}

	head := strings.Split(records[0], fieldSep)
	if len(head) < 2 || head[0] != "STATUS" {
		return unknown("probe-unparseable"), false
	}

	switch head[1] {
	case "noproc":
		// The process is not there under that name. Not `clear`: we did not
		// observe an unblocked Photoshop, we failed to find one at all.
		return unknown("no-photoshop-process"), false
	case "nowindow":
		return unknown("no-photoshop-window"), false
	case "clear":
		return Report{Status: StatusClear, OwnerPID: pid}, true
	case "dialog":
		// fall through
	default:
		return unknown("probe-unknown-status"), false
	}

	r := Report{Status: StatusDialog}
	var handle int
	for _, rec := range records[1:] {
		fields := strings.Split(rec, fieldSep)
		if len(fields) < 2 {
			continue
		}
		switch fields[0] {
		case "TITLE":
			r.Title = fields[1]
		case "TEXT":
			r.Text = fields[1]
		case "PROGRESS":
			r.HasProgress = fields[1] == "1"
		case "OTHER":
			if n, err := strconv.Atoi(strings.TrimSpace(fields[1])); err == nil {
				r.OtherControls = n
			}
		case "DEPTH":
			if n, err := strconv.Atoi(strings.TrimSpace(fields[1])); err == nil {
				r.Depth = n
			}
		case "HANDLE":
			if n, err := strconv.Atoi(strings.TrimSpace(fields[1])); err == nil {
				handle = n
			}
		case "BTN":
			if len(fields) < 4 {
				continue
			}
			idx, err := strconv.Atoi(strings.TrimSpace(fields[1]))
			if err != nil {
				continue
			}
			r.Buttons = append(r.Buttons, Button{
				// ID carries the 1-based AppleScript index, which is also the
				// click address. It is NOT a control ID and has no semantics —
				// see idSchemeIndex.
				ID:      int32(idx),
				Default: fields[2] == "1",
				Caption: fields[3],
			})
		}
	}

	normalizeReport(&r, pid, uintptr(handle), idSchemeIndex)
	return r, true
}

// escapeForAppleScript makes a value safe to embed in a double-quoted
// AppleScript string literal. The app name comes from Photoshop detection
// rather than from a user, but it is still interpolated into executable script
// text, so it is escaped rather than trusted.
func escapeForAppleScript(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	// Newlines would terminate the literal and change the script's meaning.
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", " ")
	return s
}
