//go:build darwin

package main

import (
	"encoding/binary"
	"os"
	"testing"
	"time"

	"github.com/krontek/hotswaplib/shmcmd"
)

// The macOS mirror is a plain file, so a test can create one exactly where the
// loader-host would and exercise the MAPPED reader the mailbox depends on.
func TestMirrorIsMappedAndMailboxCapable(t *testing.T) {
	dir := t.TempDir()
	if _, err := openShmMirror(dir, "/plc_runtime", 65536, false); err == nil {
		t.Fatal("opened a mirror that does not exist")
	}
	if err := os.WriteFile(mirrorPath(dir, "/plc_runtime"), make([]byte, 100), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := openShmMirror(dir, "/plc_runtime", 65536, false); err == nil {
		t.Fatal("mapped an undersized mirror (would SIGBUS past EOF)")
	}
	if err := os.Truncate(mirrorPath(dir, "/plc_runtime"), 65536); err != nil {
		t.Fatal(err)
	}
	w, err := openShmMirror(dir, "/plc_runtime", 65536, true)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	r, err := openShmMirror(dir, "/plc_runtime", 65536, false)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()

	// Writes through one mapping are visible through the other (MAP_SHARED).
	binary.LittleEndian.PutUint64(w.Bytes()[8:], 0x1122334455667788)
	var b [8]byte
	if err := r.ReadAt(b[:], 8); err != nil || binary.LittleEndian.Uint64(b[:]) != 0x1122334455667788 {
		t.Fatalf("read back %x, %v", b, err)
	}
	if err := r.ReadAt(b[:], 65530); err == nil {
		t.Fatal("out-of-bounds read accepted")
	}
	mb, err := shmcmd.New(w.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if err := mb.Probe(); shmcmd.KindOf(err) != shmcmd.KindNotReady {
		t.Fatalf("fresh mirror: %v", err)
	}
}

func TestShmAckTimeout(t *testing.T) {
	if d := shmAckTimeout(`{"shm_layout":{"max_task_interval_us":500000}}`); d != 1100*time.Millisecond {
		t.Fatalf("500 ms task: %v", d)
	}
	if d := shmAckTimeout(`{"tasks":[{"interval_us":10000000}]}`); d != 2*time.Second {
		t.Fatalf("10 s task: %v", d)
	}
	if d := shmAckTimeout(`not json`); d != shmcmd.DefaultTimeout {
		t.Fatalf("bad table: %v", d)
	}
}
