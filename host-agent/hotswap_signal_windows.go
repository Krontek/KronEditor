//go:build windows

package main

import "errors"

// sendSwapSignal is unavailable on Windows: the hot-swap loader-host relies on
// SIGUSR1 and the /dev/shm mirror, both Linux-only (same reason local simulation
// is Linux-only). The build compiles so the editor + Build & Send ship on Windows;
// only the local hot-swap session is disabled here.
func sendSwapSignal(pid int) error {
	return errors.New("hot-swap is not supported on Windows (Linux-only)")
}
