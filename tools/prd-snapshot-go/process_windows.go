package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

func nativeCommand(name string) string {
	if name == "railway" {
		if shim, err := exec.LookPath(name); err == nil {
			vendor := filepath.Join(filepath.Dir(shim), "node_modules", "@railway", "cli", "bin", "railway.exe")
			if info, err := os.Stat(vendor); err == nil && info.Mode().IsRegular() {
				return vendor
			}
		}
	}
	return name
}

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
