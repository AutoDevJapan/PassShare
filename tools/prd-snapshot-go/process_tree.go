package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"time"
)

var errProcessRecovery = errors.New("owned process recovery unconfirmed")

// A command is complete only after its owned descendants are terminated and
// output-copy goroutines have returned. Credential cleanup follows this call.
func runOwnedCommand(ctx context.Context, cmd *exec.Cmd) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	tree, err := prepareTree(cmd)
	if err != nil {
		return errors.New("owned process scope could not be created")
	}
	defer tree.close()
	if err = cmd.Start(); err != nil {
		return err
	}
	if err = tree.started(cmd); err != nil {
		killErr := cmd.Process.Kill()
		stopErr := tree.stop()
		failedStartWait := make(chan error, 1)
		go func() { failedStartWait <- cmd.Wait() }()
		select {
		case <-failedStartWait:
		case <-time.After(5 * time.Second):
			return errProcessRecovery
		}
		if stopErr != nil || (killErr != nil && !errors.Is(killErr, os.ErrProcessDone)) {
			return errProcessRecovery
		}
		return errors.New("owned process could not be started safely")
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
			return errProcessRecovery
		}
		if stopErr != nil {
			return errProcessRecovery
		}
		return ctx.Err()
	}
	// A CLI may exit while descendants keep its inherited pipes. WaitDelay
	// turns that into an error, never permission to leave them running.
	if err := tree.stop(); err != nil {
		return errProcessRecovery
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return result
}
