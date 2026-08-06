// Command editmamei-core is the compiled snippet/orchestration core for the
// Editmamei MCP server. It builds ExtendScript (JSX) snippet bodies from a
// name + params and writes them to stdout, so the snippet IP ships as an
// AES-256-GCM-encrypted blob (embedded via `//go:embed templates.enc`,
// decrypted in-memory at startup in secret.go) inside a normal, unobfuscated
// Go binary rather than readable JS in the npm tarball.
//
// Protocol (Phase 0, per-call spawn):
//
//	editmamei-core build <snippet-name>     # params JSON on stdin, JSX on stdout
//
// Errors go to stderr with a non-zero exit; the TS SnippetClient turns that
// into a thrown Error. This is snippet *generation* failing, and is separate
// from how a generated snippet reports its own outcome once Photoshop runs it.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
)

func main() {
	if len(os.Args) >= 2 && os.Args[1] == "version" {
		fmt.Println("editmamei-core phase0")
		return
	}
	if len(os.Args) < 3 || os.Args[1] != "build" {
		fmt.Fprintln(os.Stderr, "usage: editmamei-core build <snippet-name>  (params JSON on stdin)")
		os.Exit(2)
	}
	name := os.Args[2]

	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, "editmamei-core: read stdin:", err)
		os.Exit(1)
	}

	// Tolerate a leading UTF-8 BOM — some stdin sources (PowerShell pipes,
	// certain editors) prepend one, which json.Unmarshal rejects. The
	// production caller (Node child_process) won't, but defensiveness is cheap.
	raw = bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})

	params := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &params); err != nil {
			fmt.Fprintln(os.Stderr, "editmamei-core: parse params:", err)
			os.Exit(1)
		}
	}

	jsx, err := build(name, params)
	if err != nil {
		fmt.Fprintln(os.Stderr, "editmamei-core:", err)
		os.Exit(1)
	}
	if _, err := io.WriteString(os.Stdout, jsx); err != nil {
		fmt.Fprintln(os.Stderr, "editmamei-core: write stdout:", err)
		os.Exit(1)
	}
}
