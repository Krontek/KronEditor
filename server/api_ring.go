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
	c.clients[id] = &ringClientStat{}
	// Resume the producer immediately (don't wait for the first control tick) at
	// the last-good stride — the runtime is PAUSED (stride_N=0) while no consumer
	// is connected, so this is what starts capture.
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
	delete(c.clients, id)
	idle := len(c.clients) == 0
	if idle {
		c.running = false
		// PAUSE the producer: stride_N=0 tells the runtime to stop writing to the
		// ring entirely while nobody is listening — no wasted scan cycles and the
		// ring stops filling RAM. register() resumes it on the next connect.
		// (c.n is kept as the last-good stride so the next client resumes there.)
		c.rc.SetStrideN(0)
	}
	c.mu.Unlock()
	if idle {
		c.rc.ReclaimAll() // release the whole ring's pages while idle → RSS ~0
	}
}

// loop is the ~100 ms control tick. AIMD-style: grow the stride fast when the
// backlog rises, relax it slowly toward the analytic floor ceil(P/(α·minD)).
func (c *ringController) loop() {
	t := time.NewTicker(ringTickMs * time.Millisecond)
	defer t.Stop()
	for range t.C {
		c.mu.Lock()
		if !c.running || len(c.clients) == 0 {
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
		P := c.rc.ProducedBytesPerSec()

		// analytic floor: smallest stride that keeps αD ≥ P/N
		floor := uint32(1)
		if !math.IsInf(minD, 1) && minD > 0 && P > 0 {
			floor = uint32(math.Ceil(P / (ringAlpha * minD)))
			if floor < 1 {
				floor = 1
			}
		}

		switch {
		case fill > ringFillHigh:
			n *= 2 // grow-fast: backlog building, halve production now
		case n < floor:
			n = floor // jump up to the sustainable rate
		case fill < ringFillLow && n > floor && n > 1:
			n-- // shrink-slow toward best fidelity
		}
		if n < 1 {
			n = 1
		}
		if n > ringNmax {
			n = ringNmax
		}
		c.n = n
		c.mu.Unlock()
		c.rc.SetStrideN(n)
		// Release the pages of records every client has already drained, so the
		// ring's resident memory tracks the live backlog (not the whole segment).
		if minRead != ^uint64(0) {
			c.rc.Reclaim(minRead)
		}
	}
}

// ---- GET /api/v1/stream/ring ------------------------------------------------

// Frame (little-endian, one per 5 ms that has ≥1 record):
//
//	u32 frame_len       bytes after this field
//	u32 record_count
//	u32 stride_N        current decimation (client derives effective rate)
//	u64 dropped_total   cumulative overwrite (lap) losses so far
//	record_count × record:
//	    u64 seq
//	    u16 task_id
//	    u16 payload_len
//	    u8  payload[payload_len]
func (am *APIManager) handleRingStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
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
	readSeq := rc.WriteSeq()
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
			if e := rc.Epoch(); e != lastEpoch {
				lastEpoch = e
				readSeq = rc.WriteSeq()
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
			readSeq, dropped, recs = rc.Drain(readSeq, recs, maxRecs)
			droppedTotal += dropped
			if len(recs) == 0 {
				ctl.report(id, dBps, rc.WriteSeq()-readSeq, readSeq)
				continue
			}

			// pack the frame
			frame = frame[:0]
			frame = appendU32(frame, 0) // frame_len placeholder
			frame = appendU32(frame, uint32(len(recs)))
			frame = appendU32(frame, rc.StrideN())
			frame = appendU64(frame, droppedTotal)
			for i := range recs {
				frame = appendU64(frame, recs[i].Seq)
				frame = appendU16(frame, recs[i].TaskID)
				frame = appendU16(frame, uint16(len(recs[i].Payload)))
				frame = append(frame, recs[i].Payload...)
			}
			binary.LittleEndian.PutUint32(frame[0:4], uint32(len(frame)-4))

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
			ctl.report(id, dBps, rc.WriteSeq()-readSeq, readSeq)
		}
	}
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
