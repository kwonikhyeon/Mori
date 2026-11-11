package history

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// line is one entry of history.jsonl as Claude Code writes it.
func line(t *testing.T, display, project string, at int64, pasted map[string]any) string {
	t.Helper()
	if pasted == nil {
		pasted = map[string]any{}
	}
	b, err := json.Marshal(map[string]any{"display": display, "pastedContents": pasted, "timestamp": at, "project": project, "sessionId": "s"})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func write(t *testing.T, lines ...string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "history.jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func texts(ps []Prompt) []string {
	out := make([]string, len(ps))
	for i, p := range ps {
		out[i] = p.Text
	}
	return out
}

func TestReadOneFolderNewestFirst(t *testing.T) {
	dir := write(t,
		line(t, "첫째", "/a", 1, nil),
		line(t, "다른 곳", "/b", 2, nil),
		line(t, "둘째", "/a", 3, nil),
		line(t, "/model", "/a", 4, nil),
	)
	ps, err := Read(dir, "/a", 200)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(texts(ps), "|"); got != "/model|둘째|첫째" {
		t.Fatalf("%q", got)
	}
	if ps[0].At != 4 {
		t.Fatalf("%+v", ps[0])
	}
}

func TestReadDropsARepeat(t *testing.T) {
	dir := write(t, line(t, "같다", "/a", 1, nil), line(t, "같다", "/a", 2, nil), line(t, "다르다", "/a", 3, nil), line(t, "같다", "/a", 4, nil))
	ps, _ := Read(dir, "/a", 200)
	if got := strings.Join(texts(ps), "|"); got != "같다|다르다|같다" {
		t.Fatalf("%q", got)
	}
}

func TestReadExpandsPastedText(t *testing.T) {
	dir := write(t,
		line(t, "봐 [Pasted text #1 +3 lines]", "/a", 1, map[string]any{"1": map[string]any{"id": 1, "type": "text", "content": "a\nb\nc"}}),
		line(t, "이것도 [Pasted text #2 +9 lines]", "/a", 2, map[string]any{"2": map[string]any{"id": 2, "type": "text", "contentHash": "abc"}}),
	)
	ps, _ := Read(dir, "/a", 200)
	if got := texts(ps); got[1] != "봐 a\nb\nc" || got[0] != "이것도 [Pasted text #2 +9 lines]" {
		t.Fatalf("%q", got)
	}
}

func TestReadSkipsBrokenLines(t *testing.T) {
	dir := write(t, "{not json", line(t, "좋은 줄", "/a", 1, nil), `{"project":"/a","timestamp":2}`, `{"display":"","project":"/a","timestamp":3}`)
	ps, err := Read(dir, "/a", 200)
	if err != nil || strings.Join(texts(ps), "|") != "좋은 줄" {
		t.Fatalf("%q %v", texts(ps), err)
	}
}

// A long history is read from its end: the newest entries are there.
func TestReadTheLastPart(t *testing.T) {
	var lines []string
	pad := strings.Repeat("x", 1000)
	for i := 0; i < 5200; i++ { // over 5MB of another folder first
		lines = append(lines, line(t, pad, "/b", int64(i), nil))
	}
	lines = append(lines, line(t, "끝", "/a", 99999, nil))
	dir := write(t, lines...)
	ps, err := Read(dir, "/a", 200)
	if err != nil || strings.Join(texts(ps), "|") != "끝" {
		t.Fatalf("%q %v", texts(ps), err)
	}
}

func TestReadLimit(t *testing.T) {
	var lines []string
	for i := 0; i < 600; i++ {
		lines = append(lines, line(t, "글 "+strings.Repeat("ㅋ", i%7)+string(rune('a'+i%26))+string(rune('A'+i/26)), "/a", int64(i), nil))
	}
	ps, _ := Read(write(t, lines...), "/a", 500)
	if len(ps) != 500 {
		t.Fatal(len(ps))
	}
}

func TestReadNoFile(t *testing.T) {
	ps, err := Read(t.TempDir(), "/a", 200)
	if err != nil || len(ps) != 0 {
		t.Fatalf("%v %v", ps, err)
	}
	ps, err = Read("", "/a", 200)
	if err != nil || len(ps) != 0 {
		t.Fatalf("%v %v", ps, err)
	}
}

// A line longer than any read buffer, a big paste, does not end the read:
// what was sent after it still comes.
func TestReadPastAHugeLine(t *testing.T) {
	huge := line(t, strings.Repeat("ㅋ", 700_000), "/a", 1, nil) // about 2MB
	dir := write(t, huge, line(t, "그 뒤의 글", "/a", 2, nil))
	ps, err := Read(dir, "/a", 200)
	if err != nil || len(ps) != 2 || ps[0].Text != "그 뒤의 글" {
		t.Fatalf("%d %v", len(ps), err)
	}
}
