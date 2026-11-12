// Package core keeps Mori's view of one herdr-core: a cache of its
// terminals kept current from the event channel, and the connection to it.
package core

import (
	"regexp"
	"strings"

	"github.com/kwonikhyeon/mori/internal/hc"
)

// Labels Mori puts on the terminals it starts.
const (
	LabelMori   = "mori"        // "1": Mori started it
	LabelFolder = "mori.folder" // the folder's ID
	LabelPreset = "mori.preset" // the preset's ID
	LabelTitle  = "mori.title"  // a name the user gave it

	// LabelClaudeSession is the ID of the conversation Claude Code holds
	// in the terminal, as its SessionStart hook last said (spec §3 #230).
	LabelClaudeSession = "mori.claude.session"
	// LabelClaudeResumed is the pid of the shell Mori last sent the
	// command that takes the conversation up again.
	LabelClaudeResumed = "mori.claude.resumed"
)

// sessionID is how Claude Code names a conversation: a UUID.
var sessionID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// IsSessionID says whether s names a Claude Code conversation.
func IsSessionID(s string) bool { return sessionID.MatchString(s) }

// DisplayTitle is the name to show for t: the user's name for it, the
// program's title, the foreground program, the started program, or "셸".
func DisplayTitle(t hc.Terminal) string {
	if s := strings.TrimSpace(t.Labels[LabelTitle]); s != "" {
		return s
	}
	if s := strings.TrimSpace(t.Title); s != "" {
		return s
	}
	if t.Foreground != nil && t.Foreground.Name != "" {
		return t.Foreground.Name
	}
	if len(t.Argv) > 0 {
		if s := programName(t.Argv[0]); s != "" {
			return s
		}
	}
	return "셸"
}

// programName is the file name of a program path from any OS: a terminal
// may run on another machine than Mori.
func programName(p string) string {
	if i := strings.LastIndexAny(p, `/\`); i >= 0 {
		p = p[i+1:]
	}
	if len(p) > 4 && strings.EqualFold(p[len(p)-4:], ".exe") {
		p = p[:len(p)-4]
	}
	return p
}
