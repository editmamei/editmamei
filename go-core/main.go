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
//	editmamei-core dialog --action probe --pid N[,N] --app-name "Adobe Photoshop 2026"
//	editmamei-core dialog --action click --pid N[,N] --app-name "…" --token T --button-id I
//
// Both addressing forms are passed on every call because the backends differ:
// Windows enumerates windows by PID, macOS asks System Events for a process by
// name and has no use for a PID at all.
//
// Errors go to stderr with a non-zero exit; the TS SnippetClient turns that
// into a thrown Error. This is snippet *generation* failing, and is separate
// from how a generated snippet reports its own outcome once Photoshop runs it.
//
// `dialog` is the odd one out: it builds nothing. It inspects the Photoshop UI
// from outside the scripting transport, which is the only vantage point that
// still works while a modal has that transport blocked. It always exits 0 for
// an answerable outcome — including "no dialog" — so a non-zero exit means the
// probe itself is broken rather than that Photoshop is busy.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"time"
)

func runDialog(args []string) {
	started := time.Now()
	fs := flag.NewFlagSet("dialog", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	action := fs.String("action", "probe", "probe | click")
	pidList := fs.String("pid", "", "comma-separated Photoshop PIDs (Windows addressing)")
	appName := fs.String("app-name", "", "Photoshop process name (macOS addressing)")
	token := fs.String("token", "", "dialog identity token from a prior probe (click only)")
	buttonID := fs.Int("button-id", -1, "button address from a prior probe: control id on Windows, index on macOS (click only)")
	if err := fs.Parse(args); err != nil {
		os.Exit(2)
	}

	// Both halves are always passed; each backend uses the one it can address
	// with. Neither is validated here — a backend that cannot work with what it
	// got reports `unknown` with a reason, which is an answer, whereas exiting
	// non-zero would read as "the probe is broken".
	target := probeTarget{PIDs: parsePIDs(*pidList), AppName: *appName}
	switch *action {
	case "probe":
		emit(probeModal(target, started))
	case "click":
		if *token == "" || *buttonID < 0 {
			fmt.Fprintln(os.Stderr, "dialog --action click requires --token and --button-id")
			os.Exit(2)
		}
		emit(clickButton(target, *token, int32(*buttonID), started))
	default:
		fmt.Fprintf(os.Stderr, "dialog: unknown --action %q (want probe or click)\n", *action)
		os.Exit(2)
	}
}

func main() {
	if len(os.Args) >= 2 && os.Args[1] == "version" {
		fmt.Println("editmamei-core phase0")
		return
	}
	if len(os.Args) >= 2 && os.Args[1] == "dialog" {
		runDialog(os.Args[2:])
		return
	}
	if len(os.Args) < 3 || os.Args[1] != "build" {
		fmt.Fprintln(os.Stderr, "usage: editmamei-core build <snippet-name>  (params JSON on stdin)")
		fmt.Fprintln(os.Stderr, "       editmamei-core dialog --action probe|click --pid N[,N]")
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
