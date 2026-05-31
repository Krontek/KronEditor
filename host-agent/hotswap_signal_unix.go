//go:build !windows

package main

import "syscall"

// sendSwapSignal tells the running loader-host to perform an online change by
// raising SIGUSR1 (it has already read the new .so path from swap_request).
func sendSwapSignal(pid int) error {
	return syscall.Kill(pid, syscall.SIGUSR1)
}
