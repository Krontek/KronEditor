package main

import "net/http"

// update_libraries / update_server are git-driven repo refreshes that the
// original Tauri code performs by shelling out to git + Python toolchain
// scripts (setup_toolchain.py). Porting this faithfully is a larger task —
// for now we return Not Implemented so the frontend can degrade gracefully.
// The library files already shipped under resources/ are still used at build
// time.

func (s *Server) handleUpdateLibraries(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "update_libraries not yet ported to host-agent")
}

func (s *Server) handleUpdateServer(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "update_server not yet ported to host-agent")
}
