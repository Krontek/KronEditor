package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
)

// eventsMarshalLogOnce keeps a persistent marshal failure from flooding the log.
var eventsMarshalLogOnce sync.Once

// Events is a fan-out broadcaster used for build-command, library-update-progress,
// server-update-progress, ec-state-changed, etc. Subscribers connect via SSE at
// GET /api/host/events; emitters use Emit().
type Events struct {
	mu          sync.Mutex
	subscribers map[chan eventMsg]struct{}
}

type eventMsg struct {
	Topic string      `json:"topic"`
	Data  interface{} `json:"data"`
}

func NewEvents() *Events {
	return &Events{subscribers: make(map[chan eventMsg]struct{})}
}

func (e *Events) Emit(topic string, data interface{}) {
	e.mu.Lock()
	defer e.mu.Unlock()
	msg := eventMsg{Topic: topic, Data: data}
	for ch := range e.subscribers {
		select {
		case ch <- msg:
		default:
			// drop on slow consumer
		}
	}
}

func (e *Events) handleSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming not supported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ch := make(chan eventMsg, 64)
	e.mu.Lock()
	e.subscribers[ch] = struct{}{}
	e.mu.Unlock()

	defer func() {
		e.mu.Lock()
		delete(e.subscribers, ch)
		e.mu.Unlock()
		close(ch)
	}()

	// initial open comment so EventSource fires onopen
	fmt.Fprintf(w, ": connected\n\n")
	flusher.Flush()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			payload, err := json.Marshal(msg)
			if err != nil {
				// A single bad payload (e.g. a non-finite float) must not
				// silently freeze the stream — drop the frame and log once.
				eventsMarshalLogOnce.Do(func() {
					log.Printf("events: marshal failed (frame dropped): %v", err)
				})
				continue
			}
			fmt.Fprintf(w, "data: %s\n\n", payload)
			flusher.Flush()
		}
	}
}
