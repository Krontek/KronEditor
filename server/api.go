// api.go - REST API for addressed variables and runtime control
//
// Provides external access (Python, HMI, SCADA) to variables marked as
// "addressed" in the KronEditor variable table, plus PLC runtime
// lifecycle and configuration endpoints. Protected by a single password
// configured in the editor project.
//
// Endpoints:
//   POST /api/v1/auth              → authenticate with password, receive bearer token
//   GET  /api/v1/variables         → read all addressed variables
//   GET  /api/v1/variables/{name}  → read a single addressed variable
//   POST /api/v1/variables/{name}  → write a single addressed variable
//   GET  /api/v1/stream            → SSE stream of addressed variables (cadence configurable)
//   POST /api/v1/forces/clear      → clear force flags on addressed variables
//   GET  /api/v1/runtime           → runtime status (running, pid, auto_run, stream_interval_ms)
//   POST /api/v1/runtime/start     → start PLC runtime
//   POST /api/v1/runtime/stop      → stop PLC runtime
//   POST /api/v1/runtime/config    → partial update of auto_run / stream_interval_ms

package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// RuntimeController is the surface the API needs to start/stop the PLC and
// read/update persistent runtime settings. *Server implements it.
type RuntimeController interface {
	StartRuntime() (pid int, err error)
	StopRuntime() error
	RuntimeStatus() (pid int, running bool)
	RuntimeConfigSnapshot() map[string]any
	UpdateRuntimeConfig(u runtimeConfigUpdate) map[string]any
}

// APIManager handles the /api/v1/ REST endpoints.
type APIManager struct {
	ipc      *IPCManager
	rt       RuntimeController
	sessions *SessionStore
}

// NewAPIManager creates a new API manager with its own session store.
func NewAPIManager(ipc *IPCManager, rt RuntimeController) *APIManager {
	return &APIManager{
		ipc:      ipc,
		rt:       rt,
		sessions: NewSessionStore(),
	}
}

// RegisterAPIRoutes registers all /api/v1/ routes on the given mux.
func RegisterAPIRoutes(mux *http.ServeMux, am *APIManager) {
	mux.HandleFunc("POST /api/v1/auth", am.handleAuth)
	mux.HandleFunc("GET /api/v1/variables", am.requireToken(am.handleReadAll))
	mux.HandleFunc("GET /api/v1/variables/{name...}", am.requireToken(am.handleReadOne))
	mux.HandleFunc("POST /api/v1/variables/{name...}", am.requireToken(am.handleWriteOne))
	mux.HandleFunc("GET /api/v1/stream", am.requireToken(am.handleStream))
	mux.HandleFunc("GET /api/v1/stream/buffered", am.requireToken(am.handleBufferedStream))
	mux.HandleFunc("POST /api/v1/forces/clear", am.requireToken(am.handleClearForces))

	mux.HandleFunc("GET /api/v1/runtime", am.requireToken(am.handleRuntimeStatus))
	mux.HandleFunc("POST /api/v1/runtime/start", am.requireToken(am.handleRuntimeStart))
	mux.HandleFunc("POST /api/v1/runtime/stop", am.requireToken(am.handleRuntimeStop))
	mux.HandleFunc("POST /api/v1/runtime/config", am.requireToken(am.handleRuntimeConfig))
}

// handleAuth authenticates with the API password and returns a bearer token.
//
//	POST /api/v1/auth
//	Body: {"password": "..."}
//	Response: {"token": "..."}
func (am *APIManager) handleAuth(w http.ResponseWriter, r *http.Request) {
	if !am.ipc.APIEnabled() {
		jsonError(w, http.StatusServiceUnavailable, "API is not configured (no password set)")
		return
	}

	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	if !am.ipc.CheckAPIPassword(body.Password) {
		jsonError(w, http.StatusUnauthorized, "invalid password")
		return
	}

	sess := am.sessions.Create("api_client", RoleOperator)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": sess.Token})
}

// handleReadAll returns all addressed variables as a JSON map.
//
//	GET /api/v1/variables
//	Response: {"prog__motor_speed": 1500.0, "prog__pump_on": true, ...}
func (am *APIManager) handleReadAll(w http.ResponseWriter, r *http.Request) {
	vars, err := am.ipc.ReadAddressedVariables()
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	jsonOK(w, vars)
}

// handleReadOne returns a single addressed variable.
//
//	GET /api/v1/variables/{name}
//	Response: {"name": "prog__motor_speed", "value": 1500.0, "type": "float32"}
func (am *APIManager) handleReadOne(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if name == "" {
		jsonError(w, http.StatusBadRequest, "variable name required")
		return
	}

	v, ok := am.ipc.AddressedVarInfo(name)
	if !ok {
		jsonError(w, http.StatusNotFound, "variable not found or not addressed: "+name)
		return
	}

	val, err := am.ipc.ReadVariable(name)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"name":    name,
		"value":   val,
		"type":    string(v.Type),
		"address": v.Address,
	})
}

// handleWriteOne writes a value to a single addressed variable.
//
//	POST /api/v1/variables/{name}
//	Body: {"value": 1200.0}
func (am *APIManager) handleWriteOne(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if name == "" {
		jsonError(w, http.StatusBadRequest, "variable name required")
		return
	}

	if !am.ipc.IsAddressed(name) {
		jsonError(w, http.StatusNotFound, "variable not found or not addressed: "+name)
		return
	}

	var body struct {
		Value json.RawMessage `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	if err := am.ipc.WriteVariable(name, body.Value); err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}

	jsonOK(w, map[string]string{"status": "ok"})
}

// handleStream pushes addressed variables via Server-Sent Events. The poll
// cadence is GetAPIStreamInterval() and is re-read each tick, so it tracks
// live changes from /api/v1/runtime/config without reconnect.
//
//	GET /api/v1/stream
func (am *APIManager) handleStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	slog.Info("API SSE stream started", "remote", r.RemoteAddr)
	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			slog.Info("API SSE stream ended", "remote", r.RemoteAddr)
			return
		case <-heartbeat.C:
			if _, err := fmt.Fprintf(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-time.After(GetAPIStreamInterval()):
			vars, err := am.ipc.ReadAddressedVariables()
			if err != nil {
				continue
			}
			data, err := json.Marshal(vars)
			if err != nil {
				continue
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// handleRuntimeStatus returns the current PLC runtime status and live config.
//
//	GET /api/v1/runtime
//	Response: {"running": true, "pid": 1234, "auto_run": false, "stream_interval_ms": 50}
func (am *APIManager) handleRuntimeStatus(w http.ResponseWriter, r *http.Request) {
	pid, running := am.rt.RuntimeStatus()
	resp := am.rt.RuntimeConfigSnapshot()
	resp["running"] = running
	resp["pid"] = pid
	jsonOK(w, resp)
}

// handleRuntimeStart launches the PLC runtime binary.
//
//	POST /api/v1/runtime/start
//	Response: {"running": true, "pid": 1234}
func (am *APIManager) handleRuntimeStart(w http.ResponseWriter, r *http.Request) {
	pid, err := am.rt.StartRuntime()
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	jsonOK(w, map[string]any{"running": true, "pid": pid})
}

// handleRuntimeStop gracefully terminates the PLC runtime.
//
//	POST /api/v1/runtime/stop
//	Response: {"running": false}
func (am *APIManager) handleRuntimeStop(w http.ResponseWriter, r *http.Request) {
	if err := am.rt.StopRuntime(); err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	jsonOK(w, map[string]any{"running": false})
}

// handleRuntimeConfig accepts a partial config update.
//
//	POST /api/v1/runtime/config
//	Body: {"auto_run": true, "stream_interval_ms": 100}   (both fields optional)
//	Response: {"auto_run": true, "stream_interval_ms": 100}
func (am *APIManager) handleRuntimeConfig(w http.ResponseWriter, r *http.Request) {
	var u runtimeConfigUpdate
	if err := json.NewDecoder(r.Body).Decode(&u); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	jsonOK(w, am.rt.UpdateRuntimeConfig(u))
}

// typeCode maps a VarType to a 1-byte wire code so a binary client knows how to
// parse each field in a buffered-stream frame.
var typeCode = map[VarType]byte{
	VarBool: 0, VarInt8: 1, VarUint8: 2, VarInt16: 3, VarUint16: 4,
	VarInt32: 5, VarUint32: 6, VarInt64: 7, VarUint64: 8,
	VarFloat32: 9, VarFloat64: 10,
}

// handleBufferedStream streams a high-rate, server-buffered BINARY feed of
// addressed variables. Delivery cadence is fixed at 5 ms; the client picks a
// sample interval (interval_us) which may be shorter, in which case the server
// samples that fast and packs every sample accumulated per 5 ms into one frame.
// This decouples a fast sample rate from an HTTP-friendly 5 ms push rate.
//
//	GET /api/v1/stream/buffered?vars=a,b,c&interval_us=1000
//
// Frame (little-endian, one per 5 ms that has >=1 sample):
//	u32 frame_len       bytes after this field
//	u16 sample_count    number of samples in this frame (~ 5000/interval_us)
//	u8  var_count
//	u8  types[var_count]
//	sample_count × ( each var's native value, in request order )
//
// Loss policy: if the PLC writes faster than interval_us the intermediate
// values are aliased away (accepted); samples are assumed evenly spaced by
// interval_us (no per-sample timestamp). Delivery of what WAS sampled is
// lossless. Addressed variables only; max ~5 concurrent clients expected.
func (am *APIManager) handleBufferedStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	var vars []Variable
	var types []byte
	bytesPerSample := 0
	for _, n := range strings.Split(r.URL.Query().Get("vars"), ",") {
		n = strings.TrimSpace(n)
		if n == "" {
			continue
		}
		v, ok := am.ipc.AddressedVarInfo(n)
		if !ok {
			jsonError(w, http.StatusNotFound, "variable not found or not addressed: "+n)
			return
		}
		tc, ok := typeCode[v.Type]
		if !ok {
			jsonError(w, http.StatusBadRequest, "unsupported type for "+n)
			return
		}
		vars = append(vars, v)
		types = append(types, tc)
		bytesPerSample += v.Size
	}
	if len(vars) == 0 {
		jsonError(w, http.StatusBadRequest, "no valid addressed variables in 'vars'")
		return
	}

	intervalUs := 1000
	if n, err := strconv.Atoi(r.URL.Query().Get("interval_us")); err == nil && n > 0 {
		intervalUs = n
	}
	const minSampleUs = 100 // ticker floor — below this, scheduler jitter dominates
	if intervalUs < minSampleUs {
		intervalUs = minSampleUs
	}
	const deliverUs = 5000
	// Cap buffered samples so a stalled/slow client can't grow the frame without
	// bound (drops newest while full — accepted loss).
	maxSamples := (deliverUs/intervalUs)*4 + 4

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	sampleTick := time.NewTicker(time.Duration(intervalUs) * time.Microsecond)
	defer sampleTick.Stop()
	deliverTick := time.NewTicker(deliverUs * time.Microsecond)
	defer deliverTick.Stop()

	buf := make([]byte, 0, maxSamples*bytesPerSample)
	count := 0
	ctx := r.Context()

	for {
		select {
		case <-ctx.Done():
			return
		case <-sampleTick.C:
			if count < maxSamples {
				buf = am.ipc.AppendRawSample(vars, buf)
				count++
			}
		case <-deliverTick.C:
			if count == 0 {
				continue
			}
			var hdr [7]byte
			binary.LittleEndian.PutUint32(hdr[0:4], uint32(2+1+len(types)+len(buf)))
			binary.LittleEndian.PutUint16(hdr[4:6], uint16(count))
			hdr[6] = byte(len(vars))
			if _, err := w.Write(hdr[:]); err != nil {
				return
			}
			if _, err := w.Write(types); err != nil {
				return
			}
			if _, err := w.Write(buf); err != nil {
				return
			}
			flusher.Flush()
			buf = buf[:0]
			count = 0
		}
	}
}

// handleClearForces clears force flags on all addressed variables.
//
//	POST /api/v1/forces/clear
func (am *APIManager) handleClearForces(w http.ResponseWriter, r *http.Request) {
	am.ipc.ClearAllForces()
	jsonOK(w, map[string]string{"status": "ok"})
}

// requireToken is an authentication middleware that checks for a valid
// Bearer token in the Authorization header.
func (am *APIManager) requireToken(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			jsonError(w, http.StatusUnauthorized, "missing or invalid Authorization header")
			return
		}
		token := strings.TrimPrefix(auth, "Bearer ")
		if _, ok := am.sessions.Get(token); !ok {
			jsonError(w, http.StatusUnauthorized, "invalid or expired token")
			return
		}
		next(w, r)
	}
}
