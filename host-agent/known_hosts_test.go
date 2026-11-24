package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A re-trusted key (device reinstalled) must land on its OWN line: removing the
// stale entry used to strip the file's final newline, so the appended key was
// glued onto the last kept entry and knownhosts.New failed on every deploy.
func TestKnownHostsRetrustKeepsLinesSeparate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	if err := os.WriteFile(path, []byte("10.0.0.1 ssh-ed25519 AAAA1\n10.0.0.3 ssh-ed25519 OLDKEY\n10.0.0.2 ssh-ed25519 AAAA2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := removeKnownHostsEntry(path, "10.0.0.3"); err != nil {
		t.Fatal(err)
	}
	if err := appendKnownHostsLine(path, "10.0.0.3 ssh-ed25519 NEWKEY"); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	want := "10.0.0.1 ssh-ed25519 AAAA1\n10.0.0.2 ssh-ed25519 AAAA2\n10.0.0.3 ssh-ed25519 NEWKEY\n"
	if string(got) != want {
		t.Fatalf("known_hosts after re-trust:\n%q\nwant\n%q", got, want)
	}
}

// An append to a file whose last line lacks a newline terminates it first.
func TestKnownHostsAppendTerminatesLastLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	_ = os.WriteFile(path, []byte("10.0.0.1 ssh-ed25519 AAAA1"), 0o600)
	if err := appendKnownHostsLine(path, "10.0.0.2 ssh-ed25519 AAAA2"); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	if lines := strings.Split(strings.TrimRight(string(got), "\n"), "\n"); len(lines) != 2 {
		t.Fatalf("want 2 lines, got %q", got)
	}
}
