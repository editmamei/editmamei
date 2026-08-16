//go:build !windows

package main

import "time"

// No dialog backend on this platform yet.
//
// macOS is reachable in principle — System Events can both read a sheet's
// buttons and click them, gated behind a one-time Accessibility grant — but it
// is unimplemented and, more importantly, UNVERIFIED. The Windows backend had
// four of its assumptions overturned by a live spike, two of which would have
// shipped a feature that passed its tests and reported nothing in the field.
// Claiming parity here on the strength of the design alone would repeat that.
//
// Reporting `unsupported` is the honest answer: callers degrade to today's
// behaviour and are told why, rather than being handed a confident `clear`.
func probeModal(pids []int, started time.Time) Report {
	return Report{
		Status:  StatusUnsupported,
		Reason:  "dialog probing is implemented on Windows only",
		ProbeMs: time.Since(started).Milliseconds(),
	}
}

func clickButton(pids []int, token string, buttonID int32, started time.Time) Report {
	return Report{
		Status:  StatusUnsupported,
		Reason:  "dialog dismissal is implemented on Windows only",
		ProbeMs: time.Since(started).Milliseconds(),
	}
}
