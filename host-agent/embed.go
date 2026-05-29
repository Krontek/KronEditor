package main

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

// The Vite build is checked in at host-agent/dist via `npm run build`. In
// production the host-agent serves it from the same origin as the API
// endpoints (no CORS needed). The first directive ensures `go build` does
// not fail when dist/ is empty in dev — index.html is required as a
// placeholder so the embed directive at least matches one file.
//
//go:embed all:dist
var distFS embed.FS

// frontendHandler serves the embedded Vite build. Requests for missing
// paths return index.html (SPA fallback so client-side routes resolve).
func frontendHandler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "frontend not embedded: "+err.Error(), http.StatusInternalServerError)
		})
	}
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		// Try the asset; if it doesn't exist, fall back to index.html.
		clean := strings.TrimPrefix(r.URL.Path, "/")
		if clean == "" {
			clean = "index.html"
		}
		if _, err := fs.Stat(sub, clean); err != nil {
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/"
			fileServer.ServeHTTP(w, r2)
			return
		}
		fileServer.ServeHTTP(w, r)
	})
}
