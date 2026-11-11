package main

import (
	"strconv"
	"strings"
	"syscall"
	"testing"
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
