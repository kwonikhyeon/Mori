// Package history reads what a person sent to Claude Code in a folder, from
// Claude Code's own record (claude-input design §5.1, spec §3 #226), for
// Mori's box to call back with ↑. The record is Claude Code's internal file
// and may change between its versions: a line it cannot read is skipped,
// and no file reads as nothing.
package history

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
)

// Prompt is one thing sent, and when, in Unix milliseconds.
type Prompt struct {
	Text string `json:"text"`
	At   int64  `json:"at"`
}

// tail is how much of the file's end is read: the newest entries are there.
const tail = 4 << 20

// MaxLimit is the most prompts one read gives.
const MaxLimit = 500

type entry struct {
	Display string `json:"display"`
	Project string `json:"project"`
	At      int64  `json:"timestamp"`
	Pasted  map[string]struct {
		Content *string `json:"content"`
	} `json:"pastedContents"`
}

var pastedRef = regexp.MustCompile(`\[Pasted text #(\d+)[^\]]*\]`)

// Read gives what was sent in project, newest first, a repeat of the one
// before it dropped, at most limit (MaxLimit at most). config is Claude
// Code's config folder; its history.jsonl missing, or config empty, gives
// nothing.
func Read(config, project string, limit int) ([]Prompt, error) {
	if config == "" {
		return nil, nil
	}
	f, err := os.Open(filepath.Join(config, "history.jsonl"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	from := max(0, st.Size()-tail)
	if _, err := f.Seek(from, io.SeekStart); err != nil {
		return nil, err
	}
	r := bufio.NewReader(f)
	if from > 0 {
		// the first line read from the middle is a piece of one
		if _, err := r.ReadBytes('\n'); err != nil {
			return nil, nil
		}
	}
	var all []Prompt
	for {
		// a line of any length, a big paste: no more than the tail read
		raw, err := r.ReadBytes('\n')
		if len(raw) == 0 && err != nil {
			break
		}
		b := bytes.TrimSpace(raw)
		if len(b) == 0 {
			continue
		}
		var e entry
		if json.Unmarshal(b, &e) != nil || e.Display == "" || e.Project != project {
			continue
		}
		text := pastedRef.ReplaceAllStringFunc(e.Display, func(ref string) string {
			n := pastedRef.FindStringSubmatch(ref)[1]
			if p, ok := e.Pasted[n]; ok && p.Content != nil {
				return *p.Content
			}
			return ref
		})
		if len(all) > 0 && all[len(all)-1].Text == text {
			continue
		}
		all = append(all, Prompt{Text: text, At: e.At})
	}
	slices.Reverse(all)
	limit = min(max(limit, 0), MaxLimit)
	if len(all) > limit {
		all = all[:limit]
	}
	return all, nil
}
