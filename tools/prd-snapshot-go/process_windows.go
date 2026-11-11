package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"
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

var jobKernel = syscall.NewLazyDLL("kernel32.dll")
var createJob = jobKernel.NewProc("CreateJobObjectW")
var setJob = jobKernel.NewProc("SetInformationJobObject")
var assignJob = jobKernel.NewProc("AssignProcessToJobObject")
var terminateJob = jobKernel.NewProc("TerminateJobObject")
var queryJob = jobKernel.NewProc("QueryInformationJobObject")
var threadFirst = jobKernel.NewProc("Thread32First")
var threadNext = jobKernel.NewProc("Thread32Next")
var openThread = jobKernel.NewProc("OpenThread")
var threadProcess = jobKernel.NewProc("GetProcessIdOfThread")
var resumeThread = jobKernel.NewProc("ResumeThread")
var isInJob = jobKernel.NewProc("IsProcessInJob")

type jobLimits struct {
	PerProcessUserTimeLimit, PerJobUserTimeLimit                                 int64
	LimitFlags                                                                   uint32
	MinimumWorkingSetSize, MaximumWorkingSetSize                                 uintptr
	ActiveProcessLimit                                                           uint32
	Affinity                                                                     uintptr
	PriorityClass, SchedulingClass                                               uint32
	IOReadOps, IOWriteOps, IOOtherOps, IOReadBytes, IOWriteBytes, IOOtherBytes   uint64
	ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed uintptr
}
type jobAccounting struct {
	TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime int64
	TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses     uint32
}
type threadEntry struct {
	Size, Usage, ID, Owner      uint32
	BasePriority, DeltaPriority int32
	Flags                       uint32
}
type processTree struct {
	job syscall.Handle
	pid uint32
}

func prepareTree(cmd *exec.Cmd) (*processTree, error) {
	handle, _, err := createJob.Call(0, 0)
	if handle == 0 {
		return nil, err
	}
	t := &processTree{job: syscall.Handle(handle)}
	limits := jobLimits{LimitFlags: 0x2000} // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	ok, _, err := setJob.Call(handle, 9, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	if ok == 0 {
		t.close()
		return nil, err
	}
	// The primary thread cannot create SSH descendants before assignment.
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000 | 0x00000004}
	return t, nil
}
func (t *processTree) started(cmd *exec.Cmd) error {
	t.pid = uint32(cmd.Process.Pid)
	process, err := syscall.OpenProcess(0x0100|0x0001|0x1000|0x00100000, false, t.pid)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(process)
	ok, _, err := assignJob.Call(uintptr(t.job), uintptr(process))
	if ok == 0 {
		return err
	}
	snapshot, err := syscall.CreateToolhelp32Snapshot(0x00000004, 0)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(snapshot)
	entry := threadEntry{Size: uint32(unsafe.Sizeof(threadEntry{}))}
	ok, _, err = threadFirst.Call(uintptr(snapshot), uintptr(unsafe.Pointer(&entry)))
	for ok != 0 {
		if entry.Owner == t.pid {
			thread, _, err := openThread.Call(0x0002|0x0800, 0, uintptr(entry.ID))
			if thread == 0 {
				return err
			}
			owner, _, _ := threadProcess.Call(thread)
			if uint32(owner) != t.pid {
				syscall.CloseHandle(syscall.Handle(thread))
				return errors.New("primary thread identity differs")
			}
			count, _, _ := resumeThread.Call(thread)
			syscall.CloseHandle(syscall.Handle(thread))
			if uint32(count) != 1 {
				return errors.New("primary thread was not exclusively suspended")
			}
			return nil
		}
		entry.Size = uint32(unsafe.Sizeof(entry))
		ok, _, err = threadNext.Call(uintptr(snapshot), uintptr(unsafe.Pointer(&entry)))
	}
	return errors.New("suspended primary thread not found")
}
func (t *processTree) close() {
	if t.job != 0 {
		syscall.CloseHandle(t.job)
		t.job = 0
	}
}
func (t *processTree) stop() error {
	if t.job == 0 {
		return nil
	}
	// Keep synchronization handles opened while each PID is still a verified
	// member. ActiveProcesses=0 alone can precede the process's final signal.
	var list struct {
		Assigned, Count uint32
		IDs             [1024]uintptr
	}
	ok, _, err := queryJob.Call(uintptr(t.job), 3, uintptr(unsafe.Pointer(&list)), unsafe.Sizeof(list), 0)
	if ok == 0 {
		return err
	}
	if list.Count > uint32(len(list.IDs)) {
		return errors.New("owned process inventory exceeds limit")
	}
	handles := make([]syscall.Handle, 0, list.Count)
	defer func() {
		for _, handle := range handles {
			syscall.CloseHandle(handle)
		}
	}()
	for _, id := range list.IDs[:list.Count] {
		handle, e := syscall.OpenProcess(0x00100000|0x1000, false, uint32(id))
		if e == syscall.Errno(87) {
			continue
		}
		if e != nil {
			return e
		}
		var owned int32
		valid, _, e := isInJob.Call(uintptr(handle), uintptr(t.job), uintptr(unsafe.Pointer(&owned)))
		if valid == 0 {
			syscall.CloseHandle(handle)
			return e
		}
		if owned == 0 {
			syscall.CloseHandle(handle)
			return errors.New("process left its owned job scope")
		}
		handles = append(handles, handle)
	}
	ok, _, err = terminateJob.Call(uintptr(t.job), 1)
	if ok == 0 {
		return err
	}
	until := time.Now().Add(5 * time.Second)
	for time.Now().Before(until) {
		var accounting jobAccounting
		ok, _, err = queryJob.Call(uintptr(t.job), 1, uintptr(unsafe.Pointer(&accounting)), unsafe.Sizeof(accounting), 0)
		if ok == 0 {
			return err
		}
		if accounting.ActiveProcesses == 0 {
			for _, handle := range handles {
				remaining := time.Until(until).Milliseconds()
				if remaining < 0 {
					return errors.New("owned process signal deadline exceeded")
				}
				state, e := syscall.WaitForSingleObject(handle, uint32(remaining))
				if e != nil {
					return e
				}
				if state != syscall.WAIT_OBJECT_0 {
					return errors.New("owned process has not signaled exit")
				}
			}
			return nil
		}
		time.Sleep(5 * time.Millisecond)
	}
	return errors.New("owned job still has active processes")
}
