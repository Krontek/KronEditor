package main

import (
	"encoding/json"
	"net"
	"net/http"
)

// EtherCAT-related commands. The original Tauri code uses bundled Python
// scripts and SOEM/CANopen sources to build static archives, and SOEM C ABI
// to request live EtherCAT state changes. Porting these is deferred — they
// require shelling out to the same Python build scripts plus a CGO bridge
// for live SOEM calls, neither of which is critical for the editor's main
// workflow.

func (s *Server) handleBuildSoem(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "build_soem not yet ported to host-agent")
}

func (s *Server) handleBuildCanopen(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "build_canopen not yet ported to host-agent")
}

func (s *Server) handleEcRequestState(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "ec_request_state not yet ported to host-agent")
}

// list_network_interfaces — straightforward to port using net.Interfaces().
func (s *Server) handleListNetworkInterfaces(w http.ResponseWriter, r *http.Request) {
	ifaces, err := net.Interfaces()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	names := make([]string, 0, len(ifaces))
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		names = append(names, ifc.Name)
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "interfaces": names})
}
