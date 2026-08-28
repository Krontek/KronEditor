package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// Network device search — the "Connection" tab lets the user pick a local
// network interface (wlan0, eth0, …) instead of typing a target IP by hand,
// then scans that interface's IPv4 subnet for a KronServer answering GET
// /status on the given port. Results stream back over the generic SSE
// broadcaster so the frontend can show a live "N/total scanned, M found"
// popup instead of blocking on one big response.

const (
	topicScanProgress = "network-scan-progress" // {scanned, total, found?: scanHost}
	topicScanDone     = "network-scan-done"     // {success, count[, message]}

	scanMaxHosts    = 1024 // caps a runaway subnet (e.g. a /8 VPN interface) to something a click can still wait out
	scanConcurrency = 64
	scanTimeout     = 500 * time.Millisecond
)

// netScanMu allows only one scan at a time — same TryLock pattern as the
// library-build jobs (libraries.go), so a second click gets a clear 409
// instead of two scans racing their SSE progress onto the same topic.
var netScanMu sync.Mutex

// netScanCancel holds the cancel func of whichever scan is currently running
// (nil when idle), so the frontend closing the popup / picking a result can
// actually stop the in-flight probes instead of only detaching its SSE
// listener. Without this the scan used to keep firing up to scanConcurrency
// concurrent requests at the target port for several more seconds after the
// UI moved on — on the SAME LAN/port the user was about to connect to, that
// burst was enough to make the just-established connection's 3s status poll
// miss a beat or two and flap the toolbar indicator disconnected→connected.
var netScanCancel atomic.Pointer[context.CancelFunc]

type scanNetworkReq struct {
	Interface string `json:"interface"`
	Port      int    `json:"port"`
}

// scanHost is one discovered device — fields lifted straight from KronServer's
// GET /status (server/server.go handleStatus) so the popup can show something
// more useful than a bare IP.
type scanHost struct {
	IP            string `json:"ip"`
	Port          int    `json:"port"`
	Running       bool   `json:"running"`
	Pid           int    `json:"pid"`
	VariableCount int    `json:"variableCount"`
	HmiPort       int    `json:"hmiPort"`
}

func (s *Server) handleScanNetwork(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req scanNetworkReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body: "+err.Error())
		return
	}
	if req.Interface == "" {
		writeError(w, http.StatusBadRequest, "interface is required")
		return
	}
	port := req.Port
	if port <= 0 || port > 65535 {
		port = 7070
	}
	ips, err := hostsOnInterface(req.Interface)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(ips) == 0 {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("interface %q has no usable IPv4 subnet to scan", req.Interface))
		return
	}
	if !netScanMu.TryLock() {
		writeError(w, http.StatusConflict, "a network scan is already running")
		return
	}
	total := len(ips)
	ctx, cancel := context.WithCancel(context.Background())
	netScanCancel.Store(&cancel)
	go func() {
		defer netScanMu.Unlock()
		defer netScanCancel.Store(nil)
		defer cancel()
		found := s.runNetworkScan(ctx, ips, port)
		s.events.Emit(topicScanDone, map[string]any{"success": true, "count": len(found), "cancelled": ctx.Err() != nil})
	}()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "started": true, "total": total})
}

// handleCancelScanNetwork stops the in-flight scan (if any) immediately,
// rather than letting its remaining probes drain in the background. Called
// when the user closes the search popup or picks a result — see netScanCancel.
func (s *Server) handleCancelScanNetwork(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	if cancel := netScanCancel.Load(); cancel != nil {
		(*cancel)()
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// hostsOnInterface resolves the named interface's IPv4 subnet and returns
// every host address in it except the network and broadcast addresses,
// capped at scanMaxHosts so a huge subnet (e.g. a /8 on a VPN adapter)
// degrades to "scan the first 1024" rather than hanging for minutes.
func hostsOnInterface(name string) ([]net.IP, error) {
	ifc, err := net.InterfaceByName(name)
	if err != nil {
		return nil, fmt.Errorf("interface %q not found: %w", name, err)
	}
	addrs, err := ifc.Addrs()
	if err != nil {
		return nil, err
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
		if bits != 32 || ones >= 31 {
			continue // /31 or /32 has no usable host range
		}
		hostBits := 32 - ones
		total := uint32(1) << uint(hostBits)
		if total-2 > scanMaxHosts {
			total = scanMaxHosts + 2
		}
		network := binary.BigEndian.Uint32(ip4.Mask(ipnet.Mask))
		ips := make([]net.IP, 0, total-2)
		for i := uint32(1); i < total-1; i++ { // skip .0 (network) and the last address (broadcast for the real mask)
			b := make(net.IP, 4)
			binary.BigEndian.PutUint32(b, network+i)
			ips = append(ips, b)
		}
		return ips, nil
	}
	return nil, fmt.Errorf("interface %q has no IPv4 address", name)
}

// runNetworkScan probes every candidate IP concurrently (bounded by
// scanConcurrency) and emits one progress event per probe so the UI can show
// a live counter; a successful KronServer answer is attached to that same
// event rather than a separate message, so ordering with the counter is free.
// Stops launching new probes as soon as ctx is cancelled — already in-flight
// ones (at most scanConcurrency) still complete or hit scanTimeout, but no
// new connections go out, so a cancel drains in well under scanTimeout.
func (s *Server) runNetworkScan(ctx context.Context, ips []net.IP, port int) []scanHost {
	total := len(ips)
	var scanned int32
	var mu sync.Mutex
	var found []scanHost

	client := &http.Client{Timeout: scanTimeout}
	sem := make(chan struct{}, scanConcurrency)
	var wg sync.WaitGroup

ipLoop:
	for _, ip := range ips {
		select {
		case <-ctx.Done():
			break ipLoop
		default:
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(ip net.IP) {
			defer wg.Done()
			defer func() { <-sem }()
			addr := ip.String()
			h, ok := probeKronServer(client, addr, port)
			n := atomic.AddInt32(&scanned, 1)
			evt := map[string]any{"scanned": n, "total": total}
			if ok {
				mu.Lock()
				found = append(found, h)
				mu.Unlock()
				evt["found"] = h
			}
			s.events.Emit(topicScanProgress, evt)
		}(ip)
	}
	wg.Wait()
	return found
}

// probeKronServer hits GET http://ip:port/status and returns a scanHost only
// if the response is a 200 with a body that decodes cleanly — anything else
// (connection refused, timeout, non-JSON, wrong service on that port) is
// treated as "nothing here", never as a match.
func probeKronServer(client *http.Client, ip string, port int) (scanHost, bool) {
	url := fmt.Sprintf("http://%s:%d/status", ip, port)
	resp, err := client.Get(url)
	if err != nil {
		return scanHost{}, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return scanHost{}, false
	}
	var st struct {
		Running       bool `json:"running"`
		Pid           int  `json:"pid"`
		VariableCount int  `json:"variable_count"`
		HmiPort       int  `json:"hmi_port"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&st); err != nil {
		return scanHost{}, false
	}
	return scanHost{
		IP:            ip,
		Port:          port,
		Running:       st.Running,
		Pid:           st.Pid,
		VariableCount: st.VariableCount,
		HmiPort:       st.HmiPort,
	}, true
}
