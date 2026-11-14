//go:build windows

package main

import (
	"syscall"
	"testing"
)

// Keep the original process handle from before cancellation. A later PID-only
// query could accidentally observe a recycled process.
func signingFixtureChildExit(t *testing.T, pid uint32) func() bool {
	t.Helper()
	h, err := syscall.OpenProcess(0x00100000|0x1000|0x0001, false, pid)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		state, waitErr := syscall.WaitForSingleObject(h, 0)
		if waitErr == nil && state == syscall.WAIT_TIMEOUT {
			if err := syscall.TerminateProcess(h, 1); err != nil {
				t.Errorf("owned child cleanup: %v", err)
			} else if state, err := syscall.WaitForSingleObject(h, 5000); err != nil || state != syscall.WAIT_OBJECT_0 {
				t.Error("owned child cleanup did not signal")
			}
		} else if waitErr != nil {
			t.Errorf("owned child cleanup wait: %v", waitErr)
		}
		_ = syscall.CloseHandle(h)
	})
	state, err := syscall.WaitForSingleObject(h, 0)
	if err != nil || state != syscall.WAIT_TIMEOUT {
		t.Fatal("owned child was not live at the cancellation barrier")
	}
	return func() bool {
		state, err := syscall.WaitForSingleObject(h, 0)
		if err != nil {
			t.Fatal(err)
		}
		return state == syscall.WAIT_OBJECT_0
	}
}
