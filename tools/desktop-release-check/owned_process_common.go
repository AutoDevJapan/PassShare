//go:build windows

package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"time"
)

var errSigningProcessRecovery = errors.New("signing process recovery unconfirmed")
var signingQuiescenceUnconfirmed bool

func runSigningCommand(ctx context.Context, cmd *exec.Cmd) error {
	return runOwnedSigningCommand(ctx, cmd)
}

// A signing command finishes only after its child scope and output readers
// have stopped. Callers must preserve any affected outputs if recovery fails.
func runOwnedSigningCommand(ctx context.Context, cmd *exec.Cmd) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	tree, err := prepareSigningTree(cmd)
	if err != nil {
		return errors.New("signing process scope could not be created")
	}
	defer tree.close()
	if err = cmd.Start(); err != nil {
		return err
	}
	if err = tree.started(cmd); err != nil {
		killErr := cmd.Process.Kill()
		stopErr := tree.stop()
		waited := make(chan error, 1)
		go func() { waited <- cmd.Wait() }()
		select {
		case <-waited:
		case <-time.After(5 * time.Second):
			signingQuiescenceUnconfirmed = true
			return errSigningProcessRecovery
		}
		if stopErr != nil || (killErr != nil && !errors.Is(killErr, os.ErrProcessDone)) {
			signingQuiescenceUnconfirmed = true
			return errSigningProcessRecovery
		}
		return errors.New("signing process could not be started safely")
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var result error
	select {
	case result = <-done:
	case <-ctx.Done():
		stopErr := tree.stop()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			signingQuiescenceUnconfirmed = true
			return errSigningProcessRecovery
		}
		if stopErr != nil {
			signingQuiescenceUnconfirmed = true
			return errSigningProcessRecovery
		}
		return ctx.Err()
	}
	if err := tree.stop(); err != nil {
		signingQuiescenceUnconfirmed = true
		return errSigningProcessRecovery
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return result
}
