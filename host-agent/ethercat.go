package main

import (
	"encoding/json"
	"net"
	"net/http"
)

// EtherCAT-related commands.
//
// build_soem and build_canopen used to live here as stubs; they are real now
// and live with the rest of the library builder in libraries_deps.go.
//
// ec_request_state stays unported: it needs a CGO bridge to call the live SOEM
// C ABI in the running runtime, which the editor's main workflow never uses.

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
