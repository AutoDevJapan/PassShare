//go:build !windows && !linux

package main

import (
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

func holdChildForTest(t *testing.T, pidText []byte) func() bool {
	pid, err := strconv.Atoi(strings.TrimSpace(string(pidText)))
	if err != nil {
		t.Fatal(err)
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Release() })
	return func() bool { return p.Signal(syscall.Signal(0)) != nil }
}
