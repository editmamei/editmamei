// Dialog probing: report which modal dialog, if any, is blocking Photoshop,
// and optionally click one of its buttons.
//
// This runs in a SIBLING process on purpose. When Photoshop raises a modal the
// scripting transport blocks until it is dismissed, so nothing that travels
// over that transport can observe or clear it. Window enumeration does not use
// the transport, so it works while the transport is dead.
//
// The platform backends supply resolve/describe/act; everything here is pure
// and testable without a Photoshop.
package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Report is the probe's whole output contract. `Status` is the part callers
// must handle; everything else is best-effort detail.
type Report struct {
	Status string `json:"status"`
	// Reason explains a non-actionable Status. Present for unknown/unsupported/stale.
	Reason string `json:"reason,omitempty"`
	// Token identifies THIS dialog, and must be handed back to click into it.
	Token   string   `json:"token,omitempty"`
	Title   string   `json:"title,omitempty"`
	Text    string   `json:"text,omitempty"`
	Buttons []Button `json:"buttons,omitempty"`
	// OtherControls counts visible interactive children that are NOT push
	// buttons (edit fields, combos, checkboxes). Part of the stakes signal.
	OtherControls int `json:"otherControls"`
	// HasProgress is true when the dialog carries a progress bar, i.e. an
	// operation is RUNNING. Disqualifies auto-clear outright.
	HasProgress bool `json:"hasProgress"`
	// Stakes classifies how safe this dialog is to act on without asking.
	Stakes   string `json:"stakes,omitempty"`
	Depth    int    `json:"depth,omitempty"`
	OwnerPID int    `json:"ownerPid,omitempty"`
	ProbeMs  int64  `json:"probeMs"`
}

// Button is one clickable control. `ID` is the address to click, and is only
// valid for THIS probe — Adobe reallocates control IDs between Photoshop
// sessions, so an ID must never be persisted or matched against a table.
type Button struct {
	Index   int    `json:"index"`
	ID      int32  `json:"id"`
	Caption string `json:"caption"`
	Default bool   `json:"default"`
}

// Status values.
const (
	StatusDialog      = "dialog"      // something is blocking; detail may be partial
	StatusClear       = "clear"       // PROVEN not blocked — main window found, no dialog
	StatusUnknown     = "unknown"     // could not determine; never conflate with clear
	StatusUnsupported = "unsupported" // no backend on this OS
	StatusStale       = "stale"       // click target no longer matches the token
	StatusCleared     = "cleared"     // click succeeded, nothing blocking now
	StatusReplaced    = "replaced"    // click succeeded, a DIFFERENT dialog is now up
	StatusUnchanged   = "unchanged"   // click delivered but the dialog is still there
)

// Stakes values — the language-free routing signal. Computed from structure
// only, never from caption text, so it behaves identically in any UI language.
const (
	StakesRunning       = "running"       // a progress bar: an operation is in flight
	StakesDataLoss      = "data_loss"     // a save/discard/overwrite decision
	StakesInformational = "informational" // one button, nothing else: no decision exists
	StakesDecision      = "decision"      // anything else: a caller must choose
)

// idScheme says what a Button.ID means on the backend that produced it, which
// is NOT the same across platforms and cannot be inferred from the value.
//
// Windows hands back a real control ID, where a few values carry fixed meaning
// (IDYES/IDNO). macOS has no such thing: System Events addresses a button by
// its position in the button list, so the ID field carries an index. An index
// of 6 is the seventh button and means nothing else — reading it as IDYES is
// how a macOS dialog with enough buttons would be misclassified as destructive.
type idScheme int

const (
	// idSchemeWin32 — ID is a Windows control ID; a few values are semantic.
	idSchemeWin32 idScheme = iota
	// idSchemeIndex — ID is a positional index and carries no meaning at all.
	idSchemeIndex
)

// probeTarget is how a backend addresses Photoshop. The two platforms need
// different halves of it and neither needs both: Windows enumerates windows by
// PID, macOS asks System Events for a process by name (there is no PID in the
// AppleScript at all).
type probeTarget struct {
	PIDs    []int
	AppName string
}

// Truncation caps. A dialog is a human-sized thing; anything past these is a
// bug in the enumeration, not content worth carrying.
const (
	maxTitle   = 200
	maxText    = 2000
	maxButtons = 8
)

// accelerators that Windows dialogs use to mark the underlined access key.
// Photoshop uses BOTH: "&Preview" and "\x01Legacy" both occur in the wild.
var acceleratorReplacer = strings.NewReplacer("&&", "\x00AMP\x00", "&", "", "\x01", "")

// cleanCaption strips accelerator markers and collapses whitespace.
func cleanCaption(s string) string {
	s = acceleratorReplacer.Replace(s)
	s = strings.ReplaceAll(s, "\x00AMP\x00", "&")
	return strings.Join(strings.Fields(s), " ")
}

// clamp shortens s to n runes, marking that it was cut.
func clamp(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// classifyStakes routes a dialog by STRUCTURE alone.
//
// Order is load-bearing. The progress check must precede the button count: a
// Photoshop progress window has exactly one push button ("Cancel") and no other
// interactive control, which is bit-for-bit the informational signature — so
// without this ordering, auto-clearing an informational dialog would cancel a
// running operation.
// A three-way prompt is data loss on every backend, because that check reads no
// IDs. The Yes/No ID check stays Windows-only, as the only backend whose IDs
// carry meaning, so a two-button overwrite prompt on macOS classifies as
// `decision`: a COARSER answer, not a wrong one. Windows misses the same prompt
// when Photoshop draws it with its own IDs.
func classifyStakes(buttons []Button, otherControls int, hasProgress bool, ids idScheme) string {
	if hasProgress {
		return StakesRunning
	}
	if isThreeWayPrompt(buttons, otherControls) || (ids == idSchemeWin32 && impliesDataLoss(buttons)) {
		return StakesDataLoss
	}
	if len(buttons) == 1 && otherControls == 0 {
		return StakesInformational
	}
	return StakesDecision
}

// isThreeWayPrompt reports the shape of "Save changes?": exactly three buttons
// and nothing else to fill in. IDs can't identify it: Photoshop 27.11 draws that
// prompt's Yes/No/Cancel as 10/11/12, not IDYES/IDNO. Another three-button prompt
// gets the same warning, and all that costs is asking the user first.
func isThreeWayPrompt(buttons []Button, otherControls int) bool {
	return len(buttons) == 3 && otherControls == 0
}

// impliesDataLoss reports whether the button SET looks like a destructive
// choice, using standard Windows control IDs and arity only — never captions,
// which are localized.
//
// IDYES/IDNO as a pair is the classic "Overwrite?" shape.
func impliesDataLoss(buttons []Button) bool {
	const (
		idYes = 6
		idNo  = 7
	)
	var hasYes, hasNo bool
	for _, b := range buttons {
		switch b.ID {
		case idYes:
			hasYes = true
		case idNo:
			hasNo = true
		}
	}
	return hasYes && hasNo
}

// makeToken derives a stable identity for a dialog.
//
// The content hash is what makes handle recycling detectable: Windows reuses
// HWND values, so hwnd alone would let a click land on a different dialog that
// happened to inherit the handle.
//
// macOS has no handle to recycle, so its backend passes the container's
// position in the window list instead. That keeps two same-titled dialogs at
// different depths distinguishable, and the content hash still carries the
// "did this dialog change underneath the caller" check that the click gate
// depends on.
//
// The message text and button ids count too. Two save prompts for different
// documents can share a title, captions and, on macOS, a window position; only
// the message says which document a click would discard.
func makeToken(pid int, hwnd uintptr, title, text string, buttons []Button) string {
	h := sha256.New()
	h.Write([]byte(title))
	h.Write([]byte{0})
	h.Write([]byte(text))
	for _, b := range buttons {
		fmt.Fprintf(h, "\x00%d\x00%s", b.ID, b.Caption)
	}
	return fmt.Sprintf("d1:%d:%X:%x", pid, hwnd, h.Sum(nil)[:4])
}

// modalFirst orders window candidates for describing: modal-framed ones first,
// each group keeping its given order. Windows enumerates top-down, so the first
// modal-framed window is the one on top, which is the blocker.
func modalFirst(hwnds []uintptr, isModal func(uintptr) bool) []uintptr {
	var modal, rest []uintptr
	for _, h := range hwnds {
		if isModal(h) {
			modal = append(modal, h)
		} else {
			rest = append(rest, h)
		}
	}
	return append(modal, rest...)
}

// hasButton reports whether id is one the caller could have read from the
// report, so a click can't reach a control that was never listed.
func hasButton(buttons []Button, id int32) bool {
	for _, b := range buttons {
		if b.ID == id {
			return true
		}
	}
	return false
}

// normalize finalizes a report gathered by a backend: cleans captions, applies
// caps, computes the stakes class and the token. Backends collect; this decides.
func normalizeReport(r *Report, pid int, hwnd uintptr, ids idScheme) {
	r.Title = clamp(cleanCaption(r.Title), maxTitle)
	r.Text = clamp(strings.Join(strings.Fields(r.Text), " "), maxText)

	cleaned := make([]Button, 0, len(r.Buttons))
	for i, b := range r.Buttons {
		if len(cleaned) >= maxButtons {
			break
		}
		b.Index = i
		b.Caption = cleanCaption(b.Caption)
		cleaned = append(cleaned, b)
	}
	r.Buttons = cleaned

	r.Stakes = classifyStakes(r.Buttons, r.OtherControls, r.HasProgress, ids)
	r.OwnerPID = pid
	if r.Token == "" {
		// A running operation's message can change on every tick, which says
		// nothing about which dialog this is.
		text := r.Text
		if r.HasProgress {
			text = ""
		}
		r.Token = makeToken(pid, hwnd, r.Title, text, r.Buttons)
	}
}

// parsePIDs accepts the comma-separated list the TS side passes, because more
// than one Photoshop.exe can be running.
func parsePIDs(s string) []int {
	var out []int
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		var n int
		if _, err := fmt.Sscanf(part, "%d", &n); err == nil && n > 0 {
			out = append(out, n)
		}
	}
	sort.Ints(out)
	return out
}

func emit(r Report) {
	b, err := json.Marshal(r)
	if err != nil {
		fmt.Println(`{"status":"unknown","reason":"marshal-failed"}`)
		return
	}
	fmt.Println(string(b))
}

// unknown builds the honest non-answer. Callers must treat this exactly like
// "could not tell" — never like "clear".
func unknown(reason string) Report {
	return Report{Status: StatusUnknown, Reason: reason}
}
