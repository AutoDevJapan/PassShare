//go:build !windows && !signingprocessred

package main

import (
	"context"
	"errors"
	"os/exec"
)

var errSigningProcessRecovery = errors.New("signing process recovery unconfirmed")
var signingQuiescenceUnconfirmed bool

// The existing non-Windows candidate path is unchanged. Windows signs in an
// owned job so cancellation cannot leave signing descendants behind.
func runSigningCommand(_ context.Context, cmd *exec.Cmd) error { return cmd.Run() }
