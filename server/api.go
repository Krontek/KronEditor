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
//   POST /api/v1/forces/clear      → clear ALL force flags (every variable, not only addressed)
//   GET  /api/v1/runtime           → runtime status (running, pid, auto_run, stream_interval_ms)
//   POST /api/v1/runtime/start     → start PLC runtime
//   POST /api/v1/runtime/stop      → stop PLC runtime
//   POST /api/v1/runtime/config    → partial update of auto_run / stream_interval_ms

package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/krontek/hotswaplib/shmcmd"
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

	shmName string // base /dev/shm name; the capture ring is "<shmName>_ring"
	ringMu  sync.Mutex
	ring    *RingConsumer   // lazily opened, shared by all stream connections
	ringCtl *ringController // adaptive decimation controller (owns stride_N)
}

// NewAPIManager creates a new API manager with its own session store.
func NewAPIManager(ipc *IPCManager, rt RuntimeController, shmName string) *APIManager {
	am := &APIManager{
		ipc:      ipc,
		rt:       rt,
		sessions: NewSessionStore(),
		shmName:  shmName,
	}
	// A deploy that changes (or removes) the API password revokes every bearer
	// token issued under the old one — otherwise a leaked token kept working
	// for its full 8 h TTL after the password was rotated.
	ipc.SetAPIPasswordChangeHook(am.sessions.Clear)
	return am
}

// RegisterAPIRoutes registers all /api/v1/ routes on the given mux.
func RegisterAPIRoutes(mux *http.ServeMux, am *APIManager) {
	mux.HandleFunc("POST /api/v1/auth", am.handleAuth)
	mux.HandleFunc("GET /api/v1/variables", am.requireToken(am.handleReadAll))
	mux.HandleFunc("GET /api/v1/variables/{name...}", am.requireToken(am.handleReadOne))
	mux.HandleFunc("POST /api/v1/variables/{name...}", am.requireToken(am.handleWriteOne))
	mux.HandleFunc("GET /api/v1/stream", am.requireToken(am.handleStream))
	mux.HandleFunc("GET /api/v1/stream/buffered", am.requireToken(am.handleBufferedStream))
	mux.HandleFunc("GET /api/v1/stream/ring", am.requireToken(am.handleRingStream))
	mux.HandleFunc("GET /api/v1/ring/info", am.requireToken(am.handleRingInfo))
	mux.HandleFunc("GET /api/v1/forces", am.requireToken(am.handleListForces))
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

	gen := am.ipc.APIPasswordGen()
	if !am.ipc.CheckAPIPassword(body.Password) {
		jsonError(w, http.StatusUnauthorized, "invalid password")
		return
	}

	sess := am.sessions.Create("api_client", RoleOperator)
	if am.ipc.APIPasswordGen() != gen {
		// The password changed between the check and the Create, so the hook's
		// Clear may have run BEFORE this token existed. Do not hand it out.
		am.sessions.Delete(sess.Token)
		jsonError(w, http.StatusUnauthorized, "API password changed, retry")
		return
	}
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
		// mode: "force" (default), "pulse" or "unforce" — see API.md.
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	op, err := shmcmd.ParseOp(body.Mode)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Returns only after the runtime APPLIED the command (force-write
	// mailbox); 409 not running / version mismatch, 503 mailbox full, 504 the
	// runtime did not acknowledge in time — see shmcmd.HTTPStatus.
	if err := am.ipc.WriteVariableMode(name, body.Value, op); err != nil {
		jsonError(w, shmcmd.HTTPStatus(err), err.Error())
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
	// ⚠️ A Ticker, never `case <-time.After(interval)` inside the select: that
	// re-arms a fresh timer on EVERY loop pass, so whichever other case fires
	// first restarts the wait — with an interval >= the 25 s heartbeat the
	// heartbeat always won and no data frame was ever sent. The interval is
	// re-read after each data tick, so /api/v1/runtime/config still applies
	// without a reconnect.
	interval := GetAPIStreamInterval()
	tick := time.NewTicker(interval)
	defer tick.Stop()

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
		case <-tick.C:
			if cur := GetAPIStreamInterval(); cur != interval {
				interval = cur
				tick.Reset(interval)
			}
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

// bufferedFrameVersion is the /api/v1/stream/buffered frame format. v1 had no
// version field, no timestamps and a u8 variable count; see API.md.
const bufferedFrameVersion = 2

// monoEpoch anchors the monotonic microsecond clock the buffered stream
// reports (time.Since uses the monotonic reading; wall-clock steps never move it).
var monoEpoch = time.Now()

func monoMicros(t time.Time) uint64 { return uint64(t.Sub(monoEpoch) / time.Microsecond) }

// handleBufferedStream streams a high-rate, server-buffered BINARY feed of
// addressed variables. Delivery cadence is fixed at 5 ms; the client picks a
// sample interval (interval_us) which may be shorter, in which case the server
// samples that fast and packs every sample accumulated per 5 ms into one frame.
//
//	GET /api/v1/stream/buffered?v=2&vars=a,b,c&interval_us=1000
//
// Frame v2 (little-endian, one per 5 ms that has >=1 sample or a loss to report):
//
//	u32 frame_len       bytes after this field
//	u16 version         2
//	u16 var_count       (v1: u8 — wrapped above 255)
//	u32 sample_count
//	u32 interval_us     the effective sample interval
//	u32 missed          ticks that produced NO sample since the previous frame:
//	                    scheduler stalls (the ticker drops ticks) + buffer overflow
//	u64 t_first_us      monotonic µs (server process clock) of the first sample
//	u8  types[var_count]
//	sample_count × ( each var's native value, in request order )
//
// ⚠️ Samples are on a NOMINAL grid: sample i was taken at about
// t_first_us + i·interval_us, and `missed` says how many grid points went
// unsampled (where is unknown — a client that needs exact spacing should treat
// a frame with missed > 0 as containing a gap).
//
// ⚠️ The stream ENDS when the variable table changes (a Build & Send): the
// offsets it resolved at connect would otherwise keep decoding whatever now
// lives there under the old names. Reconnect to resolve again.
//
// ⚠️ ?v=2 is REQUIRED. A v1 client (no version field, u8 count) would misparse
// every v2 frame into plausible garbage, so a request without it gets a 400
// naming the change instead of a stream it cannot read.
func (am *APIManager) handleBufferedStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}
	if r.URL.Query().Get("v") != strconv.Itoa(bufferedFrameVersion) {
		jsonError(w, http.StatusBadRequest, "buffered stream frame format v2 required: add ?v=2 (frames now carry a version, u16 var_count, timestamps and a missed-sample counter — see API.md)")
		return
	}

	gen := am.ipc.TableGen()
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
	if len(vars) > 0xFFFF {
		jsonError(w, http.StatusBadRequest, "too many variables (max 65535)")
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
	// Cap buffered samples so a stalled/slow client can't grow the frame
	// without bound. Overflow is no longer silent: it is counted in `missed`.
	maxSamples := (deliverUs/intervalUs)*4 + 4

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	// Own cancel: the handler also returns on a table change or a write error,
	// and the sampler must stop then too (the deferred wait below would block).
	ctx, cancel := context.WithCancel(r.Context())
	interval := time.Duration(intervalUs) * time.Microsecond

	// The SAMPLER runs in its own goroutine so a slow socket write (TCP
	// backpressure) cannot stall sampling: it only ever blocks on the mutex
	// for the few µs a frame swap takes.
	var (
		mu      sync.Mutex
		buf     = make([]byte, 0, maxSamples*bytesPerSample)
		count   int
		missed  uint32
		tFirst  uint64
		stopped = make(chan struct{})
	)
	go func() {
		defer close(stopped)
		tk := time.NewTicker(interval)
		defer tk.Stop()
		start := time.Now()
		var lastIdx int64 = -1
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-tk.C:
				// Grid index of this tick; a jump of k > 1 means the ticker
				// dropped k-1 ticks (Go tickers drop, never queue).
				idx := int64(now.Sub(start) / interval)
				mu.Lock()
				if lastIdx >= 0 && idx > lastIdx+1 {
					missed += uint32(idx - lastIdx - 1)
				}
				lastIdx = idx
				if count < maxSamples {
					if count == 0 {
						tFirst = monoMicros(now)
					}
					buf = am.ipc.AppendRawSample(vars, buf)
					count++
				} else {
					missed++
				}
				mu.Unlock()
			}
		}
	}()
	defer func() { cancel(); <-stopped }()

	deliverTick := time.NewTicker(deliverUs * time.Microsecond)
	defer deliverTick.Stop()
	out := make([]byte, 0, 24+len(types)+maxSamples*bytesPerSample)
	for {
		select {
		case <-ctx.Done():
			return
		case <-deliverTick.C:
		}
		if am.ipc.TableGen() != gen {
			slog.Info("Buffered stream ended: variable table changed", "remote", r.RemoteAddr)
			return
		}
		mu.Lock()
		if count == 0 && missed == 0 {
			mu.Unlock()
			continue
		}
		out = out[:0]
		out = appendU32(out, 0) // frame_len placeholder
		out = appendU16(out, bufferedFrameVersion)
		out = appendU16(out, uint16(len(vars)))
		out = appendU32(out, uint32(count))
		out = appendU32(out, uint32(intervalUs))
		out = appendU32(out, missed)
		out = appendU64(out, tFirst)
		out = append(out, types...)
		out = append(out, buf...)
		buf, count, missed = buf[:0], 0, 0
		mu.Unlock()
		binary.LittleEndian.PutUint32(out[0:4], uint32(len(out)-4))
		if _, err := w.Write(out); err != nil {
			return
		}
		flusher.Flush()
	}
}

// handleListForces lists the FORCED addressed variables (REST scope: an
// unaddressed variable is invisible here even when forced — the editor's
// /stream/vars "__forced" key carries the full set).
//
//	GET /api/v1/forces
//	Response: {"forced": ["prog__pump_on"], "count": 1}
func (am *APIManager) handleListForces(w http.ResponseWriter, r *http.Request) {
	forced := am.ipc.ForcedVariables(true)
	jsonOK(w, map[string]any{"forced": forced, "count": len(forced)})
}

// handleClearForces clears ALL force flags — every variable in the table, not
// just the addressed ones (same operation as the editor's ClearAllForces).
//
//	POST /api/v1/forces/clear
func (am *APIManager) handleClearForces(w http.ResponseWriter, r *http.Request) {
	if err := am.ipc.ClearAllForces(); err != nil {
		jsonError(w, shmcmd.HTTPStatus(err), err.Error())
		return
	}
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
