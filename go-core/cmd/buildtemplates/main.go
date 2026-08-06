// Command buildtemplates is the build-time generator that turns the plaintext
// JSX template fragments (fragments.go) into the encrypted templates.enc blob
// that the main editmamei-core package embeds via go:embed.
//
// This tool is NEVER shipped — only its output (the ciphertext blob, then the
// compiled binary) reaches users. Run from the module root:
//
//	go run ./cmd/buildtemplates
//
// AES-256-GCM with a random nonce prepended. Nonce is fresh per build, so the
// blob is not reproducible across builds (acceptable; revisit if reproducible
// builds become a requirement).
package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"editmamei-core/internal/vault"
)

const outPath = "templates.enc"

func main() {
	// `-pro-only` emits a Pro-fragments-ONLY blob — the source for the Pro
	// module's go-core, which carries no community JSX (one go-core per module).
	// Default emits the package's `fragments` map: community-only with no tag,
	// community+Pro under `-tags pro` (fragments_pro.go's init() merges Pro in).
	proOnly := false
	for _, a := range os.Args[1:] {
		if a == "-pro-only" || a == "--pro-only" {
			proOnly = true
		}
	}

	out := fragments
	if proOnly {
		out = proOnlyFragments()
		if out == nil {
			fail("-pro-only requires `-tags pro`",
				fmt.Errorf("the Pro fragments are build-tagged out of a no-tag generator run"))
		}
	}

	// Guard against the stray-% gotcha: the emitters fmt.Sprintf over these
	// fragments, so any '%' that isn't part of a '%s' verb or an escaped '%%'
	// silently corrupts arg interpolation (a literal "100%" in a comment ate a
	// positional arg before this check existed). Fail loudly at generate time.
	for key, body := range out {
		if pos := strayPercent(body); pos >= 0 {
			ctxStart := pos - 20
			if ctxStart < 0 {
				ctxStart = 0
			}
			ctxEnd := pos + 20
			if ctxEnd > len(body) {
				ctxEnd = len(body)
			}
			fail("fragment "+key+" has a stray '%' (use %% for a literal percent) near: ..."+body[ctxStart:ctxEnd]+"...",
				fmt.Errorf("offset %d", pos))
		}
	}

	plaintext, err := json.Marshal(out)
	if err != nil {
		fail("marshal fragments", err)
	}

	block, err := aes.NewCipher(vault.Key)
	if err != nil {
		fail("new cipher", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		fail("new gcm", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		fail("read nonce", err)
	}
	// Seal appends ciphertext to the nonce, so the blob is nonce||ciphertext.
	blob := gcm.Seal(nonce, nonce, plaintext, nil)

	if err := os.WriteFile(outPath, blob, 0o644); err != nil {
		fail("write "+outPath, err)
	}
	// Accurate mode label: pro-only emits just Pro; otherwise the set depends on
	// the build tag — proOnlyFragments() is non-nil only under `-tags pro`, which
	// is exactly when `fragments` carries the community+Pro superset.
	mode := "community"
	if proOnly {
		mode = "pro-only"
	} else if proOnlyFragments() != nil {
		mode = "community+pro"
	}
	fmt.Printf("buildtemplates: wrote %s (%s, %d fragments, %d bytes)\n", outPath, mode, len(out), len(blob))
}

// strayPercent returns the byte offset of the first '%' that is not part of a
// '%s' verb or a '%%' escape, or -1 if the fragment's percent usage is clean.
func strayPercent(s string) int {
	for i := 0; i < len(s); i++ {
		if s[i] != '%' {
			continue
		}
		if i+1 >= len(s) {
			return i // trailing '%'
		}
		switch s[i+1] {
		case 's':
			i++ // valid verb
		case '%':
			i++ // escaped literal — skip the pair
		default:
			return i
		}
	}
	return -1
}

func fail(what string, err error) {
	fmt.Fprintf(os.Stderr, "buildtemplates: %s: %v\n", what, err)
	os.Exit(1)
}
