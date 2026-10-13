// ipc.go - Shared Memory (mmap) IPC and Variable Table
//
// Communication method with the C++ PLC runtime:
//   - /dev/shm/<shm-name> is mmap'ed as the shared memory region
//   - offset/type/size from variable_table.json are used to read/write bytes
//   - CGO is not used; all operations rely on the syscall package
//
// Supported types: bool, int8, uint8, int16, uint16, int32, uint32,
//                  int64, uint64, float32, float64

package main

import (
	"bytes"
	"crypto/subtle"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/krontek/hotswaplib/shmcmd"
)

// Variable table

// VarType defines supported PLC variable types.
type VarType string

const (
	VarBool    VarType = "bool"
	VarInt8    VarType = "int8"
	VarUint8   VarType = "uint8"
	VarInt16   VarType = "int16"
	VarUint16  VarType = "uint16"
	VarInt32   VarType = "int32"
	VarUint32  VarType = "uint32"
	VarInt64   VarType = "int64"
	VarUint64  VarType = "uint64"
	VarFloat32 VarType = "float32"
	VarFloat64 VarType = "float64"
	// VarString is the only VARIABLE-WIDTH type: the slot holds NUL-padded
	// text, and Size comes from the variable table rather than typeSizeMap.
	// It is READ-ONLY — the runtime never pulls text back out of the mirror
	// (no pull path for text, and the mailbox answers READ_ONLY), so
	// WriteVariable refuses it rather than writing bytes nothing will read.
	VarString VarType = "string"
)

// maxStringBytes bounds a string slot from an UNTRUSTED variable table. The
// generator uses 64; the ceiling only has to stop an absurd Size from being
// accepted, the bounds check below still confirms it fits the segment.
const maxStringBytes = 1024

// Variable represents one symbol record in variable_table.json.
//
// Example variable_table.json:
//
//	{
//	  "variables": [
//	    { "name": "motor_speed",  "offset": 0,  "type": "float32", "size": 4, "force_flag_offset": 32768 },
//	    { "name": "pump_status",  "offset": 4,  "type": "bool",    "size": 1, "force_flag_offset": 32769 },
//	    { "name": "error_code",   "offset": 8,  "type": "int32",   "size": 4, "force_flag_offset": 32770 },
//	    { "name": "temperature",  "offset": 12, "type": "float64", "size": 8, "force_flag_offset": 32771 }
//	  ]
//	}
type Variable struct {
	Name            string          `json:"name"`
	Offset          int             `json:"offset"`                      // Byte offset inside shared memory
	Type            VarType         `json:"type"`                        // Variable type
	Size            int             `json:"size"`                        // Size in bytes
	ForceFlagOffset int             `json:"force_flag_offset,omitempty"` // Byte offset of force flag (0 = not supported)
	Address         string          `json:"address,omitempty"`           // IEC address (e.g. %MW0) — non-empty = exposed via REST API
	InitialValue    json.RawMessage `json:"initial_value,omitempty"`     // Initial value from editor
}

// VariableTable is the root structure for the symbol table.
type VariableTable struct {
	Variables       []Variable  `json:"variables"`
	APIPasswordHash string      `json:"api_password_hash,omitempty"`
	APIPasswordSalt string      `json:"api_password_salt,omitempty"`
	Ring            *RingConfig `json:"ring,omitempty"`
	// ShmLayout is present from SHM layout v2 on (force-write mailbox,
	// naturally aligned slots). Absent = a table built for a v1 runtime.
	ShmLayout *ShmLayout `json:"shm_layout,omitempty"`
	// Tasks is informational; only interval_us is used (ack timeout).
	Tasks []struct {
		IntervalUs int64 `json:"interval_us"`
	} `json:"tasks,omitempty"`
}

// ShmLayout describes the variable segment the table was generated for. The
// writer still verifies the mailbox magic/version IN the segment — this is the
// table's claim, the segment is the runtime's.
type ShmLayout struct {
	Version           int   `json:"version"`
	MailboxOffset     int   `json:"mailbox_offset"`
	MailboxCapacity   int   `json:"mailbox_capacity"`
	NVars             int   `json:"nvars"`
	MaxTaskIntervalUs int64 `json:"max_task_interval_us"`
}

// RingConfig describes the capture-ring payload layout so a stream client can
// decode raw record bytes into named variables. Emitted by the transpiler; the
// var order within each task IS the payload byte order. Optional — absent means
// the project has no addressed variables (ring disabled).
type RingConfig struct {
	RecordStride int              `json:"record_stride"`
	Tasks        []RingTaskLayout `json:"tasks"`
}

// RingTaskLayout is one task's addressed-variable payload layout.
type RingTaskLayout struct {
	TaskID   int       `json:"task_id"`
	PeriodUs int       `json:"period_us"`
	Vars     []RingVar `json:"vars"`
}

// RingVar is one addressed variable's slot inside a task's record payload.
type RingVar struct {
	Name string  `json:"name"`
	Type VarType `json:"type"`
	Size int     `json:"size"`
}

// IPC manager

// IPCManager manages the shared memory region and variable table.
// All methods are goroutine-safe.
type IPCManager struct {
	mu              sync.RWMutex
	shmPath         string // /dev/shm/<shm-name>
	shmSize         int    // Total number of mapped bytes
	mem             []byte // mmap region
	vars            map[string]Variable
	addressedVars   map[string]Variable // Subset where Address != ""
	apiPasswordHash string
	apiPasswordSalt string
	ringConfig      *RingConfig // payload layout for the capture ring (may be nil)

	// apiPasswordGen counts API password (hash/salt) changes; onAPIPasswordChange
	// runs after each one so issued bearer tokens are revoked (see APIManager).
	apiPasswordGen      uint64
	onAPIPasswordChange func()

	// flagLayoutSig fingerprints which variable owns which force-flag byte in
	// the loaded table; startedFlagSig is the fingerprint the runtime last
	// started with. See ClearForcesIfTableChanged.
	flagLayoutSig  string
	startedFlagSig string

	// mbox is the force-write command mailbox (SHM layout v2). nil when the
	// segment is too small to hold one (unit tests with a tiny segment).
	// ⚠️ Writers NEVER store into a data slot or a flag byte any more: the
	// runtime owns both and applies posted commands at a scan boundary.
	mbox *shmcmd.Mailbox
	// runtimeAlive reports whether the runtime process runs, so a write to a
	// stopped PLC fails at once instead of after the ack timeout.
	runtimeAlive func() bool
	// ackTimeout is derived from the loaded table's slowest task.
	ackTimeout time.Duration
	// tableGen counts applied variable tables. A stream that resolved offsets
	// from one table ends when it moves (/api/v1/stream/buffered).
	tableGen uint64
}

// forceFlagsBase is where the transpiler starts the force-flag region
// (FORCE_FLAGS_BASE in CTranspilerService.js): flag bytes run from here up to
// the command mailbox, data grows from 0 below it.
const forceFlagsBase = shmcmd.ForceFlagsBase

// ensureShmDir makes /dev/shm usable on minimal images (BusyBox/Yocto init
// often never creates it), where O_CREAT on /dev/shm/<name> fails with ENOENT
// and the agent used to exit(1) in a crash-restart loop. The runtime's
// shm_open() needs the same directory, so this fixes both processes.
// Everything here is best-effort: the mkdir alone is enough for mmap, the
// tmpfs mount is the correct POSIX setup and is attempted when the directory
// sits on a non-tmpfs filesystem (needs root; a failure is logged, not fatal).
func ensureShmDir() {
	const dir = "/dev/shm"
	if err := os.MkdirAll(dir, 0o1777); err != nil {
		slog.Warn("Could not create shared-memory directory", "dir", dir, "err", err)
		return
	}
	// Chmod separately: MkdirAll applies the umask, and 1777 is what other
	// (non-root) processes on the board expect.
	_ = os.Chmod(dir, 0o1777)

	const (
		tmpfsMagic = 0x01021994
		ramfsMagic = 0x858458f6
	)
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err == nil {
		if int64(st.Type) == tmpfsMagic || int64(st.Type) == ramfsMagic {
			return // already a tmpfs/ramfs mount — nothing to do
		}
	}
	if err := syscall.Mount("tmpfs", dir, "tmpfs", 0, "mode=1777"); err != nil {
		slog.Warn("Could not mount tmpfs on /dev/shm — using a plain directory",
			"err", err)
		return
	}
	slog.Info("Mounted tmpfs on /dev/shm")
}

// NewIPCManager opens (or creates) /dev/shm/<shmName> and memory maps it.
// The C++ runtime should open the same name using shm_open + ftruncate.
func NewIPCManager(shmName string, shmSize int) (*IPCManager, error) {
	ensureShmDir()
	shmPath := "/dev/shm/" + shmName

	// Open or create the file. The C++ side usually creates it first.
	fd, err := syscall.Open(shmPath, syscall.O_RDWR|syscall.O_CREAT, 0660)
	if err != nil {
		return nil, fmt.Errorf("failed to open shared memory file (%s): %w", shmPath, err)
	}
	defer syscall.Close(fd)

	// Ensure file size via ftruncate; C++ side should expect the same size.
	if err := syscall.Ftruncate(fd, int64(shmSize)); err != nil {
		return nil, fmt.Errorf("failed to set shared memory size: %w", err)
	}

	// PROT_READ|PROT_WRITE + MAP_SHARED: read/write, shared across processes.
	mem, err := syscall.Mmap(fd, 0, shmSize,
		syscall.PROT_READ|syscall.PROT_WRITE,
		syscall.MAP_SHARED,
	)
	if err != nil {
		return nil, fmt.Errorf("mmap failed: %w", err)
	}

	slog.Info("Shared memory mapped", "path", shmPath, "size_bytes", shmSize)

	m := &IPCManager{
		shmPath:    shmPath,
		shmSize:    shmSize,
		mem:        mem,
		vars:       make(map[string]Variable),
		ackTimeout: shmcmd.DefaultTimeout,
	}
	if shmSize >= shmcmd.SegmentSize {
		if mb, err := shmcmd.New(mem); err == nil {
			m.mbox = mb
		} else {
			slog.Warn("Force-write mailbox unavailable", "err", err)
		}
	} else {
		slog.Warn("Shared memory too small for the force-write mailbox — writes are refused", "size", shmSize, "need", shmcmd.SegmentSize)
	}
	return m, nil
}

// SetRuntimeAlive registers the "is the runtime process running" probe used
// by the write path. It must not take any lock a writer could hold.
func (m *IPCManager) SetRuntimeAlive(f func() bool) {
	m.mu.Lock()
	m.runtimeAlive = f
	m.mu.Unlock()
}

// TableGen returns the variable-table generation (bumped on every apply).
func (m *IPCManager) TableGen() uint64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.tableGen
}

// Close releases the mmap region.
func (m *IPCManager) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.mem == nil {
		return nil
	}
	if err := syscall.Munmap(m.mem); err != nil {
		return fmt.Errorf("munmap error: %w", err)
	}
	m.mem = nil
	slog.Info("Shared memory released", "path", m.shmPath)
	return nil
}

// parsedVariableTable is a fully validated table, ready to be applied.
type parsedVariableTable struct {
	table     VariableTable
	vars      map[string]Variable
	addressed map[string]Variable
	flagSig   string
}

// LoadVariableTable reads the JSON file from disk and updates the symbol table.
// If an error occurs, the previous table is preserved.
func (m *IPCManager) LoadVariableTable(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("failed to read file: %w", err)
	}
	pt, err := m.ParseVariableTable(data)
	if err != nil {
		return err
	}
	m.ApplyVariableTable(pt)
	slog.Info("Variable table loaded", "path", path, "count", len(pt.vars), "addressed", len(pt.addressed))
	return nil
}

// ParseVariableTable validates a table WITHOUT applying it, so a deploy can
// reject a bad upload before it replaces the good file on disk.
func (m *IPCManager) ParseVariableTable(data []byte) (*parsedVariableTable, error) {
	var table VariableTable
	if err := json.Unmarshal(data, &table); err != nil {
		return nil, fmt.Errorf("JSON parse error: %w", err)
	}

	// Validate table consistency.
	newVars := make(map[string]Variable, len(table.Variables))
	var sig strings.Builder
	for _, v := range table.Variables {
		if v.Name == "" {
			return nil, fmt.Errorf("empty variable name detected")
		}
		if v.Type == VarString {
			if v.Size < 1 || v.Size > maxStringBytes {
				return nil, fmt.Errorf("string variable '%s' has size %d, expected 1..%d", v.Name, v.Size, maxStringBytes)
			}
		} else {
			expectedSize, ok := typeSizeMap[v.Type]
			if !ok {
				return nil, fmt.Errorf("unsupported type: %s (variable: %s)", v.Type, v.Name)
			}
			if v.Size != expectedSize {
				return nil, fmt.Errorf("size mismatch: expected %d for %s, got %d", expectedSize, v.Name, v.Size)
			}
		}
		// Offsets come from an uploaded file and must be treated as untrusted:
		// a negative or overflowing offset would pass a naive `offset+size >
		// shmSize` check and panic on the first slice access — with AutoRun
		// that panic happens in WriteInitialValues on the MAIN goroutine at
		// startup, crash-looping the agent as the bad table is rehydrated on
		// every restart. The subtraction form avoids integer overflow.
		if v.Offset < 0 || v.Size <= 0 || v.Offset > m.shmSize-v.Size {
			return nil, fmt.Errorf("variable '%s' exceeds shared memory bounds (offset=%d size=%d shm_size=%d)",
				v.Name, v.Offset, v.Size, m.shmSize)
		}
		// Force flag is a single byte; 0 means "no force flag". Its index is
		// what a mailbox command carries, so it must sit in the flag region —
		// below the mailbox, which a v2 runtime owns. Validate at load time so
		// write paths can trust it.
		if v.ForceFlagOffset < 0 || v.ForceFlagOffset >= m.shmSize ||
			(v.ForceFlagOffset > 0 && (v.ForceFlagOffset < forceFlagsBase || v.ForceFlagOffset >= shmcmd.MailboxBase)) {
			return nil, fmt.Errorf("variable '%s' force flag outside the flag region (force_flag_offset=%d, region [%d,%d))",
				v.Name, v.ForceFlagOffset, forceFlagsBase, shmcmd.MailboxBase)
		}
		if v.Offset+v.Size > forceFlagsBase {
			return nil, fmt.Errorf("variable '%s' overlaps the force-flag region (offset=%d size=%d)", v.Name, v.Offset, v.Size)
		}
		if _, dup := newVars[v.Name]; dup {
			return nil, fmt.Errorf("duplicate variable name: %s", v.Name)
		}
		newVars[v.Name] = v
		fmt.Fprintf(&sig, "%s|%d|%d|%d|%s\n", v.Name, v.Offset, v.Size, v.ForceFlagOffset, v.Type)
	}

	addressed := make(map[string]Variable, len(newVars))
	for name, v := range newVars {
		if v.Address != "" {
			addressed[name] = v
		}
	}
	return &parsedVariableTable{table: table, vars: newVars, addressed: addressed, flagSig: sig.String()}, nil
}

// ApplyVariableTable installs a table returned by ParseVariableTable.
func (m *IPCManager) ApplyVariableTable(pt *parsedVariableTable) {
	m.mu.Lock()
	m.vars = pt.vars
	m.addressedVars = pt.addressed
	pwChanged := m.apiPasswordHash != pt.table.APIPasswordHash || m.apiPasswordSalt != pt.table.APIPasswordSalt
	m.apiPasswordHash = pt.table.APIPasswordHash
	m.apiPasswordSalt = pt.table.APIPasswordSalt
	if pwChanged {
		m.apiPasswordGen++
	}
	hook := m.onAPIPasswordChange
	m.ringConfig = pt.table.Ring
	m.flagLayoutSig = pt.flagSig
	m.ackTimeout = ackTimeoutFor(&pt.table)
	m.tableGen++
	m.mu.Unlock()

	if pwChanged && hook != nil {
		hook()
	}
}

// ackTimeoutFor sizes the force-write ack timeout from the table's slowest
// task (see shmcmd.TimeoutFor).
func ackTimeoutFor(t *VariableTable) time.Duration {
	var maxUs int64
	if t.ShmLayout != nil {
		maxUs = t.ShmLayout.MaxTaskIntervalUs
	}
	for _, tk := range t.Tasks {
		if tk.IntervalUs > maxUs {
			maxUs = tk.IntervalUs
		}
	}
	return shmcmd.TimeoutFor(maxUs)
}

// SetAPIPasswordChangeHook registers the callback run after the API password
// hash or salt changes (a new table with a different password, or none).
func (m *IPCManager) SetAPIPasswordChangeHook(f func()) {
	m.mu.Lock()
	m.onAPIPasswordChange = f
	m.mu.Unlock()
}

// APIPasswordGen returns the API password generation (bumped on each change).
func (m *IPCManager) APIPasswordGen() uint64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.apiPasswordGen
}

// MarkTableStarted records the loaded table as the one the runtime runs with,
// without clearing anything. Used at agent startup for the rehydrated table:
// the flags in /dev/shm (if any survived) were set against that same table.
func (m *IPCManager) MarkTableStarted() {
	m.mu.Lock()
	m.startedFlagSig = m.flagLayoutSig
	m.mu.Unlock()
}

// ClearForcesIfTableChanged zeroes the WHOLE force-flag region when the loaded
// table maps flags differently from the one the runtime last started with.
// Called from the pre-start hook (old runtime stopped, new one not spawned).
//
// ⚠️ A flag's byte is FORCE_FLAGS_BASE + the variable's INDEX, not something
// tied to its name: after a redeploy that inserted or removed a variable, a
// flag left set by the old table pins a DIFFERENT variable of the new one —
// forced, invisibly, and ClearAllForces (which walks the NEW table) cannot
// reach a byte the new table no longer names. A crash-restart or a restart with
// the same table keeps its forces (same layout ⇒ same meaning; the new runtime
// reloads each surviving forced value from its slot in plc_mb_init).
//
// ⚠️ This is the ONE place a writer still stores into the flag bytes directly,
// which the v2 protocol otherwise forbids (the runtime owns them). It is safe
// only because it runs from the pre-start hook: the previous runtime has
// exited and the next one has not been spawned, so there is no consumer to
// race — a mailbox command would have nobody to apply it. Do not call it from
// anywhere a runtime may be running.
func (m *IPCManager) ClearForcesIfTableChanged() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.flagLayoutSig == m.startedFlagSig {
		return
	}
	m.startedFlagSig = m.flagLayoutSig
	if m.mem == nil || len(m.mem) <= forceFlagsBase {
		return
	}
	cleared := shmcmd.ClearFlags(m.mem, m.dataByteMaskLocked())
	slog.Info("Variable table changed since last start — force-flag region cleared", "flags_cleared", cleared)
}

// dataByteMaskLocked returns a predicate for "off is a byte the loaded table
// uses as DATA" (a project whose data region overran the flag base — the
// transpiler refuses that, but the table is an untrusted upload, and a flag
// clear must never zero somebody's value). Caller holds m.mu.
func (m *IPCManager) dataByteMaskLocked() func(int) bool {
	isData := make([]bool, len(m.mem))
	for _, v := range m.vars {
		for i := v.Offset; i < v.Offset+v.Size && i < len(isData); i++ {
			if i >= 0 {
				isData[i] = true
			}
		}
	}
	return func(off int) bool { return off < len(isData) && isData[off] }
}

// ResetMailbox drops every pending force-write command and unpublishes the
// mailbox until the next runtime initialises it. Pre-start hook ONLY: a
// command posted against the previous runtime (and table) must never be
// applied by the next one — its writer has already been told it failed.
func (m *IPCManager) ResetMailbox() {
	if m.mbox != nil {
		m.mbox.Reset()
	}
}

// VariableCount returns the number of loaded variables.
func (m *IPCManager) VariableCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.vars)
}

// Read operations

// ReadVariable reads the requested variable from shared memory and returns a Go value.
// Returned values are chosen to be JSON-serializable.
func (m *IPCManager) ReadVariable(name string) (any, error) {
	m.mu.RLock()
	v, ok := m.vars[name]
	mem := m.mem
	m.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("variable not found: %s", name)
	}
	if mem == nil {
		return nil, fmt.Errorf("shared memory is closed")
	}

	return decodeSlot(mem, v)
}

// decodeSlot reads one slot with a single atomic access where the slot allows
// it (SHM layout v2 aligns every slot to its width), so a reader can never see
// half of an old LREAL and half of a new one. Text is a plain copy (read-only,
// 64 bytes, a torn line is possible and tolerated).
func decodeSlot(mem []byte, v Variable) (any, error) {
	if v.Type == VarString || v.Size > 8 {
		return decodeValue(v.Type, mem[v.Offset:v.Offset+v.Size])
	}
	var b [8]byte
	shmcmd.LoadScalar(mem, v.Offset, v.Size, b[:])
	return decodeValue(v.Type, b[:v.Size])
}

// ReadAllVariables reads all variables at once and returns them as a map.
// Variables that fail to decode are skipped silently.
func (m *IPCManager) ReadAllVariables() (map[string]any, error) {
	m.mu.RLock()
	vars := m.vars
	mem := m.mem
	m.mu.RUnlock()

	if mem == nil {
		return nil, fmt.Errorf("shared memory is closed")
	}

	result := make(map[string]any, len(vars))
	for name, v := range vars {
		val, err := decodeSlot(mem, v)
		if err != nil {
			continue
		}
		result[name] = val
	}
	return result, nil
}

// ReadVariablesFiltered is ReadAllVariables restricted to the names `match`
// accepts. The editor stream uses it to send only what is on screen (the open
// POUs, the watch table, the HMI bindings) instead of every variable in the
// project on every 50 ms tick.
//
// ⚠️ Matching happens per tick against the CURRENT table, not against a subset
// resolved when the connection opened: a redeploy replaces m.vars underneath a
// live stream, and a cached subset would then decode names that no longer
// exist at the offsets they used to have.
func (m *IPCManager) ReadVariablesFiltered(match func(string) bool) (map[string]any, error) {
	if match == nil {
		return m.ReadAllVariables()
	}
	m.mu.RLock()
	vars := m.vars
	mem := m.mem
	m.mu.RUnlock()

	if mem == nil {
		return nil, fmt.Errorf("shared memory is closed")
	}

	result := make(map[string]any, len(vars))
	for name, v := range vars {
		if !match(name) {
			continue
		}
		val, err := decodeSlot(mem, v)
		if err != nil {
			continue
		}
		result[name] = val
	}
	return result, nil
}

// decodeValue converts raw bytes to the requested type.
// All multi-byte values are interpreted as Little Endian (natural order on ARM/x86).
func decodeValue(t VarType, b []byte) (any, error) {
	switch t {
	case VarBool:
		return b[0] != 0, nil
	case VarInt8:
		return int8(b[0]), nil
	case VarUint8:
		return b[0], nil
	case VarInt16:
		return int16(binary.LittleEndian.Uint16(b)), nil
	case VarUint16:
		return binary.LittleEndian.Uint16(b), nil
	case VarInt32:
		return int32(binary.LittleEndian.Uint32(b)), nil
	case VarUint32:
		return binary.LittleEndian.Uint32(b), nil
	case VarInt64:
		return int64(binary.LittleEndian.Uint64(b)), nil
	case VarUint64:
		return binary.LittleEndian.Uint64(b), nil
	case VarFloat32:
		f := math.Float32frombits(binary.LittleEndian.Uint32(b))
		if f64 := float64(f); math.IsNaN(f64) || math.IsInf(f64, 0) {
			return nil, nil // NaN/±Inf → JSON null, see VarFloat64
		}
		return f, nil
	case VarFloat64:
		f := math.Float64frombits(binary.LittleEndian.Uint64(b))
		if math.IsNaN(f) || math.IsInf(f, 0) {
			// ⚠️ NaN/±Inf have no JSON spelling: encoding/json REFUSES the whole
			// map, so one REAL that divided by zero used to blank every frame of
			// /stream/vars and /api/v1/stream (the editor then read the PLC as
			// dead) and turned /api/v1/variables into a 200 with an empty body.
			// protojson rejects a non-finite google.protobuf.Value the same way,
			// so the ConnectRPC StreamVars path needs it too. Every consumer of
			// decodeValue serializes, so the value becomes JSON null here — the
			// one place all of them share — instead of at each encoder.
			return nil, nil
		}
		return f, nil
	case VarString:
		// NUL-terminated inside a fixed slot; a full slot has no terminator.
		// ToValidUTF8 guards the JSON encoder: the bytes come from a device
		// file, and one stray byte would otherwise make the whole variable
		// frame unmarshalable for every client.
		if i := bytes.IndexByte(b, 0); i >= 0 {
			b = b[:i]
		}
		return strings.ToValidUTF8(string(b), ""), nil
	default:
		return nil, fmt.Errorf("decode: unknown type: %s", t)
	}
}

// Write operations

// WriteVariable force-writes (FORCE: write once and hold) — the historical
// behaviour of every write endpoint. See WriteVariableMode.
func (m *IPCManager) WriteVariable(name string, rawVal json.RawMessage) error {
	return m.WriteVariableMode(name, rawVal, shmcmd.OpForce)
}

// WriteVariableMode posts one command to the runtime's force-write mailbox and
// returns only after the runtime has APPLIED it (or with an *shmcmd.Error
// saying why not — map it with shmcmd.HTTPStatus). op is OpForce, OpPulse
// (write once, logic owns it from the same scan) or OpUnforce (release; a
// non-empty rawVal is also written once).
//
// ⚠️ Nothing here stores into the data slot or the flag byte. The old "copy
// value, then set flag" pair raced plc_shm_sync: a sync between the two
// stores overwrote the new value and the flag then pinned the OLD one — while
// the request returned 200.
func (m *IPCManager) WriteVariableMode(name string, rawVal json.RawMessage, op shmcmd.Op) error {
	m.mu.RLock()
	v, ok := m.vars[name]
	mb, alive, timeout := m.mbox, m.runtimeAlive, m.ackTimeout
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("variable not found: %s", name)
	}
	if mb == nil {
		return &shmcmd.Error{Kind: shmcmd.KindMismatch, Msg: "shared memory segment too small for the force-write mailbox (start KronServer with -shm-size 65536)"}
	}
	if v.ForceFlagOffset == 0 {
		return &shmcmd.Error{Kind: shmcmd.KindInvalid, Msg: fmt.Sprintf("variable '%s' has no force slot", name)}
	}
	var encoded []byte
	hasValue := op != shmcmd.OpUnforce || (len(rawVal) > 0 && string(rawVal) != "null")
	if hasValue {
		var err error
		encoded, err = encodeValue(v.Type, rawVal)
		if err != nil {
			return &shmcmd.Error{Kind: shmcmd.KindInvalid, Msg: fmt.Sprintf("value encode error (%s): %v", name, err)}
		}
		if len(encoded) != v.Size {
			return &shmcmd.Error{Kind: shmcmd.KindInvalid, Msg: fmt.Sprintf("encode size mismatch: expected %d, produced %d", v.Size, len(encoded))}
		}
	}
	err := mb.Post(shmcmd.Command{
		Index: uint32(v.ForceFlagOffset - forceFlagsBase),
		Op:    op,
		Value: encoded,
	}, shmcmd.WaitOptions{Timeout: timeout, Alive: alive})
	if err != nil {
		return err
	}
	slog.Debug("Force-write applied", "name", name, "type", v.Type, "op", op)
	return nil
}

// ClearAllForces releases every force. With a runtime running it is ONE
// mailbox command (the runtime owns the flags); with none running the flag
// bytes are cleared directly — there is no consumer to race, and a command
// would sit unapplied until the next start drops it anyway.
func (m *IPCManager) ClearAllForces() error {
	m.mu.RLock()
	mb, alive, timeout := m.mbox, m.runtimeAlive, m.ackTimeout
	m.mu.RUnlock()

	if alive != nil && !alive() {
		m.mu.Lock()
		if m.mem != nil {
			shmcmd.ClearFlags(m.mem, m.dataByteMaskLocked())
		}
		m.mu.Unlock()
		slog.Info("All force flags cleared (runtime stopped)")
		return nil
	}
	if mb == nil {
		return &shmcmd.Error{Kind: shmcmd.KindMismatch, Msg: "shared memory segment too small for the force-write mailbox"}
	}
	if err := mb.Post(shmcmd.Command{Op: shmcmd.OpClearAll}, shmcmd.WaitOptions{Timeout: timeout, Alive: alive}); err != nil {
		return err
	}
	slog.Info("All force flags cleared")
	return nil
}

// encodeValue converts a raw JSON value into a Little Endian byte slice.
func encodeValue(t VarType, raw json.RawMessage) ([]byte, error) {
	if t == VarString {
		// The runtime has no pull path for text (see VarString), so a write
		// would land in the mirror and be overwritten on the next scan with
		// no sign anything went wrong. Refuse instead of pretending.
		return nil, fmt.Errorf("string variables are read-only")
	}
	buf := make([]byte, typeSizeMap[t])

	// Coerce string payloads like "1", "0", "true" to typed JSON values.
	raw = normalizeRawValue(raw)

	switch t {
	case VarBool:
		var v bool
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		if v {
			buf[0] = 1
		}
	case VarInt8:
		var v int8
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		buf[0] = byte(v)
	case VarUint8:
		var v uint8
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		buf[0] = v
	case VarInt16:
		var v int16
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		binary.LittleEndian.PutUint16(buf, uint16(v))
	case VarUint16:
		var v uint16
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		binary.LittleEndian.PutUint16(buf, v)
	case VarInt32:
		var v int32
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		binary.LittleEndian.PutUint32(buf, uint32(v))
	case VarUint32:
		var v uint32
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		binary.LittleEndian.PutUint32(buf, v)
	case VarInt64:
		var v int64
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		binary.LittleEndian.PutUint64(buf, uint64(v))
	case VarUint64:
		var v uint64
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		binary.LittleEndian.PutUint64(buf, v)
	case VarFloat32:
		var v float32
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		binary.LittleEndian.PutUint32(buf, math.Float32bits(v))
	case VarFloat64:
		var v float64
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		binary.LittleEndian.PutUint64(buf, math.Float64bits(v))
	default:
		return nil, fmt.Errorf("encode: unknown type: %s", t)
	}

	return buf, nil
}

func normalizeRawValue(raw json.RawMessage) json.RawMessage {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return raw
	}

	t := strings.TrimSpace(s)
	if t == "" {
		return raw
	}

	if strings.EqualFold(t, "true") || strings.EqualFold(t, "false") {
		if b, err := json.Marshal(strings.EqualFold(t, "true")); err == nil {
			return b
		}
		return raw
	}

	if n, err := strconv.ParseInt(t, 10, 64); err == nil {
		if b, mErr := json.Marshal(n); mErr == nil {
			return b
		}
		return raw
	}
	// ULINT/LWORD above MaxInt64. A decimal STRING is how a 64-bit integer
	// survives JSON clients (JS numbers, protobuf Value) that hold doubles.
	if n, err := strconv.ParseUint(t, 10, 64); err == nil {
		if b, mErr := json.Marshal(n); mErr == nil {
			return b
		}
		return raw
	}

	if f, err := strconv.ParseFloat(t, 64); err == nil {
		if b, mErr := json.Marshal(f); mErr == nil {
			return b
		}
	}

	return raw
}

// ReadAddressedVariables reads only addressed variables from shared memory.
func (m *IPCManager) ReadAddressedVariables() (map[string]any, error) {
	m.mu.RLock()
	vars := m.addressedVars
	mem := m.mem
	m.mu.RUnlock()

	if mem == nil {
		return nil, fmt.Errorf("shared memory is closed")
	}

	result := make(map[string]any, len(vars))
	for name, v := range vars {
		val, err := decodeSlot(mem, v)
		if err != nil {
			continue
		}
		result[name] = val
	}
	return result, nil
}

// ForcedVariables returns the sorted names of every variable whose force-flag
// byte marks a held value (RING_FORMAT.md § "Variable segment": 0x81). The flag
// bytes are RUNTIME-owned; this only reads them, one byte load each, against
// the CURRENT table. addressedOnly restricts it to the REST scope.
func (m *IPCManager) ForcedVariables(addressedOnly bool) []string {
	m.mu.RLock()
	vars := m.vars
	if addressedOnly {
		vars = m.addressedVars
	}
	mem := m.mem
	m.mu.RUnlock()
	return forcedNames(mem, vars)
}

// forcedNames is ForcedVariables over an explicit table (split out for tests).
func forcedNames(mem []byte, vars map[string]Variable) []string {
	out := []string{}
	if mem == nil {
		return out
	}
	for name, v := range vars {
		if v.ForceFlagOffset > 0 && shmcmd.IsForced(mem, v.ForceFlagOffset) {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// IsAddressed returns true if the variable is marked as addressed.
func (m *IPCManager) IsAddressed(name string) bool {
	m.mu.RLock()
	_, ok := m.addressedVars[name]
	m.mu.RUnlock()
	return ok
}

// CheckAPIPassword verifies the given password against the stored hash.
// Returns false if no password is configured (API disabled).
func (m *IPCManager) CheckAPIPassword(password string) bool {
	m.mu.RLock()
	h, s := m.apiPasswordHash, m.apiPasswordSalt
	m.mu.RUnlock()
	if h == "" {
		return false
	}
	// Constant-time compare to avoid leaking hash prefixes via timing.
	return subtle.ConstantTimeCompare([]byte(hashPassword(s, password)), []byte(h)) == 1
}

// APIEnabled returns true if an API password is configured.
func (m *IPCManager) APIEnabled() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.apiPasswordHash != ""
}

// WriteInitialValues writes the initial values from variable_table.json to
// shared memory. Called when the runtime starts to ensure variables begin at
// their configured initial values.
func (m *IPCManager) WriteInitialValues() {
	m.mu.RLock()
	vars := m.vars
	mem := m.mem
	m.mu.RUnlock()

	if mem == nil {
		return
	}

	count := 0
	for _, v := range vars {
		if len(v.InitialValue) == 0 {
			continue
		}
		encoded, err := encodeValue(v.Type, v.InitialValue)
		if err != nil {
			slog.Debug("Skip initial value", "name", v.Name, "err", err)
			continue
		}
		if len(encoded) != v.Size {
			continue
		}
		// A force that survives this restart (same table) keeps its forced
		// value in the slot: the new runtime reloads it from there.
		if v.ForceFlagOffset > 0 && v.ForceFlagOffset < len(mem) && mem[v.ForceFlagOffset] != 0 {
			continue
		}
		m.mu.Lock()
		shmcmd.StoreScalar(mem, v.Offset, encoded)
		m.mu.Unlock()
		count++
	}
	slog.Info("Initial values written to SHM", "count", count)
}

// AddressedVarInfo returns the Variable metadata for an addressed variable.
func (m *IPCManager) AddressedVarInfo(name string) (Variable, bool) {
	m.mu.RLock()
	v, ok := m.addressedVars[name]
	m.mu.RUnlock()
	return v, ok
}

// RingConfig returns the capture-ring payload layout (nil if the project has no
// addressed variables / no ring).
func (m *IPCManager) RingConfig() *RingConfig {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.ringConfig
}

// AppendRawSample appends the current raw little-endian bytes of each variable
// (in the given order) to dst and returns the extended slice. Values are the
// native SHM representation, ready to ship over the binary buffered stream. One
// RLock covers the whole sample so all variables come from the same instant.
// Out-of-range variables are zero-padded to keep the frame layout fixed.
func (m *IPCManager) AppendRawSample(vars []Variable, dst []byte) []byte {
	m.mu.RLock()
	mem := m.mem
	for i := range vars {
		v := &vars[i]
		if v.Size > 0 && v.Size <= 8 && v.Offset >= 0 && v.Offset+v.Size <= len(mem) {
			var b [8]byte
			shmcmd.LoadScalar(mem, v.Offset, v.Size, b[:])
			dst = append(dst, b[:v.Size]...)
		} else {
			for n := 0; n < v.Size; n++ {
				dst = append(dst, 0)
			}
		}
	}
	m.mu.RUnlock()
	return dst
}

// typeSizeMap defines the byte size of each type.
var typeSizeMap = map[VarType]int{
	VarBool:    1,
	VarInt8:    1,
	VarUint8:   1,
	VarInt16:   2,
	VarUint16:  2,
	VarInt32:   4,
	VarUint32:  4,
	VarInt64:   8,
	VarUint64:  8,
	VarFloat32: 4,
	VarFloat64: 8,
}
