package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func holdChildForTest(t *testing.T, pidText []byte) func() bool {
	t.Helper()
	path := filepath.Join("/proc", strings.TrimSpace(string(pidText)), "stat")
	read := func() ([]string, error) {
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		end := strings.LastIndexByte(string(b), ')')
		if end < 0 {
			t.Fatal("invalid fixture proc stat")
		}
		fields := strings.Fields(string(b[end+1:]))
		if len(fields) < 20 {
			t.Fatal("incomplete fixture proc stat")
		}
		return fields, nil
	}
	first, err := read()
	if err != nil || first[0] == "Z" {
		t.Fatal("fixture process was not alive")
	}
	identity := first[19]
	return func() bool {
		now, err := read()
		if errors.Is(err, os.ErrNotExist) {
			return true
		}
		if err != nil {
			t.Fatal(err)
		}
		return now[19] != identity || now[0] == "Z" || now[0] == "X"
	}
}
