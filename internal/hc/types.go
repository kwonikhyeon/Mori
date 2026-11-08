package hc

import "encoding/json"

// Terminal is a terminal record as the core reports it. Fields the schema
// marks nullable are pointers; fields with a default are plain values.
type Terminal struct {
	Address   string            `json:"address"`
	Argv      []string          `json:"argv"`
	Cols      int               `json:"cols"`
	Rows      int               `json:"rows"`
	CreatedMs int64             `json:"created_ms"`
	Cwd       string            `json:"cwd"`
	Labels    map[string]string `json:"labels"`
	Screen    string            `json:"screen"`
	State     string            `json:"state"` // live, finished

	DieWithParent bool              `json:"die_with_parent"`
	Identity      string            `json:"identity"`
	Keep          bool              `json:"keep"`
	Notify        bool              `json:"notify"`
	Records       map[string]Status `json:"records"`
	Reported      bool              `json:"reported"`
	Rm            bool              `json:"rm"`
	Title         string            `json:"title"` // set by the program
	Turn          int64             `json:"turn"`

	ExitCode     *int          `json:"exit_code"`
	FinishedMs   *int64        `json:"finished_ms"`
	FirstMessage *FirstMessage `json:"first_message"`
	Foreground   *Foreground   `json:"foreground"`
	Name         *string       `json:"name"`
	Parent       *string       `json:"parent"`
	PasteGapMs   *int64        `json:"paste_gap_ms"`
	Pid          *int          `json:"pid"`
	Reason       *string       `json:"reason"`
	Signal       *int          `json:"signal"`
	Status       *Status       `json:"status"`
	StatusMs     *int64        `json:"status_ms"`
	Stop         *string       `json:"stop"`
	Submit       *string       `json:"submit"`
	Template     *string       `json:"template"`
}

// Status is what the program reports about itself (blocked, working, ...).
type Status struct {
	State    string  `json:"state"`
	App      string  `json:"app"`
	Kind     *string `json:"kind"`
	Msg      string  `json:"msg"`
	Progress *int    `json:"progress"`
	Title    string  `json:"title"`
}

// Foreground is the process in the foreground of a terminal.
type Foreground struct {
	Pid  int      `json:"pid"`
	Name string   `json:"name"`
	Argv []string `json:"argv"`
	Cwd  string   `json:"cwd"`
}

// FirstMessage tells whether a task given at start was typed in.
type FirstMessage struct {
	Sent    bool    `json:"sent"`
	Reason  *string `json:"reason"`
	Started *bool   `json:"started"`
	Turn    *int64  `json:"turn"`
}

// Display holds a viewer's colors and cell size in pixels.
type Display struct {
	FG     string `json:"fg,omitempty"`
	BG     string `json:"bg,omitempty"`
	Cursor string `json:"cursor,omitempty"`
	Cell   []int  `json:"cell,omitempty"`
}

// HelloResult is the reply to hello.
type HelloResult struct {
	Version    string   `json:"version"`
	Generation int      `json:"generation"`
	Framed     bool     `json:"framed"`
	Features   []string `json:"features"`
	Methods    []string `json:"methods"`
	Core       CoreInfo `json:"core"`
}

// CoreInfo names a core.
type CoreInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Size is a terminal size in cells.
type Size struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

// CloseReason is the payload of a CLOSE frame from the core.
type CloseReason struct {
	Reason   string `json:"reason"`
	ExitCode *int   `json:"exit_code"`
	Signal   *int   `json:"signal"`
}

// RunParams are the terminal.run parameters Mori uses. An empty Argv runs
// the machine's own shell.
type RunParams struct {
	Argv     []string          `json:"argv,omitempty"`
	Cwd      string            `json:"cwd,omitempty"`
	Env      map[string]string `json:"env,omitempty"`
	Keep     bool              `json:"keep,omitempty"`
	Labels   map[string]string `json:"labels,omitempty"`
	NoParent bool              `json:"no_parent,omitempty"`
	Size     *Size             `json:"size,omitempty"`
}

// Snapshot is the state of the matching terminals at Seq.
type Snapshot struct {
	Seq       int64      `json:"seq"`
	Terminals []Terminal `json:"terminals"`
}

// Event is one change after a snapshot. Terminal is empty for doc events;
// Machine names the added machine a change came from.
type Event struct {
	Seq      int64           `json:"seq"`
	Type     string          `json:"type"`
	Terminal string          `json:"terminal,omitempty"`
	Machine  string          `json:"machine,omitempty"`
	Data     json.RawMessage `json:"data,omitempty"`
}
