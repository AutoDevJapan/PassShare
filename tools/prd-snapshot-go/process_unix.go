//go:build !windows

package main

import (
	"errors"
	"os/exec"
	"syscall"
	"time"
)

func hideWindow(cmd *exec.Cmd) {}

func nativeCommand(name string) string { return name }

type processTree struct{ pid int }

func prepareTree(cmd *exec.Cmd) (*processTree, error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return &processTree{}, nil
}
func (t *processTree) started(cmd *exec.Cmd) error { t.pid = cmd.Process.Pid; return nil }
func (t *processTree) close()                      {}
func (t *processTree) stop() error {
	if t.pid == 0 {
		return nil
	}
	err := syscall.Kill(-t.pid, syscall.SIGKILL)
	if err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		active, err := processGroupActive(t.pid)
		if err != nil {
			return err
		}
		if !active {
			return nil
		}
		time.Sleep(5 * time.Millisecond)
	}
	return errors.New("owned process group did not terminate")
}
