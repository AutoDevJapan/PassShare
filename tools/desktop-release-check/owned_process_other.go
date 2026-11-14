//go:build !windows && !signingprocessred

package main

import (
	"os/exec"
)

// The existing non-Windows candidate path is unchanged. The Windows release
// path below owns its process tree before any signing child can execute.
type signingProcessTree struct{}

func prepareSigningTree(_ *exec.Cmd) (*signingProcessTree, error) {
	return &signingProcessTree{}, nil
}
func (*signingProcessTree) started(_ *exec.Cmd) error { return nil }
func (*signingProcessTree) stop() error              { return nil }
func (*signingProcessTree) close()                   {}
