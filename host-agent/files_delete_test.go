package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// delete-file is the one endpoint that destroys data, so its containment is
// tested rather than assumed: read-file/write-file take any absolute path, and
// the whole point of this handler is that it does NOT.
func deleteSrv(t *testing.T) (*Server, string) {
	t.Helper()
	root := t.TempDir()
	// The handler is scoped to <AppDataDir>/esi, which the ESI library creates.
	if err := os.MkdirAll(filepath.Join(root, "esi"), 0o755); err != nil {
		t.Fatal(err)
	}
	return &Server{paths: &Paths{AppDataDir: root}}, root
}

func callDelete(t *testing.T, s *Server, path string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"path": path})
	req := httptest.NewRequest(http.MethodPost, "/api/host/delete-file", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	s.handleDeleteFile(rec, req)
	return rec
}

func TestDeleteFileRemovesInsideAppData(t *testing.T) {
	s, root := deleteSrv(t)
	esi := filepath.Join(root, "esi")
	if err := os.MkdirAll(esi, 0o755); err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(esi, "D5V120E.xml")
	if err := os.WriteFile(f, []byte("<esi/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if rec := callDelete(t, s, f); rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body)
	}
	if _, err := os.Stat(f); !os.IsNotExist(err) {
		t.Fatal("file survived the delete")
	}
}

func TestDeleteFileRefusesOutsideAppData(t *testing.T) {
	s, _ := deleteSrv(t)
	outside := filepath.Join(t.TempDir(), "precious.xml")
	if err := os.WriteFile(outside, []byte("keep me"), 0o644); err != nil {
		t.Fatal(err)
	}
	if rec := callDelete(t, s, outside); rec.Code != http.StatusForbidden {
		t.Fatalf("want 403, got %d: %s", rec.Code, rec.Body)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatal("a file outside the app data dir was deleted")
	}
}

// ".." must be resolved before the containment test, not after.
// ⚠️ The path is built by string CONCATENATION: filepath.Join would Clean the
// ".." away before the request was even sent, testing nothing.
func TestDeleteFileRefusesTraversal(t *testing.T) {
	s, root := deleteSrv(t)
	outside := filepath.Join(t.TempDir(), "precious.xml")
	if err := os.WriteFile(outside, []byte("keep me"), 0o644); err != nil {
		t.Fatal(err)
	}
	sep := string(os.PathSeparator)
	via := root + sep + "esi" + sep + ".." + sep + ".." + sep + filepath.Base(filepath.Dir(outside)) + sep + "precious.xml"
	if rec := callDelete(t, s, via); rec.Code != http.StatusForbidden {
		t.Fatalf("want 403, got %d: %s", rec.Code, rec.Body)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatal("traversal deleted a file outside the app data dir")
	}
}

// The app-data dir also holds OAuth tokens and known_hosts — only esi/ is fair game.
func TestDeleteFileRefusesAppDataOutsideEsi(t *testing.T) {
	s, root := deleteSrv(t)
	f := filepath.Join(root, "known_hosts")
	if err := os.WriteFile(f, []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}
	if rec := callDelete(t, s, f); rec.Code != http.StatusForbidden {
		t.Fatalf("want 403, got %d: %s", rec.Code, rec.Body)
	}
	if _, err := os.Stat(f); err != nil {
		t.Fatal("a file outside esi/ was deleted")
	}
}

func TestDeleteFileRefusesDirectory(t *testing.T) {
	s, root := deleteSrv(t)
	dir := filepath.Join(root, "esi", "vendor")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if rec := callDelete(t, s, dir); rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d: %s", rec.Code, rec.Body)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatal("the directory was removed")
	}
}
