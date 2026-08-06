package main

import (
	"crypto/aes"
	"crypto/cipher"
	_ "embed"
	"encoding/json"

	"editmamei-core/internal/vault"
)

// templates.enc is the AES-256-GCM-encrypted JSX template blob produced by
// `go run ./cmd/buildtemplates`. Embedding the ciphertext (not the plaintext)
// is what keeps the JSX out of `strings` on the shipped binary — the at-rest
// protection bar (R1.10, Finding 1). It must exist before `go build`.
//
//go:embed templates.enc
var templatesEnc []byte

// tpl is the decrypted fragment map, populated once at startup. Keys are the
// opaque vault.* constants; values are the plaintext JSX fragments (in memory
// only — never written back to disk).
var tpl map[string]string

func init() {
	m, err := decryptTemplates(templatesEnc, vault.Key)
	if err != nil {
		// A decrypt failure means a corrupt/mismatched blob — the binary is
		// unusable, so fail loudly rather than emit empty snippets.
		panic("editmamei-core: template blob decrypt failed: " + err.Error())
	}
	tpl = m
}

func decryptTemplates(blob, key []byte) (map[string]string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	ns := gcm.NonceSize()
	if len(blob) < ns {
		return nil, errShortBlob
	}
	nonce, ct := blob[:ns], blob[ns:]
	plaintext, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, err
	}
	var m map[string]string
	if err := json.Unmarshal(plaintext, &m); err != nil {
		return nil, err
	}
	return m, nil
}
