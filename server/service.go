// service.go - ConnectRPC service implementation for PLCService.
//
// Implements plcv1connect.PLCServiceHandler.
// StreamVars pushes a full variable snapshot every 50 ms via server streaming.

package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"sync/atomic"
	"time"

	connect "connectrpc.com/connect"
	"github.com/krontek/hotswaplib/shmcmd"
	"google.golang.org/protobuf/types/known/structpb"
	plcv1 "plc-agent/gen/plc/v1"
)

// streamInterval is the fixed cadence of editor-facing streams: the
// ConnectRPC StreamVars RPC and the /stream/vars SSE endpoint. The
// editor relies on this being stable, so it is intentionally NOT
// configurable at runtime.
const streamInterval = 50 * time.Millisecond

// API-stream interval bounds (milliseconds). Lower bound prevents
// accidental DoS from a runaway external client; upper bound is one
// minute, enough for a human-paced data view but still keeps SSE
// connections alive without heartbeat reliance.
const (
	minAPIStreamIntervalMs     = 5
	maxAPIStreamIntervalMs     = 60000
	defaultAPIStreamIntervalMs = 50
)

// apiStreamIntervalMs is the live polling interval used ONLY by the
// addressed-variable SSE stream at /api/v1/stream. It is read via
// GetAPIStreamInterval and updated via SetAPIStreamIntervalMs and is
// persisted across restarts in runtime_config.json.
var apiStreamIntervalMs atomic.Int64

func init() {
	apiStreamIntervalMs.Store(defaultAPIStreamIntervalMs)
}

// GetAPIStreamInterval returns the current /api/v1/stream poll interval.
func GetAPIStreamInterval() time.Duration {
	return time.Duration(apiStreamIntervalMs.Load()) * time.Millisecond
}

// SetAPIStreamIntervalMs clamps and stores a new /api/v1/stream interval.
// Returns the value that was actually stored after clamping.
func SetAPIStreamIntervalMs(v uint32) uint32 {
	ms := int64(v)
	if ms < minAPIStreamIntervalMs {
		ms = minAPIStreamIntervalMs
	}
	if ms > maxAPIStreamIntervalMs {
		ms = maxAPIStreamIntervalMs
	}
	apiStreamIntervalMs.Store(ms)
	return uint32(ms)
}

// PLCService implements PLCServiceHandler.
type PLCService struct {
	ipc *IPCManager
	pm  *ProcessManager
}

func NewPLCService(ipc *IPCManager, pm *ProcessManager) *PLCService {
	return &PLCService{ipc: ipc, pm: pm}
}

// Start launches the PLC runtime binary.
// Initial values are written by pm's pre-start hook (see main.go) AFTER any
// previous process has stopped — writing them here, before pm.Start()'s
// internal stop, would let the dying runtime's final shm sync overwrite them.
func (s *PLCService) Start(_ context.Context, _ *connect.Request[plcv1.StartRequest]) (*connect.Response[plcv1.StartResponse], error) {
	if err := s.pm.Start(); err != nil {
		slog.Error("Failed to start PLC runtime", "err", err)
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	pid, _ := s.pm.Status()
	slog.Info("PLC runtime started", "pid", pid)
	return connect.NewResponse(&plcv1.StartResponse{Pid: int32(pid)}), nil
}

// Stop gracefully terminates the PLC runtime.
func (s *PLCService) Stop(_ context.Context, _ *connect.Request[plcv1.StopRequest]) (*connect.Response[plcv1.StopResponse], error) {
	if err := s.pm.Stop(); err != nil {
		slog.Error("Failed to stop PLC runtime", "err", err)
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	slog.Info("PLC runtime stopped")
	return connect.NewResponse(&plcv1.StopResponse{}), nil
}

// WriteVar posts a force-write command and returns once the runtime applied it.
// req.mode selects force (default) / pulse / unforce.
func (s *PLCService) WriteVar(_ context.Context, req *connect.Request[plcv1.WriteVarRequest]) (*connect.Response[plcv1.WriteVarResponse], error) {
	name := req.Msg.GetName()
	if name == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, nil)
	}
	op, err := shmcmd.ParseOp(req.Msg.GetMode())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	v := req.Msg.GetValue()
	if v == nil && op != shmcmd.OpUnforce {
		return nil, connect.NewError(connect.CodeInvalidArgument, nil)
	}
	// Re-marshal the protobuf Value to JSON for ipc.WriteVariableMode. A
	// 64-bit integer arrives as a decimal STRING (a Value number is a double)
	// and normalizeRawValue parses it exactly.
	var raw []byte
	if v != nil {
		if raw, err = json.Marshal(v.AsInterface()); err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}
	}
	if err := s.ipc.WriteVariableMode(name, json.RawMessage(raw), op); err != nil {
		slog.Warn("Failed to write variable", "name", name, "err", err)
		return nil, connect.NewError(connectCodeFor(err), err)
	}
	slog.Info("Variable written", "name", name, "mode", req.Msg.GetMode())
	return connect.NewResponse(&plcv1.WriteVarResponse{}), nil
}

// ClearAllForces removes all force flags.
func (s *PLCService) ClearAllForces(_ context.Context, _ *connect.Request[plcv1.ClearAllForcesRequest]) (*connect.Response[plcv1.ClearAllForcesResponse], error) {
	if err := s.ipc.ClearAllForces(); err != nil {
		return nil, connect.NewError(connectCodeFor(err), err)
	}
	return connect.NewResponse(&plcv1.ClearAllForcesResponse{}), nil
}

// connectCodeFor maps a force-write failure to a ConnectRPC code.
func connectCodeFor(err error) connect.Code {
	switch shmcmd.KindOf(err) {
	case shmcmd.KindNotRunning, shmcmd.KindNotReady, shmcmd.KindMismatch:
		return connect.CodeFailedPrecondition
	case shmcmd.KindFull:
		return connect.CodeResourceExhausted
	case shmcmd.KindTimeout:
		return connect.CodeDeadlineExceeded
	case shmcmd.KindRejected, shmcmd.KindInvalid:
		return connect.CodeInvalidArgument
	}
	return connect.CodeInternal
}

// StreamVars pushes a full variable snapshot every streamInterval (50 ms)
// until the client disconnects. The cadence is intentionally fixed — this
// is the editor's debug stream, not the user-tunable API stream.
func (s *PLCService) StreamVars(ctx context.Context, _ *connect.Request[plcv1.StreamVarsRequest], stream *connect.ServerStream[plcv1.VarsUpdate]) error {
	slog.Info("StreamVars started", "remote", ctx.Value(remoteAddrKey{}))
	ticker := time.NewTicker(streamInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			slog.Info("StreamVars ended")
			return nil
		case t := <-ticker.C:
			vars, err := s.ipc.ReadAllVariables()
			if err != nil {
				// IPC not ready yet (no variable table loaded) — skip silently.
				continue
			}
			// Convert map[string]any → google.protobuf.Struct
			pbStruct, err := toProtoStruct(vars)
			if err != nil {
				slog.Warn("StreamVars: struct conversion failed", "err", err)
				continue
			}
			if sendErr := stream.Send(&plcv1.VarsUpdate{
				Variables: pbStruct,
				Ts:        t.UnixMilli(),
			}); sendErr != nil {
				return sendErr
			}
		}
	}
}

// toProtoStruct converts map[string]any to *structpb.Struct.
//
// structpb.NewValue supports: nil, bool, int, int32, int64, uint32, uint64,
// float32, float64, string — but NOT int8, uint8, int16, uint16.
// ipc.decodeValue may return these smaller types, so we normalise them to
// float64 first to prevent a silent conversion error that drops all values.
func toProtoStruct(m map[string]any) (*structpb.Struct, error) {
	norm := make(map[string]any, len(m))
	for k, v := range m {
		switch val := v.(type) {
		case int64, uint64:
			// ⚠️ A protobuf Value number is a double: every LINT/ULINT/LWORD
			// above 2^53 used to arrive rounded. See jsonSafe64.
			norm[k] = jsonSafe64(val)
		case int8:
			norm[k] = float64(val)
		case uint8:
			norm[k] = float64(val)
		case int16:
			norm[k] = float64(val)
		case uint16:
			norm[k] = float64(val)
		default:
			norm[k] = val
		}
	}
	return structpb.NewStruct(norm)
}

// remoteAddrKey is used to store the remote address in context.
type remoteAddrKey struct{}

// maxExactDouble is 2^53: every integer of magnitude <= this is exact in a
// float64 (and in a JavaScript number).
const maxExactDouble = 1 << 53

// jsonSafe64 returns a 64-bit integer unchanged while a double holds it
// exactly, and as a DECIMAL STRING beyond that. Clients that decode numbers as
// doubles (protobuf Value, JavaScript) would otherwise silently round it; the
// editor and normalizeRawValue both accept the string form, so a value read
// this way can be written back verbatim. Other values pass through.
func jsonSafe64(v any) any {
	switch n := v.(type) {
	case int64:
		if n > maxExactDouble || n < -maxExactDouble {
			return strconv.FormatInt(n, 10)
		}
		return n
	case uint64:
		if n > maxExactDouble {
			return strconv.FormatUint(n, 10)
		}
		return n
	}
	return v
}
