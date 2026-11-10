package commands

import (
	"encoding/json"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

// maxDesc is how many characters of a description are kept.
const maxDesc = 200

var (
	keyLine   = regexp.MustCompile(`^([A-Za-z0-9_-]+):\s*(.*)$`)
	blockMark = regexp.MustCompile(`^[>|][+-]?$`)
	comment   = regexp.MustCompile(`\s+#.*$`)
	heading   = regexp.MustCompile(`^#+\s*`)
	falsyWord = regexp.MustCompile(`(?i)^(false|no|off)$`)
)

// frontmatter reads the YAML header of a command or skill file: the lines
// between a first line of "---" and the next line of "---". It knows just
// the YAML these files use: key: value lines, quoted values, block scalars
// (> and |), and a value on the indented lines under its key, a list among
// them. Nested keys are not read. body is the text after the header, or all
// of it when there is none.
func frontmatter(text string) (meta map[string]string, body string) {
	meta = map[string]string{}
	text = strings.TrimPrefix(text, "\ufeff")
	lines := strings.Split(text, "\n")
	if strings.TrimRight(lines[0], " \t\r") != "---" {
		return meta, text
	}
	end := slices.IndexFunc(lines[1:], func(l string) bool { return strings.TrimRight(l, " \t\r") == "---" })
	if end < 0 {
		return meta, text
	}
	head := slices.Clone(lines[1 : end+1])
	for i := range head {
		head[i] = strings.TrimRight(head[i], "\r")
	}
	for i := 0; i < len(head); i++ {
		m := keyLine.FindStringSubmatch(head[i])
		if m == nil {
			continue
		}
		key, raw := m[1], strings.TrimSpace(m[2])
		// under takes the lines below the key that belong to it; blank says
		// whether an empty line does.
		under := func(blank bool) []string {
			var out []string
			for i+1 < len(head) && (indented(head[i+1]) || blank && strings.TrimSpace(head[i+1]) == "") {
				i++
				out = append(out, strings.TrimSpace(head[i]))
			}
			return out
		}
		switch {
		case blockMark.MatchString(raw):
			block := under(true)
			if raw[0] == '>' {
				meta[key] = strings.Join(slices.DeleteFunc(block, func(l string) bool { return l == "" }), " ")
			} else {
				meta[key] = strings.TrimSpace(strings.Join(block, "\n"))
			}
		case raw == "":
			items := under(false)
			for j, l := range items {
				items[j] = scalar(strings.TrimSpace(strings.TrimPrefix(l, "-")))
			}
			meta[key] = strings.Join(slices.DeleteFunc(items, func(l string) bool { return l == "" }), " ")
		default:
			meta[key] = scalar(strings.Join(append([]string{raw}, under(false)...), " "))
		}
	}
	return meta, strings.Join(lines[end+2:], "\n")
}

func indented(line string) bool {
	return line != "" && (line[0] == ' ' || line[0] == '\t') && strings.TrimSpace(line) != ""
}

// scalar is the value of a YAML scalar on one line: without its quotes, or
// without a comment after it.
func scalar(raw string) string {
	if raw == "" {
		return ""
	}
	q := raw[0]
	if q != '"' && q != '\'' {
		return strings.TrimSpace(comment.ReplaceAllString(raw, ""))
	}
	v := raw
	if len(v) < 2 || v[len(v)-1] != q {
		v = strings.TrimSpace(comment.ReplaceAllString(v, ""))
	}
	if len(v) < 2 || v[len(v)-1] != q {
		return strings.Trim(raw, string(q)) // a quote that does not close
	}
	if q == '\'' {
		return strings.ReplaceAll(v[1:len(v)-1], "''", "'")
	}
	var s string
	if json.Unmarshal([]byte(v), &s) == nil {
		return s
	}
	return v[1 : len(v)-1] // an escape JSON does not know
}

// falsy says whether a header value turns something off.
func falsy(v string) bool { return falsyWord.MatchString(strings.TrimSpace(v)) }

// oneLine puts s on one line of at most maxDesc characters.
func oneLine(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= maxDesc {
		return s
	}
	return strings.TrimSpace(string([]rune(s)[:maxDesc-1])) + "…"
}

// firstLine is the first line of body with something on it, without a
// heading mark: what a file without a description says first.
func firstLine(body string) string {
	for line := range strings.Lines(body) {
		if l := strings.TrimSpace(heading.ReplaceAllString(strings.TrimSpace(line), "")); l != "" {
			return l
		}
	}
	return ""
}

// describe is what a command file says it does: its description, or its
// first line.
func describe(meta map[string]string, body string) string {
	if d := oneLine(meta["description"]); d != "" {
		return d
	}
	return oneLine(firstLine(body))
}
