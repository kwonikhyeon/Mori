// Package webui serves the built web UI, or a placeholder page when the UI
// has not been built into dist/.
package webui

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed all:dist placeholder.html placeholder.js
var files embed.FS

// Handler serves dist/ when it holds a build, otherwise the placeholder.
// "/pair" answers with the app page too; the pairing code travels in the
// URL fragment so it never reaches the server.
func Handler() http.Handler {
	if _, err := fs.Stat(files, "dist/index.html"); err == nil {
		sub, err := fs.Sub(files, "dist")
		if err != nil {
			panic(err) // the embedded tree is fixed at build time
		}
		return spa(sub)
	}
	return http.HandlerFunc(placeholder)
}

func placeholder(w http.ResponseWriter, r *http.Request) {
	var name, ctype string
	switch r.URL.Path {
	case "/", "/pair":
		name, ctype = "placeholder.html", "text/html; charset=utf-8"
	case "/placeholder.js":
		name, ctype = "placeholder.js", "text/javascript; charset=utf-8"
	default:
		http.NotFound(w, r)
		return
	}
	b, err := files.ReadFile(name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(b)
}

// spa serves the build and answers "/pair" with index.html (the UI routes by hash).
func spa(root fs.FS) http.Handler {
	fileServer := http.FileServerFS(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/pair" {
			r = r.Clone(r.Context())
			r.URL.Path = "/"
		}
		fileServer.ServeHTTP(w, r)
	})
}
