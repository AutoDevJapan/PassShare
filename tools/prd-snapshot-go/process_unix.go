//go:build !windows

package main

import "os/exec"

func hideWindow(cmd *exec.Cmd) {}

func nativeCommand(name string) string { return name }
