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
	StakesRunning     = "running"      // a progress bar: an operation is in flight
	StakesDataLoss    = "data_loss"    // a save/discard/overwrite decision
	StakesInformational = "informational" // one button, nothing else: no decision exists
	StakesDecision    = "decision"     // anything else: a caller must choose
)

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
func classifyStakes(buttons []Button, otherControls int, hasProgress bool) string {
	if hasProgress {
		return StakesRunning
	}
	if impliesDataLoss(buttons) {
		return StakesDataLoss
	}
	if len(buttons) == 1 && otherControls == 0 {
		return StakesInformational
	}
	return StakesDecision
}

// impliesDataLoss reports whether the button SET looks like a destructive
// choice, using standard Windows control IDs and arity only — never captions,
// which are localized.
//
// IDYES/IDNO as a pair is the classic "Save changes?" / "Overwrite?" shape.
// Three or more buttons with a yes/no among them is the three-way save prompt.
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
func makeToken(pid int, hwnd uintptr, title string, buttons []Button) string {
	h := sha256.New()
	h.Write([]byte(title))
	for _, b := range buttons {
		h.Write([]byte{0})
		h.Write([]byte(b.Caption))
	}
	return fmt.Sprintf("d1:%d:%X:%x", pid, hwnd, h.Sum(nil)[:4])
}

// normalize finalizes a report gathered by a backend: cleans captions, applies
// caps, computes the stakes class and the token. Backends collect; this decides.
func normalizeReport(r *Report, pid int, hwnd uintptr) {
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

	r.Stakes = classifyStakes(r.Buttons, r.OtherControls, r.HasProgress)
	r.OwnerPID = pid
	if r.Token == "" {
		r.Token = makeToken(pid, hwnd, r.Title, r.Buttons)
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
