//go:build !windows && !darwin

package main

import "time"

// No dialog backend on this platform. Windows enumerates windows directly;
// macOS drives System Events. Nothing else has a supported vantage point.
//
// Reporting `unsupported` is the honest answer: callers degrade to today's
// behaviour and are told why, rather than being handed a confident `clear`.
func probeModal(target probeTarget, started time.Time) Report {
	return Report{
		Status:  StatusUnsupported,
		Reason:  "dialog probing is implemented on Windows and macOS only",
		ProbeMs: time.Since(started).Milliseconds(),
	}
}

func clickButton(target probeTarget, token string, buttonID int32, started time.Time) Report {
	return Report{
		Status:  StatusUnsupported,
		Reason:  "dialog dismissal is implemented on Windows and macOS only",
		ProbeMs: time.Since(started).Milliseconds(),
	}
}
