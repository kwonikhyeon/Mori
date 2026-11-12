package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/kwonikhyeon/mori/internal/commands"
	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/history"
	"github.com/kwonikhyeon/mori/internal/store"
)

const (
	maxUpload      = 8 << 20 // the most terminal.put takes (spec §2.3)
	maxTitle       = 100     // runes in a name the user gives
	taskTitleRunes = 40      // runes of the task that name a session without a title
	recentFinished = 24 * time.Hour
	maxInterrupt   = 60 // seconds an interrupt may watch for its effect

	minSize, maxSize         = 10, 1000
	defaultCols, defaultRows = 80, 24
)

// createReq is the body of POST /api/terminals (spec §6.3).
type createReq struct {
	FolderID string `json:"folder_id"`
	Worktree string `json:"worktree"`
	Preset   string `json:"preset"`
	Task     string `json:"task"`
	Title    string `json:"title"`
	Cols     int    `json:"cols"`
	Rows     int    `json:"rows"`
}

// runParams starts preset p in cwd, a directory of folder f (spec §6.3).
// A preset that takes a task gets it as its last argument; an empty argv
// runs the machine's shell.
func runParams(f store.Folder, cwd string, p store.Preset, req createReq, settings string) hc.RunParams {
	argv := withHook(slices.Clone(p.Argv), settings)
	task := ""
	if p.Task && len(argv) > 0 {
		task = strings.TrimSpace(req.Task)
	}
	if task != "" {
		arg := task
		if strings.HasPrefix(arg, "-") {
			arg = " " + arg // or the program would read it as an option
		}
		argv = append(argv, arg)
	}
	if len(argv) == 0 {
		argv = nil
	}
	title := oneLine(req.Title)
	if title == "" {
		title = cutRunes(oneLine(task), taskTitleRunes)
	}
	if title == "" {
		title = p.Name
	}
	return hc.RunParams{
		Argv: argv,
		Cwd:  cwd,
		Env:  map[string]string{"TERM": "xterm-256color", "COLORTERM": "truecolor", "TERM_PROGRAM": "mori"},
		Keep: true,
		Labels: map[string]string{
			core.LabelMori: "1", core.LabelFolder: f.ID, core.LabelPreset: p.ID, core.LabelTitle: title,
		},
		NoParent: true,
		Size:     &hc.Size{Cols: clampSize(req.Cols, defaultCols), Rows: clampSize(req.Rows, defaultRows)},
	}
}

// clampSize keeps a terminal dimension to what a screen can use. Zero or
// less means the default.
func clampSize(n, def int) int {
	if n <= 0 {
		return def
	}
	return min(max(n, minSize), maxSize)
}

// oneLine turns every run of white space, newlines too, into one space.
func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

func cutRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return strings.TrimSpace(string([]rune(s)[:n]))
}

// terminalParam is the {t} of the path, unescaped: a terminal of another
// machine, machine/t7, comes as machine%2Ft7 (spec §7.1).
func terminalParam(r *http.Request) string { return r.PathValue("t") }

func invalid(format string, args ...any) *apiError {
	return errorf(http.StatusBadRequest, "invalid_params", format, args...)
}

// queryBool reads a flag from the query; absent is false.
func queryBool(r *http.Request, name string) (bool, error) {
	v := r.URL.Query().Get(name)
	if v == "" {
		return false, nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return false, invalid("%s=%q: 1 또는 0이어야 합니다", name, v)
	}
	return b, nil
}

// queryInt reads a count from the query; absent is def.
func queryInt(r *http.Request, name string, def int) (int, error) {
	v := r.URL.Query().Get(name)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return 0, invalid("%s=%q: 0 이상의 정수여야 합니다", name, v)
	}
	return n, nil
}

func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request) {
	st := s.d.Store.Get()
	writeJSON(w, http.StatusOK, map[string]any{
		"host":      map[string]string{"name": s.d.HostName, "version": s.d.Version},
		"core":      s.d.Core.Status(),
		"folders":   s.folderViews(st.Folders),
		"terminals": s.terminalViews(false, time.Now()),
		"presets":   st.Presets,
		"hosts":     s.hostViews(),
	})
}

func (s *Server) handleListTerminals(w http.ResponseWriter, r *http.Request) {
	all, err := queryBool(r, "all")
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.terminalViews(all, time.Now()))
}

// terminalViews lists the cached terminals: the live ones and those that
// finished within recentFinished, or every one with all. While the core is
// away the cache keeps what it last knew.
func (s *Server) terminalViews(all bool, now time.Time) []TerminalView {
	out := []TerminalView{}
	for _, t := range s.d.Core.Terminals() {
		if !all && !recent(t, now) {
			continue
		}
		out = append(out, s.view(t))
	}
	return out
}

// recent reports whether t is live or finished within recentFinished.
func recent(t hc.Terminal, now time.Time) bool {
	return t.State != "finished" || t.FinishedMs == nil || *t.FinishedMs >= now.Add(-recentFinished).UnixMilli()
}

// terminal finds addr in the cache, else asks the core: the created event
// of a terminal made a moment ago may not be in yet, and the core also
// knows terminals by name.
func (s *Server) terminal(ctx context.Context, addr string) (hc.Terminal, error) {
	if t, ok := s.d.Core.Terminal(addr); ok {
		return t, nil
	}
	var t hc.Terminal
	err := s.d.Core.Call(ctx, "terminal.get", map[string]any{"terminal": addr}, &t)
	return t, err
}

func (s *Server) handleGetTerminal(w http.ResponseWriter, r *http.Request) {
	t, err := s.terminal(r.Context(), terminalParam(r))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.view(t))
}

func (s *Server) handleCreateTerminal(w http.ResponseWriter, r *http.Request) {
	var req createReq
	if err := readJSON(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
	p, err := s.createParams(req)
	if err != nil {
		writeError(w, err)
		return
	}
	var t hc.Terminal
	if err := s.d.Core.Call(r.Context(), "terminal.run", p, &t); err != nil {
		writeError(w, err)
		return
	}
	s.log.Info("terminal started", "terminal", t.Address, "folder", req.FolderID, "preset", req.Preset, "cwd", p.Cwd)
	writeJSON(w, http.StatusCreated, s.view(t))
}

// createParams checks what req names against the store and the disk.
func (s *Server) createParams(req createReq) (hc.RunParams, error) {
	st := s.d.Store.Get()
	if req.FolderID == "" {
		return hc.RunParams{}, invalid("folder_id가 필요합니다")
	}
	fi := slices.IndexFunc(st.Folders, func(f store.Folder) bool { return f.ID == req.FolderID })
	if fi < 0 {
		return hc.RunParams{}, invalid("없는 폴더입니다: %s", req.FolderID)
	}
	if req.Preset == "" {
		return hc.RunParams{}, invalid("preset이 필요합니다")
	}
	pi := slices.IndexFunc(st.Presets, func(p store.Preset) bool { return p.ID == req.Preset })
	if pi < 0 {
		return hc.RunParams{}, invalid("없는 프리셋입니다: %s", req.Preset)
	}
	cwd := st.Folders[fi].Path
	if req.Worktree != "" {
		if !filepath.IsAbs(req.Worktree) {
			return hc.RunParams{}, invalid("worktree는 절대 경로여야 합니다: %s", req.Worktree)
		}
		cwd = filepath.Clean(req.Worktree)
	}
	if info, err := os.Stat(cwd); err != nil || !info.IsDir() {
		return hc.RunParams{}, invalid("작업 폴더가 없습니다: %s", cwd)
	}
	if utf8.RuneCountInString(oneLine(req.Title)) > maxTitle {
		return hc.RunParams{}, invalid("제목은 %d자까지입니다", maxTitle)
	}
	return runParams(st.Folders[fi], cwd, st.Presets[pi], req, s.d.ClaudeSettings), nil
}

// handlePatchTerminal renames a terminal. An empty title removes the
// label, and the program's own title shows again.
func (s *Server) handlePatchTerminal(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title *string `json:"title"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
	if req.Title == nil {
		writeError(w, invalid("바꿀 것이 없습니다. title을 보내세요"))
		return
	}
	title := oneLine(*req.Title)
	if utf8.RuneCountInString(title) > maxTitle {
		writeError(w, invalid("제목은 %d자까지입니다", maxTitle))
		return
	}
	var t hc.Terminal
	params := map[string]any{"terminal": terminalParam(r), "labels": map[string]string{core.LabelTitle: title}}
	if err := s.d.Core.Call(r.Context(), "terminal.label", params, &t); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.view(t))
}

// handleRemoveTerminal forgets a finished terminal; the core refuses a
// live one with kind live.
func (s *Server) handleRemoveTerminal(w http.ResponseWriter, r *http.Request) {
	if err := s.d.Core.Call(r.Context(), "terminal.rm", map[string]any{"terminal": terminalParam(r)}, nil); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleSend pastes text and presses Enter once the program is quiet. The
// core refuses with kind blocked while the program waits for an answer,
// unless force is set.
func (s *Server) handleSend(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Text  string `json:"text"`
		Force bool   `json:"force"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
	if req.Text == "" {
		writeError(w, invalid("보낼 text가 없습니다"))
		return
	}
	s.relay(w, r, "terminal.send", map[string]any{"terminal": terminalParam(r), "text": req.Text, "force": req.Force})
}

// handleKeys presses named keys. With expect they answer that question,
// and only while the program still asks it (spec §3 #194).
func (s *Server) handleKeys(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Keys   []string `json:"keys"`
		Expect string   `json:"expect"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
	if len(req.Keys) == 0 {
		writeError(w, invalid("보낼 keys가 없습니다"))
		return
	}
	addr := terminalParam(r)
	if req.Expect == "" {
		s.relay(w, r, "terminal.keys", map[string]any{"terminal": addr, "keys": req.Keys})
		return
	}
	res, err := s.answer(r.Context(), addr, req.Expect, req.Keys)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// handleInterrupt stops the current turn. timeout is how many seconds the
// core watches for an effect; it has its own default.
func (s *Server) handleInterrupt(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Timeout float64 `json:"timeout"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
	params := map[string]any{"terminal": terminalParam(r)}
	if req.Timeout > 0 {
		params["timeout"] = min(req.Timeout, maxInterrupt)
	}
	s.relay(w, r, "terminal.interrupt", params)
}

func (s *Server) handleKill(w http.ResponseWriter, r *http.Request) {
	var t hc.Terminal
	if err := s.d.Core.Call(r.Context(), "terminal.kill", map[string]any{"terminal": terminalParam(r)}, &t); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.view(t))
}

func (s *Server) handleText(w http.ResponseWriter, r *http.Request) {
	params := map[string]any{"terminal": terminalParam(r)}
	n, err := queryInt(r, "lines", -1)
	if err != nil {
		writeError(w, err)
		return
	}
	if n >= 0 {
		params["lines"] = n
	}
	s.relay(w, r, "terminal.read", params)
}

// handleCommands lists the slash commands Claude Code takes in the
// terminal's folder, for the web UI to offer as the user types a slash
// (spec §3 #197). A terminal of another machine, whose address has the
// machine's name in front, gets the built-in ones alone: its files are not
// here.
func (s *Server) handleCommands(w http.ResponseWriter, r *http.Request) {
	t, err := s.terminal(r.Context(), terminalParam(r))
	if err != nil {
		writeError(w, err)
		return
	}
	cwd := t.Cwd
	if t.Foreground != nil && t.Foreground.Cwd != "" {
		cwd = t.Foreground.Cwd // where Claude Code is now, after a /cd
	}
	if strings.Contains(t.Address, "/") || !filepath.IsAbs(cwd) {
		writeJSON(w, http.StatusOK, commands.List{Commands: commands.Builtins(), Partial: true})
		return
	}
	writeJSON(w, http.StatusOK, s.d.Commands.List(r.Context(), cwd))
}

// handlePrompts gives what was sent to Claude Code in the terminal's folder,
// newest first, from Claude Code's own record, for the box's ↑ (claude-input
// design §5.1, spec §3 #226). Nothing read is no error: source "none" tells
// the browser to use what it sent itself. It does not ask whether Claude
// Code runs there, as the commands do not: the browser asks for a Claude
// Code terminal only.
func (s *Server) handlePrompts(w http.ResponseWriter, r *http.Request) {
	limit, err := queryInt(r, "limit", 200)
	if err != nil {
		writeError(w, err)
		return
	}
	t, err := s.terminal(r.Context(), terminalParam(r))
	if err != nil {
		writeError(w, err)
		return
	}
	cwd := t.Cwd
	if t.Foreground != nil && t.Foreground.Cwd != "" {
		cwd = t.Foreground.Cwd
	}
	none := map[string]any{"prompts": []history.Prompt{}, "source": "none"}
	if strings.Contains(t.Address, "/") || !filepath.IsAbs(cwd) {
		writeJSON(w, http.StatusOK, none)
		return
	}
	ps, err := history.Read(s.d.ClaudeConfig, cwd, limit)
	if err != nil {
		s.log.Warn("Claude Code 기록을 읽지 못함", "err", err)
	}
	if len(ps) == 0 {
		writeJSON(w, http.StatusOK, none)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"prompts": ps, "source": "claude"})
}

// handleUpload hands one file to the core, which places it beside the
// terminal's other files and answers with its path.
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload+1<<20) // room for the multipart framing
	mr, err := r.MultipartReader()
	if err != nil {
		writeError(w, invalid("multipart/form-data의 file 항목으로 보내세요"))
		return
	}
	part, err := filePart(mr)
	if err != nil {
		writeError(w, uploadError(err))
		return
	}
	data, err := io.ReadAll(io.LimitReader(part, maxUpload+1))
	if err != nil {
		writeError(w, uploadError(err))
		return
	}
	if len(data) > maxUpload {
		writeError(w, uploadError(errTooLarge))
		return
	}
	s.relay(w, r, "terminal.put", map[string]any{
		"terminal": terminalParam(r),
		"name":     uploadName(part.FileName()),
		"data":     base64.StdEncoding.EncodeToString(data),
	})
}

var errTooLarge = errors.New("too large")

// filePart skips to the part named file.
func filePart(mr *multipart.Reader) (*multipart.Part, error) {
	for {
		p, err := mr.NextPart()
		if err != nil {
			return nil, err
		}
		if p.FormName() == "file" {
			return p, nil
		}
		p.Close()
	}
}

func uploadError(err error) error {
	var mbe *http.MaxBytesError
	switch {
	case errors.Is(err, errTooLarge), errors.As(err, &mbe):
		return errorf(http.StatusRequestEntityTooLarge, "too_large", "파일이 %d MB를 넘습니다", maxUpload>>20)
	case errors.Is(err, io.EOF):
		return invalid("file 항목이 없습니다")
	}
	return invalid("multipart 본문을 읽지 못했습니다: %v", err)
}

// uploadName is a file name the core can place, made from what the browser
// sent: the last element of a path of either OS, no control characters or
// characters Windows refuses, and at most 255 bytes with the extension
// kept.
func uploadName(name string) string {
	const maxBytes, maxExt = 255, 32
	name = path.Base(strings.ReplaceAll(name, `\`, "/"))
	name = strings.Map(func(r rune) rune {
		switch {
		case unicode.IsControl(r):
			return ' '
		case strings.ContainsRune(`<>:"|?*`, r):
			return '_'
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." || name == "/" {
		return "upload"
	}
	if len(name) <= maxBytes {
		return name
	}
	ext := path.Ext(name)
	if len(ext) > maxExt {
		ext = ""
	}
	base := name[:len(name)-len(ext)]
	n := maxBytes - len(ext)
	for n > 0 && !utf8.RuneStart(base[n]) {
		n--
	}
	return base[:n] + ext
}

// relay calls the core and passes its result on as it is.
func (s *Server) relay(w http.ResponseWriter, r *http.Request, method string, params any) {
	var res json.RawMessage
	if err := s.d.Core.Call(r.Context(), method, params, &res); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}
