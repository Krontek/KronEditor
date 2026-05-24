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
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
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
)

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
	Variables       []Variable `json:"variables"`
	APIPasswordHash string     `json:"api_password_hash,omitempty"`
	APIPasswordSalt string     `json:"api_password_salt,omitempty"`
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
}

// NewIPCManager opens (or creates) /dev/shm/<shmName> and memory maps it.
// The C++ runtime should open the same name using shm_open + ftruncate.
func NewIPCManager(shmName string, shmSize int) (*IPCManager, error) {
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

	return &IPCManager{
		shmPath: shmPath,
		shmSize: shmSize,
		mem:     mem,
		vars:    make(map[string]Variable),
	}, nil
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

// LoadVariableTable reads the JSON file from disk and updates the symbol table.
// If an error occurs, the previous table is preserved.
func (m *IPCManager) LoadVariableTable(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("failed to read file: %w", err)
	}

	var table VariableTable
	if err := json.Unmarshal(data, &table); err != nil {
		return fmt.Errorf("JSON parse error: %w", err)
	}

	// Validate table consistency.
	newVars := make(map[string]Variable, len(table.Variables))
	for _, v := range table.Variables {
		if v.Name == "" {
			return fmt.Errorf("empty variable name detected")
		}
		expectedSize, ok := typeSizeMap[v.Type]
		if !ok {
			return fmt.Errorf("unsupported type: %s (variable: %s)", v.Type, v.Name)
		}
		if v.Size != expectedSize {
			return fmt.Errorf("size mismatch: expected %d for %s, got %d", expectedSize, v.Name, v.Size)
		}
		end := v.Offset + v.Size
		if end > m.shmSize {
			return fmt.Errorf("variable '%s' exceeds shared memory bounds (offset=%d size=%d shm_size=%d)",
				v.Name, v.Offset, v.Size, m.shmSize)
		}
		if _, dup := newVars[v.Name]; dup {
			return fmt.Errorf("duplicate variable name: %s", v.Name)
		}
		newVars[v.Name] = v
	}

	addressed := make(map[string]Variable, len(newVars))
	for name, v := range newVars {
		if v.Address != "" {
			addressed[name] = v
		}
	}

	m.mu.Lock()
	m.vars = newVars
	m.addressedVars = addressed
	m.apiPasswordHash = table.APIPasswordHash
	m.apiPasswordSalt = table.APIPasswordSalt
	m.mu.Unlock()

	slog.Info("Variable table loaded", "path", path, "count", len(newVars), "addressed", len(addressed))
	return nil
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

	slice := mem[v.Offset : v.Offset+v.Size]
	return decodeValue(v.Type, slice)
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
		slice := mem[v.Offset : v.Offset+v.Size]
		val, err := decodeValue(v.Type, slice)
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
		bits := binary.LittleEndian.Uint32(b)
		return math.Float32frombits(bits), nil
	case VarFloat64:
		bits := binary.LittleEndian.Uint64(b)
		return math.Float64frombits(bits), nil
	default:
		return nil, fmt.Errorf("decode: unknown type: %s", t)
	}
}

// Write operations

// WriteVariable writes a raw JSON value to the variable offset in shared memory
// and sets the force flag so the PLC runtime will not overwrite this value
// with its computed result during plc_shm_sync.
func (m *IPCManager) WriteVariable(name string, rawVal json.RawMessage) error {
	m.mu.RLock()
	v, ok := m.vars[name]
	mem := m.mem
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("variable not found: %s", name)
	}
	if mem == nil {
		return fmt.Errorf("shared memory is closed")
	}

	encoded, err := encodeValue(v.Type, rawVal)
	if err != nil {
		return fmt.Errorf("value encode error (%s): %w", name, err)
	}
	if len(encoded) != v.Size {
		return fmt.Errorf("encode size mismatch: expected %d, produced %d", v.Size, len(encoded))
	}

	// Protect mmap writes with a mutex to avoid race conditions.
	m.mu.Lock()
	copy(mem[v.Offset:v.Offset+v.Size], encoded)
	// Set force flag so plc_shm_sync skips overwriting this variable.
	if v.ForceFlagOffset > 0 && v.ForceFlagOffset < len(mem) {
		mem[v.ForceFlagOffset] = 1
	}
	m.mu.Unlock()

	slog.Debug("Shared memory force-written", "name", name, "type", v.Type, "offset", v.Offset, "flag_offset", v.ForceFlagOffset)
	return nil
}

// ClearAllForces clears all force flags so the PLC runtime resumes normal sync.
func (m *IPCManager) ClearAllForces() {
	m.mu.RLock()
	vars := m.vars
	mem := m.mem
	m.mu.RUnlock()

	if mem == nil {
		return
	}

	m.mu.Lock()
	for _, v := range vars {
		if v.ForceFlagOffset > 0 && v.ForceFlagOffset < len(mem) {
			mem[v.ForceFlagOffset] = 0
		}
	}
	m.mu.Unlock()

	slog.Info("All force flags cleared")
}

// encodeValue converts a raw JSON value into a Little Endian byte slice.
func encodeValue(t VarType, raw json.RawMessage) ([]byte, error) {
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
		slice := mem[v.Offset : v.Offset+v.Size]
		val, err := decodeValue(v.Type, slice)
		if err != nil {
			continue
		}
		result[name] = val
	}
	return result, nil
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
	return hashPassword(s, password) == h
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
		m.mu.Lock()
		copy(mem[v.Offset:v.Offset+v.Size], encoded)
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
