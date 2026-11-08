//go:build windows

package service

import (
	"errors"
	"fmt"
	"io"
	"os/exec"
	"syscall"
	"time"
	"unsafe"
)

// runKeyValue reads the Mori value under the Run key, or returns
// ErrNotInstalled.
func runKeyValue() (string, error) {
	subkey, err := syscall.UTF16PtrFromString(`Software\Microsoft\Windows\CurrentVersion\Run`)
	if err != nil {
		return "", err
	}
	var k syscall.Handle
	if err := syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, subkey, 0, syscall.KEY_READ, &k); err != nil {
		if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
			return "", ErrNotInstalled
		}
		return "", fmt.Errorf("Run 키를 열지 못했습니다: %w", err)
	}
	defer syscall.RegCloseKey(k)
	name, err := syscall.UTF16PtrFromString(runValue)
	if err != nil {
		return "", err
	}
	var typ, n uint32
	if err := syscall.RegQueryValueEx(k, name, nil, &typ, nil, &n); err != nil {
		if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
			return "", ErrNotInstalled
		}
		return "", fmt.Errorf("Run 키의 %s 값을 읽지 못했습니다: %w", runValue, err)
	}
	if typ != syscall.REG_SZ && typ != syscall.REG_EXPAND_SZ {
		return "", fmt.Errorf("Run 키의 %s 값이 문자열이 아닙니다(형식 %d)", runValue, typ)
	}
	buf := make([]uint16, n/2+1) // the value may lack its NUL
	n = uint32(len(buf) * 2)
	if err := syscall.RegQueryValueEx(k, name, nil, &typ, (*byte)(unsafe.Pointer(&buf[0])), &n); err != nil {
		return "", fmt.Errorf("Run 키의 %s 값을 읽지 못했습니다: %w", runValue, err)
	}
	return syscall.UTF16ToString(buf), nil
}

// waitExit waits up to d for the process pid to end and reports whether it
// has. A process it cannot open counts as ended.
func waitExit(pid int, d time.Duration) bool {
	h, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return true
	}
	defer syscall.CloseHandle(h)
	ev, err := syscall.WaitForSingleObject(h, uint32(max(d, 0)/time.Millisecond))
	return err == nil && ev == syscall.WAIT_OBJECT_0
}

var (
	userenv                 = syscall.NewLazyDLL("userenv.dll") // a known system DLL, so it loads from System32
	createEnvironmentBlock  = userenv.NewProc("CreateEnvironmentBlock")
	destroyEnvironmentBlock = userenv.NewProc("DestroyEnvironmentBlock")
)

// loginEnv is the environment that Windows gives this user's programs at
// login, without what the shell that runs mori has added to its own: the
// server started now gets what the Run key's will, and so does the herdr
// core it starts, which keeps that environment for its sessions.
func loginEnv() ([]string, error) {
	proc, err := syscall.GetCurrentProcess()
	if err != nil {
		return nil, err
	}
	var token syscall.Token
	if err := syscall.OpenProcessToken(proc, syscall.TOKEN_QUERY|syscall.TOKEN_DUPLICATE, &token); err != nil {
		return nil, err
	}
	defer token.Close()
	var block *uint16
	if r, _, err := createEnvironmentBlock.Call(uintptr(unsafe.Pointer(&block)), uintptr(token), 0); r == 0 {
		return nil, err
	}
	defer destroyEnvironmentBlock.Call(uintptr(unsafe.Pointer(block)))
	// The block is NUL-terminated strings, then one more NUL; as Go's
	// own internal/syscall/windows/execenv reads it.
	var env []string
	const size = unsafe.Sizeof(*block)
	for p := block; *p != 0; {
		end := unsafe.Add(unsafe.Pointer(p), size)
		for *(*uint16)(end) != 0 {
			end = unsafe.Add(end, size)
		}
		entry := unsafe.Slice(p, (uintptr(end)-uintptr(unsafe.Pointer(p)))/size)
		env = append(env, syscall.UTF16ToString(entry))
		p = (*uint16)(unsafe.Add(end, size))
	}
	if len(env) == 0 {
		return nil, errors.New("환경 블록이 비어 있습니다")
	}
	return env, nil
}

const (
	detachedProcess        = 0x00000008
	createNewProcessGroup  = 0x00000200
	createBreakawayFromJob = 0x01000000
)

// startDetached starts exe with args as the Run key does at login: on its
// own, with no console, outside the job of this terminal, which may end
// what it started when it closes, in dir and with the login environment.
func startDetached(out io.Writer, exe string, args []string, dir string) error {
	env, err := loginEnv()
	if err != nil {
		fmt.Fprintf(out, "   주의: 로그인 환경을 만들지 못해 이 셸의 환경을 물려줍니다: %v\n", err)
		env = nil
	}
	start := func(flags uint32) error {
		cmd := exec.Command(exe, args...)
		cmd.Dir = dir
		cmd.Env = env
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags}
		if err := cmd.Start(); err != nil {
			return err
		}
		return cmd.Process.Release()
	}
	if start(detachedProcess|createNewProcessGroup|createBreakawayFromJob) == nil {
		return nil
	}
	if err := start(detachedProcess | createNewProcessGroup); err != nil { // the job forbids breaking away
		return fmt.Errorf("서버를 띄우지 못했습니다: %w", err)
	}
	fmt.Fprintln(out, "   주의: 이 터미널의 작업 개체에서 떼어 내지 못했습니다. 터미널을 닫으면 다음 로그인까지 서버가 멈출 수 있습니다")
	return nil
}
