// Package commands lists the slash commands Claude Code takes in a folder
// (spec §3 #197): its own, the command files and skills of the user and of
// the project, and those of the enabled plugins. It finds them from the
// files the way Claude Code does, for the web UI to offer them as the user
// types a slash; Mori runs none of them.
package commands

import (
	"cmp"
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// Where a command comes from.
const (
	SourceBuiltin = "builtin" // Claude Code itself
	SourceProject = "project" // the .claude folder of the project
	SourceUser    = "user"    // Claude Code's config folder
	SourcePlugin  = "plugin"  // an enabled plugin, whose name is in front of the command's
)

// Command is one slash command: /Name, with Hint for what follows it.
type Command struct {
	Name    string   `json:"name"`
	Desc    string   `json:"desc"`
	Hint    string   `json:"hint,omitempty"`
	Source  string   `json:"source"`
	Skill   bool     `json:"skill,omitempty"`   // a skill rather than a command file
	Menu    bool     `json:"menu,omitempty"`    // sent alone, it opens a menu in the terminal
	Aliases []string `json:"aliases,omitempty"` // other names it answers to
}

// List is what one folder takes. Partial says not everything was read in
// time: a command missing from it may still be there.
type List struct {
	Commands []Command `json:"commands"`
	Partial  bool      `json:"partial"`
}

const (
	headBytes = 16 << 10 // how much of a file is read for its header
	maxJSON   = 1 << 20  // how much of a settings file is read
	maxFiles  = 2000     // how many folder entries one read looks at
	maxDepth  = 4        // how many folders deep commands are looked for
	maxUp     = 40       // how many folders up the repository's root is looked for
	maxCached = 50       // how many folders' lists are kept
)

// ConfigDir is Claude Code's config folder: $CLAUDE_CONFIG_DIR, or
// ~/.claude. It is empty when there is no home to find it in.
func ConfigDir() string {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude")
}

// Lister lists the commands of folders and keeps each list a minute:
// Claude Code's own files change rarely, and a phone asks every time the
// user types a slash.
type Lister struct {
	ttl   time.Duration // how long a list is kept
	wait  time.Duration // how long a request waits for a read
	limit time.Duration // how long a read may go on
	now   func() time.Time
	// collect reads the commands of a folder; partial says it stopped
	// before the end.
	collect func(ctx context.Context, cwd string) (cmds []Command, partial bool)

	mu      sync.Mutex
	cache   map[string]cached
	reading map[string]*reading
}

type cached struct {
	list List
	at   time.Time
}

// reading is a read on its way; requests for its folder wait on done.
type reading struct {
	done chan struct{}
	list List // set before done closes
}

// New makes a Lister over Claude Code's config folder config (see
// ConfigDir); an empty one has no user commands, skills or plugins.
func New(config string) *Lister {
	return &Lister{
		ttl: time.Minute, wait: 3 * time.Second, limit: 10 * time.Second, now: time.Now,
		collect: func(ctx context.Context, cwd string) ([]Command, bool) { return collect(ctx, config, cwd) },
		cache:   map[string]cached{}, reading: map[string]*reading{},
	}
}

// List is what Claude Code takes in the folder cwd, an absolute path. One
// read of a folder goes on at a time, and the requests that come meanwhile
// share it. A request waits a few seconds for it, or until ctx ends; then it
// gets the list from before, or the built-in commands alone, and the read
// goes on to be kept for the next request. The list is shared: callers do
// not change it.
func (l *Lister) List(ctx context.Context, cwd string) List {
	cwd = filepath.Clean(cwd)
	l.mu.Lock()
	old, had := l.cache[cwd]
	if had && l.now().Sub(old.at) < l.ttl {
		l.mu.Unlock()
		return old.list
	}
	rd := l.reading[cwd]
	if rd == nil {
		rd = &reading{done: make(chan struct{})}
		l.reading[cwd] = rd
		go l.read(cwd, rd)
	}
	l.mu.Unlock()

	t := time.NewTimer(l.wait)
	defer t.Stop()
	select {
	case <-rd.done:
		if !rd.list.Partial || !had {
			return rd.list
		}
	case <-t.C:
	case <-ctx.Done():
	}
	if had {
		return old.list
	}
	return List{Commands: Builtins(), Partial: true}
}

func (l *Lister) read(cwd string, rd *reading) {
	ctx, cancel := context.WithTimeout(context.Background(), l.limit)
	defer cancel()
	rd.list = List{Commands: Builtins(), Partial: true}
	defer func() {
		// A file no one foresaw does not take the server down with it.
		_ = recover()
		l.mu.Lock()
		delete(l.reading, cwd)
		if !rd.list.Partial {
			l.cache[cwd] = cached{list: rd.list, at: l.now()}
			l.trim()
		}
		l.mu.Unlock()
		close(rd.done)
	}()
	cmds, partial := l.collect(ctx, cwd)
	rd.list = List{Commands: cmds, Partial: partial}
}

// trim drops the oldest lists past maxCached.
func (l *Lister) trim() {
	for len(l.cache) > maxCached {
		var oldest string
		var at time.Time
		first := true
		for k, c := range l.cache {
			if first || c.at.Before(at) {
				oldest, at, first = k, c.at, false
			}
		}
		delete(l.cache, oldest)
	}
}

// collect reads what Claude Code takes in cwd. Among the commands without
// a plugin's name, a skill wins over a command file of its name and the
// user's over the project's, as in Claude Code; a nearer folder's wins over
// a farther one's. A command or skill of a built-in's name replaces it.
func collect(ctx context.Context, config, cwd string) ([]Command, bool) {
	r := &reader{ctx: ctx, left: maxFiles}
	roots := r.roots(cwd)
	off := r.overridesOff(config, roots)

	type ranked struct {
		Command
		rank int
	}
	named := map[string]ranked{}
	put := func(cmds []Command, rank int) {
		for _, c := range cmds {
			if prev, ok := named[c.Name]; !ok || rank > prev.rank {
				named[c.Name] = ranked{c, rank}
			}
		}
	}
	for _, root := range roots {
		put(r.commands(filepath.Join(root, ".claude", "commands"), SourceProject, ""), 10)
	}
	if config != "" {
		put(r.commands(filepath.Join(config, "commands"), SourceUser, ""), 20)
		// claude.ai's skills, kept in skills/synced/<bucket>/: plain names,
		// under the user's own of the same name
		synced := filepath.Join(config, "skills", "synced")
		for _, e := range r.entries(synced) {
			if bucket := filepath.Join(synced, e.Name()); !hidden(e.Name()) && r.isDir(bucket, e) {
				put(r.skills(bucket, SourceUser, "", off), 25)
			}
		}
	}
	for _, root := range roots {
		put(r.skills(filepath.Join(root, ".claude", "skills"), SourceProject, "", off), 30)
	}
	if config != "" {
		put(r.skills(filepath.Join(config, "skills"), SourceUser, "", off), 40)
	}

	var plugged []Command
	for _, p := range r.plugins(config, roots) {
		for _, d := range p.dirs("commands") {
			plugged = append(plugged, r.commandsAt(d, SourcePlugin, p.name+":")...)
		}
		for _, d := range p.dirs("skills") {
			plugged = append(plugged, r.skills(d, SourcePlugin, p.name+":", off)...)
		}
	}

	all := make([]Command, 0, len(builtins)+len(named)+len(plugged))
	for _, b := range builtins {
		if _, ok := named[b.Name]; ok {
			continue
		}
		b.Aliases = slices.DeleteFunc(slices.Clone(b.Aliases), func(a string) bool { _, ok := named[a]; return ok })
		if len(b.Aliases) == 0 {
			b.Aliases = nil
		}
		all = append(all, b)
	}
	for _, n := range named {
		all = append(all, n.Command)
	}
	all = append(all, plugged...)
	seen := map[string]bool{}
	all = slices.DeleteFunc(all, func(c Command) bool {
		dup := seen[c.Name]
		seen[c.Name] = true
		return dup
	})
	slices.SortStableFunc(all, func(a, b Command) int {
		return cmp.Or(cmp.Compare(group(a), group(b)), cmp.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)), cmp.Compare(a.Name, b.Name))
	})
	return all, r.partial
}

// group is where a command goes in the list: Claude Code's own first, then
// the project's command files, the user's, the skills and the plugins'.
func group(c Command) int {
	switch {
	case c.Source == SourceBuiltin:
		return 0
	case c.Source == SourcePlugin:
		return 4
	case c.Skill:
		return 3
	case c.Source == SourceProject:
		return 1
	default:
		return 2
	}
}

// reader reads within its context and a number of folder entries; past
// either it reads no more and sets partial.
type reader struct {
	ctx     context.Context
	left    int
	partial bool
}

func (r *reader) more() bool {
	if r.ctx.Err() != nil || r.left <= 0 {
		r.partial = true
		return false
	}
	return true
}

// entries lists dir, none when it cannot be read.
func (r *reader) entries(dir string) []fs.DirEntry {
	if !r.more() {
		return nil
	}
	es, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	if len(es) > r.left {
		es = es[:r.left]
		r.partial = true
	}
	r.left -= len(es)
	return es
}

// isDir says whether the entry e at path p is a folder, following a link.
func (r *reader) isDir(p string, e fs.DirEntry) bool {
	if e.IsDir() {
		return true
	}
	if e.Type()&fs.ModeSymlink == 0 {
		return false
	}
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

// open opens a plain file; a pipe or a device could keep a read waiting.
func (r *reader) open(file string) *os.File {
	if !r.more() {
		return nil
	}
	if fi, err := os.Stat(file); err != nil || !fi.Mode().IsRegular() {
		return nil
	}
	f, err := os.Open(file)
	if err != nil {
		return nil
	}
	return f
}

// head is the start of file, enough for its header.
func (r *reader) head(file string) (string, bool) {
	f := r.open(file)
	if f == nil {
		return "", false
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, headBytes))
	if err != nil {
		return "", false
	}
	return string(b), true
}

// object reads a JSON object's fields from file, none when it is not one.
func (r *reader) object(file string) map[string]json.RawMessage {
	f := r.open(file)
	if f == nil {
		return nil
	}
	defer f.Close()
	var o map[string]json.RawMessage
	if json.NewDecoder(io.LimitReader(f, maxJSON)).Decode(&o) != nil {
		return nil
	}
	return o
}

// hidden is a name Claude Code does not look at, such as .staging.
func hidden(name string) bool { return strings.HasPrefix(name, ".") }

// usable is a name that can follow a slash.
func usable(name string) bool {
	return name != "" && !strings.ContainsFunc(name, func(c rune) bool { return c == '/' || c <= ' ' })
}

// commands reads every .md file under a commands folder; a/b.md is a:b.
func (r *reader) commands(dir, source, prefix string) []Command {
	var out []Command
	var walk func(d string, ns []string, depth int)
	walk = func(d string, ns []string, depth int) {
		for _, e := range r.entries(d) {
			full := filepath.Join(d, e.Name())
			switch {
			case hidden(e.Name()):
			case r.isDir(full, e):
				if depth < maxDepth {
					walk(full, append(slices.Clip(ns), e.Name()), depth+1)
				}
			case strings.EqualFold(filepath.Ext(e.Name()), ".md"):
				if c, ok := r.command(full, prefix+strings.Join(append(slices.Clip(ns), strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))), ":"), source); ok {
					out = append(out, c)
				}
			}
		}
	}
	walk(dir, nil, 0)
	return out
}

// commandsAt reads the commands at path: a commands folder, or one command
// file, which a plugin's manifest may name as well.
func (r *reader) commandsAt(path, source, prefix string) []Command {
	if fi, err := os.Stat(path); err == nil && fi.Mode().IsRegular() {
		base := filepath.Base(path)
		if !strings.EqualFold(filepath.Ext(base), ".md") {
			return nil
		}
		if c, ok := r.command(path, prefix+strings.TrimSuffix(base, filepath.Ext(base)), source); ok {
			return []Command{c}
		}
		return nil
	}
	return r.commands(path, source, prefix)
}

// command reads the command file at file, named name.
func (r *reader) command(file, name, source string) (Command, bool) {
	if !usable(name) {
		return Command{}, false
	}
	text, ok := r.head(file)
	if !ok {
		return Command{}, false
	}
	meta, body := frontmatter(text)
	return Command{Name: name, Desc: describe(meta, body), Hint: oneLine(meta["argument-hint"]), Source: source}, true
}

// skills reads <dir>/<folder>/SKILL.md for each folder; the name in its
// header wins over the folder's. One a user cannot call, or one the
// settings turn off, is left out.
func (r *reader) skills(dir, source, prefix string, off map[string]bool) []Command {
	var out []Command
	for _, e := range r.entries(dir) {
		if hidden(e.Name()) {
			continue
		}
		text, ok := r.head(filepath.Join(dir, e.Name(), "SKILL.md"))
		if !ok {
			continue
		}
		meta, body := frontmatter(text)
		name := strings.TrimSpace(meta["name"])
		if name == "" {
			name = e.Name()
		}
		if !usable(prefix+name) || falsy(meta["user-invocable"]) || off[name] || off[prefix+name] {
			continue
		}
		out = append(out, Command{Name: prefix + name, Desc: describe(meta, body), Hint: oneLine(meta["argument-hint"]),
			Source: source, Skill: true})
	}
	return out
}

// roots are cwd and each folder above it up to the repository's root,
// nearest first; outside a repository, cwd alone.
func (r *reader) roots(cwd string) []string {
	var dirs []string
	for d := cwd; len(dirs) < maxUp; {
		dirs = append(dirs, d)
		if _, err := os.Lstat(filepath.Join(d, ".git")); err == nil {
			return dirs
		}
		up := filepath.Dir(d)
		if up == d {
			break
		}
		d = up
	}
	return []string{cwd}
}

// settings are the settings files that apply in roots, in the order a
// later one wins: the user's, then the project's from its root down.
func settings(config string, roots []string) []string {
	var files []string
	if config != "" {
		files = append(files, filepath.Join(config, "settings.json"))
	}
	for _, root := range slices.Backward(roots) {
		files = append(files, filepath.Join(root, ".claude", "settings.json"), filepath.Join(root, ".claude", "settings.local.json"))
	}
	return files
}

// overridesOff are the skills the settings' skillOverrides turn off.
func (r *reader) overridesOff(config string, roots []string) map[string]bool {
	off := map[string]bool{}
	for _, f := range settings(config, roots) {
		var o map[string]any
		if json.Unmarshal(r.object(f)["skillOverrides"], &o) != nil {
			continue
		}
		for k, v := range o {
			if v == "off" {
				off[k] = true
			}
		}
	}
	return off
}

type plugin struct {
	name, dir string
	manifest  map[string]json.RawMessage
}

// dirs are where the plugin's commands or skills are: the usual folder,
// and the paths its manifest adds, relative to the plugin's folder.
func (p plugin) dirs(field string) []string {
	dirs := []string{filepath.Join(p.dir, field)}
	var one string
	var many []any
	switch raw := p.manifest[field]; {
	case json.Unmarshal(raw, &one) == nil:
		many = []any{one}
	case json.Unmarshal(raw, &many) == nil:
	}
	for _, x := range many {
		s, ok := x.(string)
		if !ok || s == "" {
			continue
		}
		if !filepath.IsAbs(s) {
			s = filepath.Join(p.dir, s)
		}
		if s = filepath.Clean(s); !slices.Contains(dirs, s) {
			dirs = append(dirs, s)
		}
	}
	return dirs
}

type install struct {
	Scope       string `json:"scope"`
	InstallPath string `json:"installPath"`
	ProjectPath string `json:"projectPath"`
}

// plugins are the installed plugins the settings turn on in roots. A
// plugin installed for one project counts in that project only.
func (r *reader) plugins(config string, roots []string) []plugin {
	if config == "" {
		return nil
	}
	var installed map[string]json.RawMessage
	if json.Unmarshal(r.object(filepath.Join(config, "plugins", "installed_plugins.json"))["plugins"], &installed) != nil {
		return nil
	}
	enabled := map[string]any{}
	for _, f := range settings(config, roots) {
		var o map[string]any
		if json.Unmarshal(r.object(f)["enabledPlugins"], &o) == nil {
			for k, v := range o {
				enabled[k] = v
			}
		}
	}
	var out []plugin
	for _, key := range slices.Sorted(maps.Keys(installed)) {
		var installs []install
		if enabled[key] != true || json.Unmarshal(installed[key], &installs) != nil {
			continue
		}
		i := slices.IndexFunc(installs, func(x install) bool { return x.Scope != "project" && x.Scope != "local" })
		if i < 0 {
			i = slices.IndexFunc(installs, func(x install) bool {
				return x.ProjectPath != "" && slices.Contains(roots, filepath.Clean(x.ProjectPath))
			})
		}
		if i < 0 || !filepath.IsAbs(installs[i].InstallPath) {
			continue
		}
		dir := filepath.Clean(installs[i].InstallPath)
		if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
			continue
		}
		manifest := r.object(filepath.Join(dir, ".claude-plugin", "plugin.json"))
		var name string
		_ = json.Unmarshal(manifest["name"], &name)
		if name = strings.TrimSpace(name); name == "" {
			name, _, _ = strings.Cut(key, "@")
		}
		out = append(out, plugin{name: name, dir: dir, manifest: manifest})
	}
	return out
}
