package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func readFixturePID(ctx context.Context, path string) ([]byte, error) {
	return readFixturePIDWith(ctx, path, os.ReadFile)
}

func readFixturePIDWith(ctx context.Context, path string, read func(string) ([]byte, error)) ([]byte, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		data, err := read(path)
		if err == nil {
			pid, parseErr := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 32)
			if parseErr != nil || pid == 0 {
				return nil, fmt.Errorf("invalid fixture PID")
			}
			return data, nil
		}
		// Atomic publication prevents partial PID data, but another Windows process can
		// briefly hold the published name without FILE_SHARE_READ.
		sharing := runtime.GOOS == "windows" && (errors.Is(err, syscall.Errno(32)) || errors.Is(err, syscall.Errno(33)))
		if !os.IsNotExist(err) && !sharing {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Millisecond):
		}
	}
}

func TestFixturePIDReadRejectsInvalidDataAndBoundsMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ready")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := readFixturePID(ctx, path); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("missing fixture did not honor deadline: %v", err)
	}
	if err := os.WriteFile(path, []byte("not-a-pid"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readFixturePID(context.Background(), path); err == nil {
		t.Fatal("invalid fixture PID accepted")
	}
	if _, err := readFixturePID(ctx, path); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("expired read consumed ready file")
	}
}

// This is an actual child/grandchild with inherited pipes, not a fake runner.
func TestOwnedProcessFixture(t *testing.T) {
	mode := os.Getenv("PASSSHARE_PROCESS_FIXTURE")
	if mode == "" {
		t.Skip("subprocess fixture only")
	}
	marker := os.Getenv("PASSSHARE_PROCESS_MARKER")
	if mode == "parent" {
		if os.Getenv("PASSSHARE_SPAWN_TRIGGER") != "" {
			trigger := os.Getenv("PASSSHARE_SPAWN_TRIGGER")
			_ = os.WriteFile(trigger+".parent-ready", []byte("ready"), 0600)
			until := time.Now().Add(5 * time.Second)
			for {
				if _, err := os.Stat(trigger); err == nil {
					break
				}
				if time.Now().After(until) {
					os.Exit(8)
				}
				time.Sleep(time.Millisecond)
			}
		}
		child := exec.Command(os.Args[0], "-test.run=^TestOwnedProcessFixture$")
		hideWindow(child)
		child.Env = append(os.Environ(), "PASSSHARE_PROCESS_FIXTURE=grandchild")
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		if err := child.Start(); err != nil {
			os.Exit(3)
		}
		if os.Getenv("PASSSHARE_PARENT_EXITS") == "true" {
			os.Exit(0)
		}
		_ = child.Wait()
		os.Exit(0)
	}
	if mode == "grandchild" {
		if os.WriteFile(marker+".ready.pending", []byte(fmt.Sprint(os.Getpid())), 0600) != nil {
			os.Exit(4)
		}
		if os.Rename(marker+".ready.pending", marker+".ready") != nil {
			os.Exit(4)
		}
		if os.Getenv("PASSSHARE_LINGER_CHILD") == "true" {
			time.Sleep(4500 * time.Millisecond)
		} else {
			time.Sleep(1200 * time.Millisecond)
		}
		if os.WriteFile(marker, []byte("late child still ran"), 0600) != nil {
			os.Exit(5)
		}
		fmt.Fprint(os.Stdout, "child-complete\n")
		fmt.Fprint(os.Stderr, "private-final-diagnostic\n")
		os.Exit(0)
	}
	os.Exit(6)
}

func TestExecuteDeadlineStopsRealDescendants(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "deadline")
	t.Setenv("PASSSHARE_PROCESS_FIXTURE", "parent")
	t.Setenv("PASSSHARE_PROCESS_MARKER", marker)
	t.Setenv("PASSSHARE_LINGER_CHILD", "true")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := execute(ctx, os.Args[0], "-test.run=^TestOwnedProcessFixture$")
	if err == nil {
		t.Fatal("deadline accepted as success")
	}
	if _, err := os.Stat(marker + ".ready"); err != nil {
		t.Fatal("deadline test never exercised a real descendant")
	}
	time.Sleep(2800 * time.Millisecond)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("descendant outlived deadline return")
	}
}

func TestExitedParentCannotLeavePipeHoldingDescendantAfterReturn(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "parent-exited")
	t.Setenv("PASSSHARE_PROCESS_FIXTURE", "parent")
	t.Setenv("PASSSHARE_PROCESS_MARKER", marker)
	t.Setenv("PASSSHARE_PARENT_EXITS", "true")
	t.Setenv("PASSSHARE_LINGER_CHILD", "true")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := execute(ctx, os.Args[0], "-test.run=^TestOwnedProcessFixture$")
	if err == nil {
		t.Fatal("parent exit with incomplete pipe drain accepted")
	}
	time.Sleep(1600 * time.Millisecond)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("pipe-holding descendant remained after failed drain")
	}
}

func TestExecuteCancellationStopsGrandchildBeforeReturnAndBeforeKeyRevocation(t *testing.T) {
	for _, parentExits := range []bool{false, true} {
		t.Run(fmt.Sprint(parentExits), func(t *testing.T) {
			marker := filepath.Join(t.TempDir(), "late")
			t.Setenv("PASSSHARE_PROCESS_FIXTURE", "parent")
			t.Setenv("PASSSHARE_PROCESS_MARKER", marker)
			t.Setenv("PASSSHARE_PARENT_EXITS", fmt.Sprint(parentExits))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			finished := make(chan error, 1)
			go func() { _, err := execute(ctx, os.Args[0], "-test.run=^TestOwnedProcessFixture$"); finished <- err }()
			joined := false
			defer func() {
				cancel()
				if !joined {
					select {
					case <-finished:
					case <-time.After(8 * time.Second):
						t.Error("owned fixture did not drain after failed readiness")
					}
				}
			}()
			readyCtx, readyCancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer readyCancel()
			pidText, err := readFixturePID(readyCtx, marker+".ready")
			if err != nil {
				t.Fatal(err)
			}
			exited := holdChildForTest(t, pidText)
			cancel()
			err = <-finished
			joined = true
			if err == nil {
				t.Fatal("cancelled process accepted as successful")
			}
			if !exited() {
				t.Fatal("owned child was still running when execute returned")
			}
			// Simulated credential revocation happens only after execute has returned.
			// The real child must not be able to mutate anything after that boundary.
			time.Sleep(1400 * time.Millisecond)
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatal("real grandchild survived execute and credential cleanup boundary")
			}
		})
	}
}

func TestSnapshotRevokesOnlyAfterRealSSHDescendantsAndReadersFinish(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "ssh-child")
	t.Setenv("PASSSHARE_PROCESS_FIXTURE", "parent")
	t.Setenv("PASSSHARE_PROCESS_MARKER", marker)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f := &fake{root: t.TempDir()}
	out := filepath.Join(t.TempDir(), "snapshot.dump")
	executionReturned := false
	run := func(c context.Context, name string, args ...string) ([]byte, error) {
		if name == "railway" && args[0] == "ssh" {
			done := make(chan struct{})
			go func() {
				defer close(done)
				until := time.Now().Add(5 * time.Second)
				for time.Now().Before(until) {
					if _, err := os.Stat(marker + ".ready"); err == nil {
						cancel()
						return
					}
					time.Sleep(time.Millisecond)
				}
				cancel()
			}()
			_, err := execute(c, os.Args[0], "-test.run=^TestOwnedProcessFixture$")
			<-done
			executionReturned = true
			return nil, err
		}
		if name == "railway" && args[0] == "api" {
			query, err := os.ReadFile(args[2])
			if err != nil {
				return nil, err
			}
			if strings.Contains(string(query), "sshPublicKeyDelete") && !executionReturned {
				t.Fatal("key revocation preceded process/output completion")
			}
		}
		return f.run(c, name, args...)
	}
	if snapshot(ctx, out, run, "") == nil || f.revoked != 1 {
		t.Fatal("cancelled SSH skipped recovery or revocation")
	}
	time.Sleep(1400 * time.Millisecond)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("SSH descendant mutated data after key revocation")
	}
}

func TestExecuteNormalCompletionDrainsGrandchildOutput(t *testing.T) {
	t.Setenv("PASSSHARE_PROCESS_FIXTURE", "parent")
	t.Setenv("PASSSHARE_PROCESS_MARKER", filepath.Join(t.TempDir(), "complete"))
	t.Setenv("PASSSHARE_PARENT_EXITS", "false")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := execute(ctx, os.Args[0], "-test.run=^TestOwnedProcessFixture$")
	if err != nil || !strings.Contains(string(out), "child-complete") || strings.Contains(string(out), "private-final-diagnostic") {
		t.Fatalf("child output was not completely/private drained: %v", err)
	}
}
