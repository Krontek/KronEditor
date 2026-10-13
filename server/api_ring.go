// api_ring.go — lossless capture-ring streaming + adaptive decimation control.
//
//	GET /api/v1/stream/ring   binary stream of EVERY kept scan record
//	GET /api/v1/ring/info     JSON: header + payload layout so a client can decode
//
// The producer (PLC runtime) appends addressed-variable records into the ring at
// scan rate. This endpoint drains them in order and pushes them to the client
// every 5 ms. A single server-owned controller measures each client's delivered
// rate and the ring backlog, then writes a global decimation stride N back into
// the ring header so production is thinned to whatever the slowest link can take
// — keeping the ring from ever swelling. See server/RING_FORMAT.md.
package main

import (
	"encoding/binary"
	"math"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// ---- shared ring handle (one mmap, many drainers) --------------------------

// sharedRing lazily opens ONE RingConsumer for the whole server. Every stream
// connection drains it with its own local readSeq (Drain is read-only on the
// map); only the controller writes stride_N.
func (am *APIManager) sharedRing() (*RingConsumer, error) {
	am.ringMu.Lock()
	defer am.ringMu.Unlock()
	if am.ring != nil {
		return am.ring, nil
	}
	rc, err := OpenRing(am.shmName)
	if err != nil {
		return nil, err
	}
	am.ring = rc
	am.ringCtl = newRingController(rc)
	return rc, nil
}

// resizeRing (re)sizes the ring segment before a runtime start. When the shared
// consumer has it mapped the resize goes through RingConsumer.Resize (shrink-
// safe); otherwise ringMu is held across the truncate so a concurrent
// sharedRing() cannot map the old, larger size in between.
func (am *APIManager) resizeRing(bytes uint64) error {
	am.ringMu.Lock()
	defer am.ringMu.Unlock()
	if am.ring != nil {
		return am.ring.Resize(bytes)
	}
	return createRingSegment(am.shmName, bytes)
}

// ---- adaptive decimation controller ----------------------------------------

const (
	ringAlpha     = 0.9       // stay strictly under the link: target α·D
	ringNmax      = 1_000_000 // decimation cap; `dropped` is the honest overflow signal
	ringFillHigh  = 0.5       // backlog fraction that triggers grow-fast
	ringFillLow   = 0.10      // backlog fraction under which we may relax
	ringTickMs    = 100       // control cadence
	ringDeliverMs = 5         // client push cadence
	// ⚠️ Cap the bytes drained into ONE frame. Without it, a client attaching to
	// an already-running high-rate producer drains the WHOLE ring in the first
	// tick (nslots records × record_stride) — on a 2 GiB ring that is gigabytes of
	// allocation in one shot and OOM-kills the agent. Excess backlog is left for
	// the next 5 ms tick (or lapped + counted as dropped if production outruns the
	// link, which is exactly when the controller raises the stride).
	ringMaxFrameBytes = 4 << 20 // 4 MiB
)

type ringClientStat struct {
	dBps    float64 // measured delivered bytes/s (EWMA), 0 = not measured yet
	backlog uint64  // write_seq - readSeq at last report
	readSeq uint64  // this client's drain cursor (for min-across-clients reclaim)
}

type ringController struct {
	mu      sync.Mutex
	rc      *RingConsumer
	clients map[int]*ringClientStat
	nextID  int
	n       uint32
	// running is true while a loop() goroutine exists. ⚠️ Only loop() itself
	// clears it (under mu, when it finds no clients): unregister used to clear
	// it, and a reconnect inside the 100 ms tick then started a SECOND loop
	// while the first was still alive — each extra loop doubling the stride
	// and the reclaim rate.
	running bool
}

func newRingController(rc *RingConsumer) *ringController {
	return &ringController{rc: rc, clients: map[int]*ringClientStat{}, n: 1}
}

func (c *ringController) register() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	id := c.nextID
	c.nextID++
	if len(c.clients) == 0 {
		// First client after an idle period: start at full fidelity. The stride
		// left over from the previous session measured a DIFFERENT link (maybe
		// a congested one that is long gone); resuming at it delivered a thinned
		// stream until the controller relaxed it back down.
		c.n = 1
	}
	c.clients[id] = &ringClientStat{}
	// Resume the producer immediately (don't wait for the first control tick) —
	// the runtime is PAUSED (stride_N=0) while no consumer is connected, so this
	// is what starts capture.
	if c.n < 1 {
		c.n = 1
	}
	c.rc.SetStrideN(c.n)
	if !c.running {
		c.running = true
		go c.loop()
	}
	return id
}

func (c *ringController) report(id int, dBps float64, backlog, readSeq uint64) {
	c.mu.Lock()
	if s := c.clients[id]; s != nil {
		s.dBps = dBps
		s.backlog = backlog
		s.readSeq = readSeq
	}
	c.mu.Unlock()
}

func (c *ringController) unregister(id int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.clients, id)
	if len(c.clients) != 0 {
		return
	}
	// PAUSE the producer: stride_N=0 tells the runtime to stop writing to the
	// ring entirely while nobody is listening — no wasted scan cycles and the
	// ring stops filling RAM. register() resumes it on the next connect.
	c.rc.SetStrideN(0)
	// Release the whole ring's pages while idle → RSS ~0.
	// ⚠️ Under c.mu, NOT after releasing it: a register() slipping in between
	// would resume the producer and then have its fresh records punched into
	// holes. Holding c.mu makes "no clients" and the punch one atomic step
	// (lock order c.mu → rc.mu, same as the control loop).
	c.rc.ReclaimAll()
}

// loop is the ~100 ms control tick. AIMD-style: grow the stride fast when the
// backlog rises, relax it slowly toward the analytic floor ceil(P/(α·minD)).
func (c *ringController) loop() {
	t := time.NewTicker(ringTickMs * time.Millisecond)
	defer t.Stop()
	for range t.C {
		c.mu.Lock()
		if len(c.clients) == 0 {
			c.running = false // only the loop clears it, see the field comment
			c.mu.Unlock()
			return
		}
		minD := math.Inf(1)
		var maxBacklog uint64
		minRead := ^uint64(0)
		for _, s := range c.clients {
			if s.dBps > 0 && s.dBps < minD {
				minD = s.dBps
			}
			if s.backlog > maxBacklog {
				maxBacklog = s.backlog
			}
			if s.readSeq < minRead {
				minRead = s.readSeq // free only up to the SLOWEST client's cursor
			}
		}
		n := c.n
		nslots := float64(c.rc.Nslots())
		fill := 0.0
		if nslots > 0 {
			fill = float64(maxBacklog) / nslots
		}
		P := c.rc.WireBytesPerSec() // same unit as D (whole frames), see WireBytesPerSec

		// analytic floor: smallest stride that keeps αD ≥ P/N
		floor := uint32(1)
		if !math.IsInf(minD, 1) && minD > 0 && P > 0 {
			floor = uint32(math.Ceil(P / (ringAlpha * minD)))
			if floor < 1 {
				floor = 1
			}
		}

		// ⚠️ The analytic floor applies only while there IS a backlog. With
		// the backlog under ringFillLow the link is keeping up, and D then
		// measures UTILISATION (what we chose to send), not capacity — at a high
		// stride there is little to send, so D collapses and ceil(P/(α·D)) held
		// the stride up by itself: a one-way trap. Below the low watermark we
		// relax freely; if the link really can't take it, the backlog rises and
		// the floor / grow-fast branches catch it.
		switch {
		case fill > ringFillHigh:
			n *= 2 // grow-fast: backlog building, halve production now
		case fill > ringFillLow && n < floor:
			n = floor // jump up to the sustainable rate
		case fill < ringFillLow && n > 1:
			// Shrink toward best fidelity — MULTIPLICATIVELY.
			//
			// ⚠️ This was `n--`, one step per 100 ms tick, against a grow branch
			// that DOUBLES. A burst that took the stride to 2048 in eleven ticks
			// then needed 2047 ticks — three and a half minutes — to walk back,
			// and any single backlog blip on the way re-doubled it. Measured in
			// the field: a 100 kHz counter stuck at stride ~1500, delivering
			// 0.08% of scans, the stride falling by exactly 10 per second and
			// never arriving. Ten percent per tick recovers from 2048 in about
			// seven seconds while still being gentler than the grow step.
			dec := n / 10
			if dec < 1 {
				dec = 1
			}
			n -= dec
		}
		if n < 1 {
			n = 1
		}
		if n > ringNmax {
			n = ringNmax
		}
		c.n = n
		c.rc.SetStrideN(n)
		// Release the pages of records every client has already drained, so the
		// ring's resident memory tracks the live backlog (not the whole segment).
		// Under c.mu for the same reason as unregister's ReclaimAll: the set of
		// clients minRead was computed from must not change under the punch.
		if minRead != ^uint64(0) {
			c.rc.Reclaim(minRead)
		}
		c.mu.Unlock()
	}
}

// ---- GET /api/v1/stream/ring ------------------------------------------------

// ringFrameVersion is the /api/v1/stream/ring wire format (see RING_FORMAT.md
// § "Wire frame").
const ringFrameVersion = 2

// Frame v2 (little-endian, one per 5 ms that has ≥1 record, plus one EMPTY frame
// whenever the epoch changes so a client learns about a restart at once):
//
//	u32 frame_len       bytes after this field
//	u16 version         2
//	u16 header_len      bytes from `version` up to the first record (28)
//	u32 record_count
//	u32 stride_N        current decimation (client derives effective rate)
//	u64 dropped_total   cumulative records lost (lapped, overwritten, torn, stuck)
//	u64 epoch           runtime generation; a change = Build & Send / restart:
//	                    re-fetch /api/v1/ring/info, the payload layout may differ
//	record_count × record:
//	    u64 seq
//	    u16 task_id
//	    u16 payload_len
//	    u32 scan        producer's scan counter for task_id (low 32 bits);
//	                    consecutive records of one task differ by stride_N
//	    u8  payload[payload_len]
//
// ⚠️ ?v=2 is REQUIRED: a v1 client would misread every v2 frame (the version
// field sits where it expects record_count), so without it the request gets a
// 400 that names the change instead of a stream it would decode into garbage.
func (am *APIManager) handleRingStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}
	if r.URL.Query().Get("v") != strconv.Itoa(ringFrameVersion) {
		jsonError(w, http.StatusBadRequest, "ring stream frame format v2 required: add ?v=2 (frames now carry version, epoch and a per-record scan counter — see RING_FORMAT.md)")
		return
	}
	rc, err := am.sharedRing()
	if err != nil {
		jsonError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	ctl := am.ringCtl
	id := ctl.register()
	defer ctl.unregister(id)

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	deliver := time.NewTicker(ringDeliverMs * time.Millisecond)
	defer deliver.Stop()

	ctx := r.Context()
	// Start from the producer's CURRENT position: no pre-connect history (the
	// producer was paused while idle anyway), and — since valid seqs are ≥ 1 —
	// never try to read seq 0 out of an uninitialised slot.
	var cur RingCursor
	cur.Reset(rc.WriteSeq())
	var droppedTotal uint64
	lastEpoch := rc.Epoch()
	var recs []RingRecord
	var dBps float64 // EWMA of delivered bytes/s
	frame := make([]byte, 0, 4096)

	for {
		select {
		case <-ctx.Done():
			return
		case <-deliver.C:
			// epoch change (runtime restarted) → resync to the new generation's
			// current write position (write_seq continues monotonically across
			// restarts, so starting from "now" skips the old run's records).
			epochChanged := false
			if e := rc.Epoch(); e != lastEpoch {
				lastEpoch = e
				cur.Reset(rc.WriteSeq())
				epochChanged = true
			}
			// bound the frame: at most ringMaxFrameBytes worth of records this tick
			stride := rc.RecordStride()
			if stride < 1 {
				stride = 1
			}
			maxRecs := ringMaxFrameBytes / stride
			if maxRecs < 1 {
				maxRecs = 1
			}
			var dropped uint64
			recs = recs[:0]
			dropped, recs = rc.DrainCursor(&cur, recs, maxRecs, time.Now())
			droppedTotal += dropped
			if len(recs) == 0 && !epochChanged {
				ctl.report(id, dBps, backlogOf(rc.WriteSeq(), cur.ReadSeq), cur.ReadSeq)
				continue
			}
			frame = appendRingFrame(frame[:0], recs, rc.StrideN(), droppedTotal, lastEpoch)
			// measure delivery time = link rate (TCP backpressure shows here)
			t0 := time.Now()
			if _, err := w.Write(frame); err != nil {
				return
			}
			flusher.Flush()
			dt := time.Since(t0).Seconds()
			if dt > 0 {
				inst := float64(len(frame)) / dt
				if dBps == 0 {
					dBps = inst
				} else {
					dBps = 0.7*dBps + 0.3*inst // EWMA
				}
			}
			ctl.report(id, dBps, backlogOf(rc.WriteSeq(), cur.ReadSeq), cur.ReadSeq)
		}
	}
}

// ringFrameHeaderLen is the v2 frame header after frame_len: version, header_len,
// record_count, stride_N, dropped_total, epoch.
const ringFrameHeaderLen = 2 + 2 + 4 + 4 + 8 + 8

// appendRingFrame encodes one v2 frame (see the format above handleRingStream).
func appendRingFrame(frame []byte, recs []RingRecord, strideN uint32, dropped, epoch uint64) []byte {
	start := len(frame)
	frame = appendU32(frame, 0) // frame_len placeholder
	frame = appendU16(frame, ringFrameVersion)
	frame = appendU16(frame, ringFrameHeaderLen)
	frame = appendU32(frame, uint32(len(recs)))
	frame = appendU32(frame, strideN)
	frame = appendU64(frame, dropped)
	frame = appendU64(frame, epoch)
	for i := range recs {
		frame = appendU64(frame, recs[i].Seq)
		frame = appendU16(frame, recs[i].TaskID)
		frame = appendU16(frame, uint16(len(recs[i].Payload)))
		frame = appendU32(frame, recs[i].Scan)
		frame = append(frame, recs[i].Payload...)
	}
	binary.LittleEndian.PutUint32(frame[start:start+4], uint32(len(frame)-start-4))
	return frame
}

// backlogOf is write_seq - readSeq, clamped at 0: a resize that invalidated the
// layout, or a producer whose write_seq was reset, must not report a wrapped
// uint64 backlog that pins the stride at Nmax.
func backlogOf(w, readSeq uint64) uint64 {
	if w <= readSeq {
		return 0
	}
	return w - readSeq
}

// ---- GET /api/v1/ring/info --------------------------------------------------

func (am *APIManager) handleRingInfo(w http.ResponseWriter, r *http.Request) {
	rc, err := am.sharedRing()
	info := map[string]any{}
	if err != nil {
		info["available"] = false
		info["reason"] = err.Error()
	} else {
		info["available"] = true
		info["record_stride"] = rc.RecordStride()
		info["ring_version"] = rc.Version()
		info["epoch"] = rc.Epoch()
		info["frame_version"] = ringFrameVersion
		info["nslots"] = rc.Nslots()
		info["stride_n"] = rc.StrideN()
		info["write_seq"] = rc.WriteSeq()
		info["produced_bytes_per_sec"] = rc.ProducedBytesPerSec()
		hdrTasks := make([]map[string]any, 0, len(rc.Tasks()))
		for _, t := range rc.Tasks() {
			hdrTasks = append(hdrTasks, map[string]any{
				"task_id": t.TaskID, "period_us": t.PeriodUs, "payload_len": t.PayloadLen,
			})
		}
		info["header_tasks"] = hdrTasks
	}
	// payload variable layout comes from the deployed variable table (transpiler)
	if layout := am.ipc.RingConfig(); layout != nil {
		info["layout"] = layout
	}
	jsonOK(w, info)
}

// little-endian append helpers
func appendU16(b []byte, v uint16) []byte { return append(b, byte(v), byte(v>>8)) }
func appendU32(b []byte, v uint32) []byte {
	return append(b, byte(v), byte(v>>8), byte(v>>16), byte(v>>24))
}
func appendU64(b []byte, v uint64) []byte {
	return append(b, byte(v), byte(v>>8), byte(v>>16), byte(v>>24),
		byte(v>>32), byte(v>>40), byte(v>>48), byte(v>>56))
}
