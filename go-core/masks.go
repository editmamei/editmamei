package main

import (
	"fmt"

	"editmamei-core/internal/vault"
)

// mask family (Phase 1). All parameterless; createLayerMask additionally needs
// restoreCompositeChannel for its adjustment-layer mask-update cleanup path.

func createLayerMask() string {
	return fmt.Sprintf(tpl[vault.CreateMask], helperFunctions(), getContextInfo(), restoreCompositeChannel())
}

func deleteLayerMask() string {
	return fmt.Sprintf(tpl[vault.DeleteMask], helperFunctions(), getContextInfo())
}

func applyLayerMask() string {
	return fmt.Sprintf(tpl[vault.ApplyMask], helperFunctions(), getContextInfo())
}
