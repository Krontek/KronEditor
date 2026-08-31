package main

import "testing"

const gib = int64(1) << 30

// Real shapes read from the models in OLLAMA_CATALOG, so these cases describe
// what a user of this editor actually gets rather than invented numbers.
var (
	granite3b = modelShape{MaxCtx: 131072, Blocks: 32, KVHeads: 8, HeadDim: 128}
	qwen8b    = modelShape{MaxCtx: 40960, Blocks: 36, KVHeads: 8, HeadDim: 128}
	qwen14b   = modelShape{MaxCtx: 40960, Blocks: 40, KVHeads: 8, HeadDim: 128}
	qwen30b   = modelShape{MaxCtx: 262144, Blocks: 48, KVHeads: 4, HeadDim: 128}
)

func TestPickNumCtx(t *testing.T) {
	cases := []struct {
		name    string
		shape   modelShape
		vram    int64
		weights int64
		want    int
	}{
		// The bug this replaced: a flat 8192 for everyone. A 3B on a 6 GB card
		// has room for far more, and the agent needs it for the tool schemas.
		{"3B on a 6 GB card", granite3b, 6 * gib, 2100 * 1000 * 1000, 24576},
		// The other half of the bug: an 8B on that same card is genuinely tight,
		// so it must NOT get the big window a blanket bump would have handed it.
		{"8B on a 6 GB card", qwen8b, 6 * gib, 5200 * 1000 * 1000, 8192},
		// Room for ~44k, but Qwen3 8B itself stops at 40960 — the model's own
		// ceiling wins, because asking past it is a 400 from the daemon.
		{"8B on a 12 GB card", qwen8b, 12 * gib, 5200 * 1000 * 1000, 40960},
		{"14B on a 24 GB card", qwen14b, 24 * gib, 9300 * 1000 * 1000, 40960},
		// VRAM-bound, not clamp-bound: 19 GB of weights leaves ~4 GB for KV.
		{"30B MoE on a 24 GB card", qwen30b, 24 * gib, 19 * gib, 43008},
		// Same model with room to spare — now ollamaMaxCtx is what stops it,
		// since the agent re-sends a compact project map and cannot use 262144.
		{"30B MoE on a 48 GB card", qwen30b, 48 * gib, 19 * gib, ollamaMaxCtx},
		// Weights alone exceed VRAM: Ollama spills to CPU regardless, so a
		// smaller window would buy nothing.
		{"30B on a 6 GB card", qwen30b, 6 * gib, 19 * gib, ollamaFallbackCtx},
		// No nvidia-smi (AMD / Apple / CPU-only) — sizing is not possible.
		{"no VRAM figure", qwen8b, 0, 5200 * 1000 * 1000, ollamaFallbackCtx},
		// /api/show gave us nothing usable.
		{"empty shape", modelShape{}, 24 * gib, 0, ollamaFallbackCtx},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := pickNumCtx(c.shape, c.vram, c.weights); got != c.want {
				t.Errorf("pickNumCtx = %d, want %d", got, c.want)
			}
		})
	}
}

// Whatever the inputs, the result must be a window Ollama will accept: never
// above the model's own maximum, and never below our floor unless the model
// itself is that small.
func TestPickNumCtxStaysInBounds(t *testing.T) {
	shapes := []modelShape{granite3b, qwen8b, qwen14b, qwen30b, {}, {MaxCtx: 4096, Blocks: 32, KVHeads: 8, HeadDim: 128}}
	for _, m := range shapes {
		for _, vram := range []int64{0, 2 * gib, 6 * gib, 12 * gib, 24 * gib, 96 * gib} {
			for _, w := range []int64{0, 5 * gib, 40 * gib} {
				got := pickNumCtx(m, vram, w)
				max := int(m.MaxCtx)
				if max <= 0 {
					max = ollamaMaxCtx
				}
				if got > max || got > ollamaMaxCtx {
					t.Fatalf("shape %+v vram=%d w=%d: %d exceeds max %d", m, vram, w, got, max)
				}
				if got < ollamaMinCtx && got != max {
					t.Fatalf("shape %+v vram=%d w=%d: %d below floor %d", m, vram, w, got, ollamaMinCtx)
				}
			}
		}
	}
}
