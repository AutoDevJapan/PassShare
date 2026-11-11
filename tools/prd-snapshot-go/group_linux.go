package main

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Zombies have exited and cannot hold pipes or execute. Their original parent
// or the system reaper owns wait/reaping; do not mistake them for live work.
func processGroupActive(group int) (bool, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return false, err
	}
	for _, entry := range entries {
		if _, err := strconv.Atoi(entry.Name()); err != nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "stat"))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return false, err
		}
		end := strings.LastIndexByte(string(data), ')')
		if end < 0 {
			return false, errors.New("invalid process status")
		}
		fields := strings.Fields(string(data[end+1:]))
		if len(fields) < 3 {
			return false, errors.New("incomplete process status")
		}
		pgid, err := strconv.Atoi(fields[2])
		if err != nil {
			return false, err
		}
		if pgid == group && fields[0] != "Z" && fields[0] != "X" {
			return true, nil
		}
	}
	return false, nil
}
