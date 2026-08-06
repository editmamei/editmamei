//go:build !pro

package main

// proOnlyFragments stub for a CE (no `-tags pro`) generator run. The Pro
// fragments are build-tagged out, so a `-pro-only` request here has nothing to
// emit — return nil so main() fails loudly ("requires -tags pro") rather than
// writing an empty Pro blob.
func proOnlyFragments() map[string]string {
	return nil
}
