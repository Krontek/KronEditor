package main

import (
	"slices"
	"sort"
	"time"

	"github.com/krontek/hotswaplib/shmcmd"
)

// forcedEventKey is the reserved key carrying the FORCED set: a sorted JSON
// array of variable keys. KronServer puts it inside each /stream/vars event;
// the local hot-swap sim puts it beside "vars" in a simulation-output event
// ({"vars": {...}, "__forced": [...]}) so it never reaches the HMI feed as a
// variable. Same semantics in both: sent on a stream's first event, whenever
// the set changes (an empty array = nothing forced any more) and at least
// every forcedResendEvery; absent = unchanged.
const forcedEventKey = "__forced"

const forcedResendEvery = 2 * time.Second

// forcedTracker decides when an event carries the forced set (see above).
type forcedTracker struct {
	last     []string
	sent     bool
	lastSent time.Time
}

func (t *forcedTracker) next(cur []string, now time.Time) ([]string, bool) {
	if t.sent && slices.Equal(cur, t.last) && now.Sub(t.lastSent) < forcedResendEvery {
		return nil, false
	}
	if cur == nil {
		cur = []string{}
	}
	t.last, t.sent, t.lastSent = cur, true, now
	return cur, true
}

// readForcedKeys reads each spec's force-flag byte (RUNTIME-owned — read only,
// one byte load each) and returns the keys whose flag marks a held value. ALL
// specs, never the editor's subscription: the force list must show every
// forced variable. ok is false when no flag byte could be read at all.
func readForcedKeys(read func(b []byte, off int64) error, specs []ShmSpec) (keys []string, ok bool) {
	keys = []string{}
	var b [1]byte
	for _, sp := range specs {
		if sp.ForceOff < shmcmd.ForceFlagsBase || sp.ForceOff >= shmcmd.MailboxBase {
			continue
		}
		if err := read(b[:], int64(sp.ForceOff)); err != nil {
			continue
		}
		ok = true
		if shmcmd.FlagIsForced(b[0]) {
			keys = append(keys, sp.Key)
		}
	}
	sort.Strings(keys)
	return keys, ok
}

// specsHaveFlags reports whether any spec carries a force-flag byte (a table
// from before force flags has none — nothing to watch then).
func specsHaveFlags(specs []ShmSpec) bool {
	for _, sp := range specs {
		if sp.ForceOff >= shmcmd.ForceFlagsBase && sp.ForceOff < shmcmd.MailboxBase {
			return true
		}
	}
	return false
}
