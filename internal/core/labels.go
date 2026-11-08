// Package core keeps Mori's view of one herdr-core: a cache of its
// terminals kept current from the event channel, and the connection to it.
package core

import (
	"strings"

	"github.com/kwonikhyeon/mori/internal/hc"
)

// Labels Mori puts on the terminals it starts.
const (
	LabelMori   = "mori"        // "1": Mori started it
	LabelFolder = "mori.folder" // the folder's ID
	LabelPreset = "mori.preset" // the preset's ID
	LabelTitle  = "mori.title"  // a name the user gave it
)

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
