//go:build windows && !signingprocessred

package main

import (
	"errors"
	"os/exec"
	"syscall"
	"time"
	"unsafe"
)

var signingKernel = syscall.NewLazyDLL("kernel32.dll")
var signingCreateJob = signingKernel.NewProc("CreateJobObjectW")
var signingSetJob = signingKernel.NewProc("SetInformationJobObject")
var signingAssignJob = signingKernel.NewProc("AssignProcessToJobObject")
var signingTerminateJob = signingKernel.NewProc("TerminateJobObject")
var signingQueryJob = signingKernel.NewProc("QueryInformationJobObject")
var signingThreadFirst = signingKernel.NewProc("Thread32First")
var signingThreadNext = signingKernel.NewProc("Thread32Next")
var signingOpenThread = signingKernel.NewProc("OpenThread")
var signingThreadProcess = signingKernel.NewProc("GetProcessIdOfThread")
var signingResumeThread = signingKernel.NewProc("ResumeThread")
var signingIsInJob = signingKernel.NewProc("IsProcessInJob")

type signingJobLimits struct {
	PerProcessUserTimeLimit, PerJobUserTimeLimit                                 int64
	LimitFlags                                                                   uint32
	MinimumWorkingSetSize, MaximumWorkingSetSize                                 uintptr
	ActiveProcessLimit                                                           uint32
	Affinity                                                                     uintptr
	PriorityClass, SchedulingClass                                               uint32
	IOReadOps, IOWriteOps, IOOtherOps, IOReadBytes, IOWriteBytes, IOOtherBytes   uint64
	ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed uintptr
}
type signingJobAccounting struct {
	TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime int64
	TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses     uint32
}
type signingThreadEntry struct {
	Size, Usage, ID, Owner      uint32
	BasePriority, DeltaPriority int32
	Flags                       uint32
}
type signingProcessTree struct {
	job syscall.Handle
	pid uint32
}

func prepareSigningTree(cmd *exec.Cmd) (*signingProcessTree, error) {
	h, _, err := signingCreateJob.Call(0, 0)
	if h == 0 {
		return nil, err
	}
	t := &signingProcessTree{job: syscall.Handle(h)}
	limits := signingJobLimits{LimitFlags: 0x2000}
	ok, _, err := signingSetJob.Call(h, 9, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	if ok == 0 {
		t.close()
		return nil, err
	}
	// No child code can execute or spawn before assignment to this job.
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000 | 0x00000004}
	return t, nil
}

func (t *signingProcessTree) started(cmd *exec.Cmd) error {
	t.pid = uint32(cmd.Process.Pid)
	process, err := syscall.OpenProcess(0x0100|0x0001|0x1000|0x00100000, false, t.pid)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(process)
	ok, _, err := signingAssignJob.Call(uintptr(t.job), uintptr(process))
	if ok == 0 {
		return err
	}
	snapshot, err := syscall.CreateToolhelp32Snapshot(0x00000004, 0)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(snapshot)
	entry := signingThreadEntry{Size: uint32(unsafe.Sizeof(signingThreadEntry{}))}
	ok, _, err = signingThreadFirst.Call(uintptr(snapshot), uintptr(unsafe.Pointer(&entry)))
	for ok != 0 {
		if entry.Owner == t.pid {
			thread, _, err := signingOpenThread.Call(0x0002|0x0800, 0, uintptr(entry.ID))
			if thread == 0 {
				return err
			}
			owner, _, _ := signingThreadProcess.Call(thread)
			if uint32(owner) != t.pid {
				syscall.CloseHandle(syscall.Handle(thread))
				return errors.New("suspended thread identity differs")
			}
			count, _, _ := signingResumeThread.Call(thread)
			syscall.CloseHandle(syscall.Handle(thread))
			if uint32(count) != 1 {
				return errors.New("primary thread was not exclusively suspended")
			}
			return nil
		}
		entry.Size = uint32(unsafe.Sizeof(entry))
		ok, _, err = signingThreadNext.Call(uintptr(snapshot), uintptr(unsafe.Pointer(&entry)))
	}
	return errors.New("suspended primary thread not found")
}

func (t *signingProcessTree) close() {
	if t.job != 0 {
		syscall.CloseHandle(t.job)
		t.job = 0
	}
}

func (t *signingProcessTree) stop() error {
	if t.job == 0 {
		return nil
	}
	var before signingJobAccounting
	ok, _, err := signingQueryJob.Call(uintptr(t.job), 1, uintptr(unsafe.Pointer(&before)), unsafe.Sizeof(before), 0)
	if ok == 0 {
		return err
	}
	var list struct {
		Assigned, Count uint32
		IDs             [1024]uintptr
	}
	ok, _, err = signingQueryJob.Call(uintptr(t.job), 3, uintptr(unsafe.Pointer(&list)), unsafe.Sizeof(list), 0)
	if ok == 0 {
		return err
	}
	if list.Count > uint32(len(list.IDs)) {
		return errors.New("signing process inventory exceeds limit")
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
		valid, _, e := signingIsInJob.Call(uintptr(handle), uintptr(t.job), uintptr(unsafe.Pointer(&owned)))
		if valid == 0 || owned == 0 {
			syscall.CloseHandle(handle)
			if valid == 0 {
				return e
			}
			return errors.New("process left its signing job scope")
		}
		handles = append(handles, handle)
	}
	ok, _, err = signingTerminateJob.Call(uintptr(t.job), 1)
	if ok == 0 {
		return err
	}
	until := time.Now().Add(5 * time.Second)
	for time.Now().Before(until) {
		var accounting signingJobAccounting
		ok, _, err = signingQueryJob.Call(uintptr(t.job), 1, uintptr(unsafe.Pointer(&accounting)), unsafe.Sizeof(accounting), 0)
		if ok == 0 {
			return err
		}
		if accounting.ActiveProcesses == 0 {
			for _, handle := range handles {
				remaining := time.Until(until).Milliseconds()
				if remaining < 0 {
					return errors.New("signing process signal deadline exceeded")
				}
				state, e := syscall.WaitForSingleObject(handle, uint32(remaining))
				if e != nil {
					return e
				}
				if state != syscall.WAIT_OBJECT_0 {
					return errors.New("signing process has not signaled exit")
				}
			}
			if accounting.TotalProcesses != before.TotalProcesses {
				return errors.New("signing process inventory changed during termination")
			}
			return nil
		}
		time.Sleep(5 * time.Millisecond)
	}
	return errors.New("signing job still has active processes")
}
