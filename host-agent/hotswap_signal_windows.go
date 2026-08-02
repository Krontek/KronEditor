//go:build windows

package main

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// swapEventName must match PLC_SWAP_EVENT_NAME in hotswaphost/host.c.
const swapEventName = `Local\kron_plc_swap`

// sendSwapSignal tells the running loader-host to perform an online change.
//
// Windows has no SIGUSR1, so the loader-host creates a named auto-reset Event
// and parks a thread on it; signalling that event sets the same g_swap_req flag
// the Linux SIGUSR1 handler sets, and the scan loop underneath is identical.
//
// ⚠️ We OPEN the event, never create it. If the agent created it, a signal sent
// before the host was up would be silently latched by the auto-reset event and
// the swap would look accepted while nothing had loaded the new logic. Failing
// with "is the simulation running?" is the honest answer, and the caller's
// swap_result poll reports it.
//
// pid is unused on Windows — the event is per-session and only one local
// simulation runs at a time.
func sendSwapSignal(pid int) error {
	_ = pid
	np, err := windows.UTF16PtrFromString(swapEventName)
	if err != nil {
		return err
	}
	h, err := windows.OpenEvent(windows.EVENT_MODIFY_STATE, false, np)
	if err != nil {
		return fmt.Errorf("loader-host swap event not available (is the simulation running?): %w", err)
	}
	defer windows.CloseHandle(h)
	if err := windows.SetEvent(h); err != nil {
		return fmt.Errorf("signal loader-host: %w", err)
	}
	return nil
}
