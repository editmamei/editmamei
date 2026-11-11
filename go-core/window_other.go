//go:build !windows

package main

// The Relight preview reads Photoshop's window, which is Windows-only for now.
// On macOS it would need Screen Recording and Accessibility permissions.
func openPhotoshopWindow() (psWindow, error) {
	return nil, errWindowUnsupported
}
