// Package server serves Mori's REST API, its WebSockets, and the web UI.
package server

import (
	"log/slog"
	"net/http"
	"net/http/httputil"
	"strings"
	"sync/atomic"

	"github.com/kwonikhyeon/mori/internal/auth"
	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/folders"
	"github.com/kwonikhyeon/mori/internal/gitx"
	"github.com/kwonikhyeon/mori/internal/peer"
	"github.com/kwonikhyeon/mori/internal/presence"
	"github.com/kwonikhyeon/mori/internal/push"
	"github.com/kwonikhyeon/mori/internal/store"
)

// Deps are the parts the server is assembled from. Auth, Store and Core
// are required.
type Deps struct {
	Version   string
	HostName  string
	Auth      *auth.Auth
	Store     *store.Store
	Core      *core.Manager
	PublicURL func() string // where devices reach this server, for pairing links
	UI        http.Handler
	Logger    *slog.Logger

	// Folders tells which folder and worktree a terminal belongs to and
	// keeps the worktrees of each folder. New makes one over Store and Git
	// when it is nil; serve runs its refresh loop.
	Folders *folders.Resolver
	// Git runs the host's git for the folder and git APIs.
	Git gitx.Runner

	// Presence learns from attached browsers which terminals a viewer has
	// in focus, for the notifier to read. New makes one when it is nil.
	Presence *presence.Registry
	// Push keeps the devices' notification subscriptions and sends the
	// test notification. Without it the push APIs answer 503.
	Push *push.Notifier
	// Links links this hub to other hosts' Mori and finds them for the
	// proxy and the relay (spec §3 #158). Without it the hosts are listed
	// but cannot be linked.
	Links *peer.Manager
}

// Server routes requests. Build it with New and serve Handler().
type Server struct {
	d       Deps
	log     *slog.Logger
	mux     *http.ServeMux
	hub     *hub
	proxy   *httputil.ReverseProxy // nil without Deps.Links
	folders signal                 // fired by FoldersChanged
	viewers atomic.Int64           // numbers attach sockets for Presence
}

func New(d Deps) *Server {
	if d.Auth == nil || d.Store == nil || d.Core == nil {
		panic("server: Deps.Auth, Deps.Store and Deps.Core are required")
	}
	if d.PublicURL == nil {
		d.PublicURL = func() string { return "" }
	}
	if d.Logger == nil {
		d.Logger = slog.Default()
	}
	if d.UI == nil {
		d.UI = http.NotFoundHandler()
	}
	if d.Folders == nil {
		d.Folders = folders.New(d.Store, d.Git)
	}
	if d.Presence == nil {
		d.Presence = presence.New()
	}
	s := &Server{d: d, log: d.Logger, mux: http.NewServeMux(), hub: newHub()}
	if d.Links != nil {
		s.proxy = s.newProxy()
	}
	d.Auth.OnRevoke(s.hub.closeDevice)
	d.Folders.OnChange(s.FoldersChanged)
	s.routes()
	return s
}

// Handler is the root handler with security headers on every response.
func (s *Server) Handler() http.Handler { return securityHeaders(s.mux) }

// routes puts every API and WebSocket behind requireDevice, but for the
// relay endpoint, whose secret path is its credential; the web UI itself is
// public.
func (s *Server) routes() {
	api := http.NewServeMux()
	api.HandleFunc("GET /api/hello", s.handleHello)
	api.HandleFunc("POST /api/pair", s.handlePair)
	api.HandleFunc("POST /api/logout", s.handleLogout)
	api.HandleFunc("GET /api/devices", s.handleDevices)
	api.HandleFunc("DELETE /api/devices/{id}", s.handleRevokeDevice)
	api.HandleFunc("POST /api/pair-codes", s.handlePairCode)
	api.HandleFunc("GET /api/overview", s.handleOverview)
	api.HandleFunc("GET /api/folders", s.handleListFolders)
	api.HandleFunc("POST /api/folders", s.handleAddFolder)
	api.HandleFunc("PATCH /api/folders/{id}", s.handlePatchFolder)
	api.HandleFunc("DELETE /api/folders/{id}", s.handleRemoveFolder)
	api.HandleFunc("GET /api/fs", s.handleFs)
	api.HandleFunc("GET /api/folders/{id}/git", s.handleFolderGit)
	api.HandleFunc("GET /api/folders/{id}/branches", s.handleBranches)
	api.HandleFunc("POST /api/folders/{id}/worktrees", s.handleAddWorktree)
	api.HandleFunc("DELETE /api/folders/{id}/worktrees", s.handleRemoveWorktree)
	api.HandleFunc("GET /api/git/status", s.handleGitStatus)
	api.HandleFunc("GET /api/git/diff", s.handleGitDiff)
	api.HandleFunc("GET /api/git/log", s.handleGitLog)
	api.HandleFunc("GET /api/git/commit", s.handleGitCommit)
	api.HandleFunc("GET /api/terminals", s.handleListTerminals)
	api.HandleFunc("POST /api/terminals", s.handleCreateTerminal)
	api.HandleFunc("GET /api/terminals/{t}", s.handleGetTerminal)
	api.HandleFunc("PATCH /api/terminals/{t}", s.handlePatchTerminal)
	api.HandleFunc("DELETE /api/terminals/{t}", s.handleRemoveTerminal)
	api.HandleFunc("POST /api/terminals/{t}/send", s.handleSend)
	api.HandleFunc("POST /api/terminals/{t}/keys", s.handleKeys)
	api.HandleFunc("POST /api/terminals/{t}/interrupt", s.handleInterrupt)
	api.HandleFunc("POST /api/terminals/{t}/kill", s.handleKill)
	api.HandleFunc("POST /api/terminals/{t}/files", s.handleUpload)
	api.HandleFunc("GET /api/terminals/{t}/text", s.handleText)
	api.HandleFunc("GET /api/presets", s.handleGetPresets)
	api.HandleFunc("PUT /api/presets", s.handlePutPresets)
	api.HandleFunc("GET /api/hosts", s.handleGetHosts)
	api.HandleFunc("POST /api/hosts", s.needLinks(s.handleLinkHost))
	api.HandleFunc("PATCH /api/hosts/{id}", s.needLinks(s.handleRenameHost))
	api.HandleFunc("DELETE /api/hosts/{id}", s.needLinks(s.handleUnlinkHost))
	api.HandleFunc("POST /api/hosts/{id}/relay", s.needLinks(s.handleHostRelay))
	api.HandleFunc("GET /api/push/key", s.needPush(s.handlePushKey))
	api.HandleFunc("GET /api/push/subscriptions", s.needPush(s.handlePushSubs))
	api.HandleFunc("POST /api/push/subscriptions", s.needPush(s.handleSubscribe))
	api.HandleFunc("DELETE /api/push/subscriptions", s.needPush(s.handleUnsubscribe))
	api.HandleFunc("POST /api/push/test", s.needPush(s.handlePushTest))
	api.HandleFunc("GET /api/push/settings", s.needPush(s.handleGetPushSettings))
	api.HandleFunc("PUT /api/push/settings", s.needPush(s.handlePutPushSettings))
	api.HandleFunc("GET /ws/events", s.handleEventsWS)
	api.HandleFunc("GET /ws/attach", s.handleAttachWS)
	for _, p := range proxied {
		method, path, _ := strings.Cut(p, " ")
		api.HandleFunc(method+" /h/{host}"+path, s.serveProxy)
	}
	api.HandleFunc("/h/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, errorf(http.StatusNotFound, "not_found", "허브가 중계하지 않는 API입니다: %s %s", r.Method, r.URL.Path))
	})
	notFound := func(w http.ResponseWriter, r *http.Request) {
		writeError(w, errorf(http.StatusNotFound, "not_found", "없는 API입니다: %s %s", r.Method, r.URL.Path))
	}
	api.HandleFunc("/api/", notFound)
	api.HandleFunc("/ws/", notFound)

	guarded := s.requireDevice(api)
	s.mux.Handle("/api/", guarded)
	s.mux.Handle("/ws/", guarded)
	s.mux.Handle("/h/", guarded)
	s.mux.HandleFunc("POST /api/relay/{secret}", s.handleRelay) // outside requireDevice: a push service has no cookie
	s.mux.Handle("/", s.d.UI)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp(r.Host))
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

// csp builds the policy of spec §8. Some browsers do not let 'self' cover
// WebSockets, so the page's own host is listed for ws: and wss: as well.
func csp(host string) string {
	connect := "'self'"
	if validHost(host) {
		connect += " wss://" + host + " ws://" + host
	}
	return "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
		"connect-src " + connect + "; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
}

// validHost reports whether host is safe to place inside a CSP header.
func validHost(host string) bool {
	if host == "" || len(host) > 255 {
		return false
	}
	return strings.IndexFunc(host, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune(".-:[]", r))
	}) < 0
}
