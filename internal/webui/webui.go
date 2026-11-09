// Package webui serves the built web UI, or a placeholder page when the UI
// has not been built into dist/.
package webui

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
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

// types pins the content types of what the build holds; on Windows the
// registry would otherwise decide, and Go's table has no woff2.
var types = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json",
	".png":   "image/png",
	".svg":   "image/svg+xml",
	".woff2": "font/woff2",
}

// spa serves the build and answers "/pair" with index.html (the UI routes
// by hash). Only files are served: no listings, no dot files. Hashed
// assets are cached for good; everything else is revalidated.
func spa(root fs.FS) http.Handler {
	fileServer := http.FileServerFS(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if p == "/pair" {
			r = r.Clone(r.Context())
			r.URL.Path, p = "/", "/"
		}
		ext := ".html"
		if p != "/" {
			name := strings.TrimPrefix(p, "/")
			fi, err := fs.Stat(root, name)
			if err != nil || fi.IsDir() || strings.HasPrefix(name, ".") || strings.Contains(name, "/.") {
				http.NotFound(w, r)
				return
			}
			ext = path.Ext(name)
		}
		h := w.Header()
		if strings.HasPrefix(p, "/assets/") {
			h.Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			h.Set("Cache-Control", "no-cache")
		}
		if t, ok := types[ext]; ok {
			h.Set("Content-Type", t)
		}
		fileServer.ServeHTTP(w, r)
	})
}
