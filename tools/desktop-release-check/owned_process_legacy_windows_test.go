//go:build windows && signingprocessred

package main

import (
	"context"
	"errors"
	"os/exec"
)

var errSigningProcessRecovery = errors.New("signing process recovery unconfirmed")
var signingQuiescenceUnconfirmed bool

// The pre-fix command has no ownership of its descendants. Kept under an
// explicit build tag for the same Windows fixture's RED comparison.
func runSigningCommand(_ context.Context, cmd *exec.Cmd) error {
	return cmd.Run()
}
