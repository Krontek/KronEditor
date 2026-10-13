//go:build !windows && !darwin

package main

import "os"

// shmMirrorPath: on Linux a POSIX shm object is just a file under /dev/shm, so
// the mapping in shmmirror_posix.go opens it by path. dir is the loader-host's
// working directory; unused here (the segment is named in the global /dev/shm
// namespace) — it exists for macOS, which backs the mirror with a real file
// next to the build output.
func shmMirrorPath(dir, name string) string { return "/dev/shm" + name }

// removeShmMirror drops a stale segment left by a previous run so a fresh cold
// start never reads another generation's values.
func removeShmMirror(dir, name string) { _ = os.Remove(shmMirrorPath(dir, name)) }
