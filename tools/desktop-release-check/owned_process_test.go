//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestSigningOwnedFixture is launched only as a subprocess by the lifecycle
// tests below. It uses no signing keys, UI, external network, or real products.
func TestSigningOwnedFixture(t *testing.T) {
	mode := os.Getenv("PASSSHARE_SIGNING_FIXTURE")
	if mode == "" {
		t.Skip("subprocess fixture only")
	}
	ready := os.Getenv("PASSSHARE_SIGNING_FIXTURE_READY")
	if mode == "parent" {
		cmd := exec.Command(os.Args[0], "-test.run=^TestSigningOwnedFixture$")
		cmd.Env = append(os.Environ(), "PASSSHARE_SIGNING_FIXTURE=child")
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if cmd.Start() != nil {
			os.Exit(3)
		}
		_ = cmd.Wait()
		os.Exit(0)
	}
	if mode == "child" {
		if os.WriteFile(ready+".pending", []byte(strconv.Itoa(os.Getpid())), 0600) != nil || os.Rename(ready+".pending", ready) != nil {
			os.Exit(4)
		}
		time.Sleep(2 * time.Minute)
		os.Exit(0)
	}
	os.Exit(5)
}

func TestSigningOwnedCommandCancelsAndReapsDescendant(t *testing.T) {
	ready := filepath.Join(scratch(t), "child.ready")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestSigningOwnedFixture$")
	cmd.Env = append(os.Environ(), "PASSSHARE_SIGNING_FIXTURE=parent", "PASSSHARE_SIGNING_FIXTURE_READY="+ready)
	cmd.WaitDelay = time.Second
	done := make(chan error, 1)
	go func() { done <- runSigningCommand(ctx, cmd) }()
	joined := false
	defer func() {
		cancel()
		if !joined {
			select {
			case <-done:
			case <-time.After(8 * time.Second):
				t.Error("owned fixture did not finish cleanup")
			}
		}
	}()
	deadline := time.Now().Add(5 * time.Second)
	var pid uint64
	for {
		if data, err := os.ReadFile(ready); err == nil {
			pid, err = strconv.ParseUint(strings.TrimSpace(string(data)), 10, 32)
			if err != nil || pid == 0 {
				t.Fatal("fixture child identity invalid")
			}
			break
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		}
		select {
		case err := <-done:
			joined = true
			t.Fatalf("command ended before descendant was ready: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("owned descendant did not reach readiness")
		}
		time.Sleep(time.Millisecond)
	}
	exited := signingFixtureChildExit(t, uint32(pid))
	cancel()
	select {
	case err := <-done:
		joined = true
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled command returned %v", err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("cancelled signing command did not return")
	}
	if !exited() {
		t.Fatal("owned descendant was still running after command returned")
	}
}

func TestSigningOwnedCommandDrainsSuccessfulOutput(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestSigningOutputFixture$")
	cmd.Env = append(os.Environ(), "PASSSHARE_SIGNING_OUTPUT_FIXTURE=1")
	var out boundedBuffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := runSigningCommand(ctx, cmd); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.buffer.String(), "owned-fixture-output") {
		t.Fatal("normal output did not drain")
	}
}

func TestSigningOutputFixture(t *testing.T) {
	if os.Getenv("PASSSHARE_SIGNING_OUTPUT_FIXTURE") == "" {
		t.Skip("subprocess fixture only")
	}
	fmt.Fprint(os.Stdout, "owned-fixture-output\n")
}
