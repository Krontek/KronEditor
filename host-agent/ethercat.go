package main

import (
	"encoding/json"
	"fmt"
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

// netIfaceDetail carries the IPv4/subnet an interface currently holds, used by
// the "search on network" device scan (netscan.go) to pick which subnet to
// probe. Interfaces with no IPv4 address (down, IPv6-only, …) are omitted from
// "details" but still listed in "interfaces" (EtherCATEditor only wants names).
type netIfaceDetail struct {
	Name string `json:"name"`
	IPv4 string `json:"ipv4"`
	CIDR string `json:"cidr"`
}

// list_network_interfaces — straightforward to port using net.Interfaces().
func (s *Server) handleListNetworkInterfaces(w http.ResponseWriter, r *http.Request) {
	ifaces, err := net.Interfaces()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	names := make([]string, 0, len(ifaces))
	details := make([]netIfaceDetail, 0, len(ifaces))
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		names = append(names, ifc.Name)
		if ifc.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipnet.IP.To4()
			if ip4 == nil {
				continue
			}
			ones, bits := ipnet.Mask.Size()
			if bits != 32 {
				continue
			}
			details = append(details, netIfaceDetail{
				Name: ifc.Name,
				IPv4: ip4.String(),
				CIDR: fmt.Sprintf("%s/%d", ip4.String(), ones),
			})
			break // one IPv4/subnet per interface is enough to pick a scan range
		}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "interfaces": names, "details": details})
}
