package main

// fragments holds the PLAINTEXT JSX template fragments, authored naturally as
// Go raw strings. This file is part of the build-time generator ONLY — it is
// never compiled into the shipped editmamei-core binary, so this plaintext
// never reaches the npm tarball. The generator encrypts these into
// templates.enc, which is what the main package embeds.
//
// Ported verbatim from the TS sources (src/api/extendscript/_helpers.ts +
// filters.ts) so emitted JSX is behaviorally identical. %s slots mark runtime
// interpolation points the main-package emitter fills via fmt.Sprintf.
var fragments = map[string]string{}

// addFragments merges a family's fragments into the shared map, panicking on a
// duplicate key so a bad split can't silently clobber an entry.
func addFragments(m map[string]string) {
	for k, v := range m {
		if _, dup := fragments[k]; dup {
			panic("duplicate fragment key: " + k)
		}
		fragments[k] = v
	}
}
