package main

import (
	"fmt"

	"editmamei-core/internal/vault"
)

// history family (Phase 1). undo/redo step the activeHistoryState; both carry
// full getContextInfo() (they change what's active in the edit timeline).

func undo(steps float64) string {
	return fmt.Sprintf(tpl[vault.Undo], getContextInfo(), jsNum(steps))
}

func redo(steps float64) string {
	return fmt.Sprintf(tpl[vault.Redo], getContextInfo(), jsNum(steps))
}

func getHistoryStates() string {
	return fmt.Sprintf(tpl[vault.HistStates], getContextInfo())
}
