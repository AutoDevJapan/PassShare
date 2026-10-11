//go:build !windows

package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestTerminationSignalRunsRegisteredKeyCleanup(t *testing.T) {
	if os.Getenv("PASSSHARE_SNAPSHOT_SIGNAL_TEST") == "1" {
		ctx, stop := terminationContext()
		defer stop()
		f := &fake{root: t.TempDir()}
		run := func(ctx context.Context, name string, args ...string) ([]byte, error) {
			if name == "railway" && args[0] == "ssh" {
				if err := syscall.Kill(os.Getpid(), syscall.SIGTERM); err != nil {
					t.Fatal(err)
				}
				<-ctx.Done()
				return nil, ctx.Err()
			}
			if ctx.Err() != nil {
				t.Fatal("cleanup context is cancelled")
			}
			return f.run(ctx, name, args...)
		}
		if snapshot(ctx, filepath.Join(t.TempDir(), "snapshot.dump"), run, "") == nil || f.created != 1 || f.revoked != 1 {
			t.Fatal("SIGTERM bypassed registered key cleanup")
		}
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestTerminationSignalRunsRegisteredKeyCleanup$")
	cmd.Env = append(os.Environ(), "PASSSHARE_SNAPSHOT_SIGNAL_TEST=1")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("signal subprocess failed: %v\n%s", err, output)
	}
}
