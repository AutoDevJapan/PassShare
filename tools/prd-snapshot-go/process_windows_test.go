package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func holdChildForTest(t *testing.T, pidText []byte) func() bool {
	t.Helper()
	pid, err := strconv.ParseUint(strings.TrimSpace(string(pidText)), 10, 32)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := syscall.OpenProcess(0x00100000|0x1000, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { syscall.CloseHandle(handle) })
	state, err := syscall.WaitForSingleObject(handle, 0)
	if err != nil || state != syscall.WAIT_TIMEOUT {
		t.Fatal("fixture child was not alive when its identity handle was captured")
	}
	return func() bool {
		state, err := syscall.WaitForSingleObject(handle, 0)
		if err != nil {
			t.Fatal(err)
		}
		return state == syscall.WAIT_OBJECT_0
	}
}

func TestChildSpawnDuringStopCannotPassAnIncompleteHandleInventory(t *testing.T) {
	dir := t.TempDir()
	trigger := filepath.Join(dir, "spawn")
	marker := filepath.Join(dir, "child")
	t.Setenv("PASSSHARE_PROCESS_FIXTURE", "parent")
	t.Setenv("PASSSHARE_PROCESS_MARKER", marker)
	t.Setenv("PASSSHARE_SPAWN_TRIGGER", trigger)
	cmd := exec.Command(os.Args[0], "-test.run=^TestOwnedProcessFixture$")
	tree, err := prepareTree(cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer tree.close()
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	if err = tree.started(cmd); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.Fatal(err)
	}
	until := time.Now().Add(5 * time.Second)
	for {
		if _, e := os.Stat(trigger + ".parent-ready"); e == nil {
			break
		}
		if time.Now().After(until) {
			t.Fatal("parent spawn barrier missing")
		}
		time.Sleep(time.Millisecond)
	}
	var exited func() bool
	tree.beforeTerminate = func() {
		if err := os.WriteFile(trigger, []byte("spawn now"), 0600); err != nil {
			t.Fatal(err)
		}
		until := time.Now().Add(5 * time.Second)
		for {
			pid, e := os.ReadFile(marker + ".ready")
			if e == nil {
				exited = holdChildForTest(t, pid)
				return
			}
			if time.Now().After(until) {
				t.Fatal("late child missing")
			}
			time.Sleep(time.Millisecond)
		}
	}
	err = tree.stop()
	_ = cmd.Wait()
	if err == nil {
		t.Fatal("late child was not in held handles but recovery was declared complete")
	}
	if exited == nil {
		t.Fatal("late child was not exercised")
	}
	until = time.Now().Add(5 * time.Second)
	for !exited() {
		if time.Now().After(until) {
			t.Fatal("owned late child cleanup did not complete")
		}
		time.Sleep(time.Millisecond)
	}
	// Closing the owned job still requests cleanup; the return value honestly
	// refuses credential deletion because that late child's signal was unproven.
}
