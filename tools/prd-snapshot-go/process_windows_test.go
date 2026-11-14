package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

var fixtureLock = syscall.NewLazyDLL("kernel32.dll").NewProc("LockFileEx")
var fixtureUnlock = syscall.NewLazyDLL("kernel32.dll").NewProc("UnlockFileEx")

func TestFixturePIDWaitsForAnActualByteLock(t *testing.T) {
	if os.Getenv("PASSSHARE_READY_LOCK_HOLDER") == "true" {
		name, err := syscall.UTF16PtrFromString(os.Getenv("PASSSHARE_READY_LOCK_PATH"))
		if err != nil {
			os.Exit(7)
		}
		handle, err := syscall.CreateFile(name, syscall.GENERIC_READ, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
		if err != nil {
			os.Exit(7)
		}
		var offset syscall.Overlapped
		locked, _, _ := fixtureLock.Call(uintptr(handle), 3, 0, 4, 0, uintptr(unsafe.Pointer(&offset)))
		if locked == 0 {
			_ = syscall.CloseHandle(handle)
			os.Exit(7)
		}
		var info syscall.ByHandleFileInformation
		if syscall.GetFileInformationByHandle(handle, &info) != nil {
			os.Exit(7)
		}
		if _, probeErr := readFixturePIDFile(os.Getenv("PASSSHARE_READY_LOCK_PATH")); !errors.Is(probeErr, syscall.Errno(33)) {
			fmt.Fprintf(os.Stdout, "fixture-lock-unconfirmed: %v\n", probeErr)
			_ = syscall.CloseHandle(handle)
			os.Exit(7)
		}
		fmt.Fprintf(os.Stdout, "fixture-lock-held:%d:%x:%x:%x\n", os.Getpid(), info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow)
		var release [1]byte
		_, err = os.Stdin.Read(release[:])
		unlocked, _, _ := fixtureUnlock.Call(uintptr(handle), 0, 4, 0, uintptr(unsafe.Pointer(&offset)))
		_ = syscall.CloseHandle(handle)
		if err != nil || release[0] != 'R' || unlocked == 0 {
			os.Exit(7)
		}
		os.Exit(0)
	}
	path := filepath.Join(t.TempDir(), "late.ready")
	if err := os.WriteFile(path, []byte("1234"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestFixturePIDWaitsForAnActualByteLock$")
	hideWindow(cmd)
	cmd.Env = append(os.Environ(), "PASSSHARE_READY_LOCK_HOLDER=true", "PASSSHARE_READY_LOCK_PATH="+path)
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		t.Fatal(err)
	}
	cmd.WaitDelay = 500 * time.Millisecond
	if err := cmd.Start(); err != nil {
		input.Close()
		output.Close()
		t.Fatal(err)
	}
	waited := false
	defer func() {
		cancel()
		_ = input.Close()
		_ = output.Close()
		if !waited {
			_ = cmd.Wait()
		}
	}()
	line, err := bufio.NewReader(output).ReadString('\n')
	var holderPID uint32
	var holderInfo syscall.ByHandleFileInformation
	count, parseErr := fmt.Sscanf(strings.TrimSpace(line), "fixture-lock-held:%d:%x:%x:%x", &holderPID, &holderInfo.VolumeSerialNumber, &holderInfo.FileIndexHigh, &holderInfo.FileIndexLow)
	if err != nil || parseErr != nil || count != 4 || holderPID != uint32(cmd.Process.Pid) {
		t.Fatalf("real holder did not lock file: %q %v", line, err)
	}
	exited := holdChildForTest(t, []byte(fmt.Sprint(holderPID)))
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	var observedInfo syscall.ByHandleFileInformation
	infoErr := syscall.GetFileInformationByHandle(syscall.Handle(f.Fd()), &observedInfo)
	closeErr := f.Close()
	if infoErr != nil || closeErr != nil || observedInfo.VolumeSerialNumber != holderInfo.VolumeSerialNumber || observedInfo.FileIndexHigh != holderInfo.FileIndexHigh || observedInfo.FileIndexLow != holderInfo.FileIndexLow {
		t.Fatal("holder and readiness reader do not identify the same file")
	}
	type result struct {
		pid []byte
		err error
	}
	done := make(chan result, 1)
	attempted := make(chan error, 1)
	readerJoined := false
	defer func() {
		cancel()
		if !readerJoined {
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Error("fixture PID reader did not drain")
			}
		}
	}()
	go func() {
		pid, err := readFixturePIDWith(ctx, path, func(name string) ([]byte, error) {
			data, err := readFixturePIDFile(name)
			select {
			case attempted <- err:
			default:
			}
			return data, err
		})
		done <- result{pid, err}
	}()
	select {
	case err := <-attempted:
		if !errors.Is(err, syscall.Errno(33)) {
			t.Fatalf("real byte-lock conflict not reached: %v holder_exited=%v", err, exited())
		}
	case <-ctx.Done():
		t.Fatal("fixture reader did not attempt the held file")
	}
	select {
	case r := <-done:
		readerJoined = true
		t.Fatalf("ready read completed while the real file was locked: %q %v", r.pid, r.err)
	case <-time.After(25 * time.Millisecond):
	}
	if _, err := input.Write([]byte("R")); err != nil {
		t.Fatal(err)
	}
	_ = input.Close()
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	waited = true
	if !exited() {
		t.Fatal("fixture holder still alive after Wait")
	}
	select {
	case r := <-done:
		readerJoined = true
		if r.err != nil || string(r.pid) != "1234" {
			t.Fatalf("ready PID after unlock: %q %v", r.pid, r.err)
		}
	case <-ctx.Done():
		t.Fatal("ready reader did not recover after lock release")
	}
}

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
