// Package store keeps Mori's persistent state in a single state.json.
package store

import (
	"crypto/rand"
	"encoding/hex"
)

// SchemaVersion is the state.json layout this build writes.
const SchemaVersion = 1

// State is everything Mori keeps across restarts. Pairing codes and the
// terminal cache live only in memory.
type State struct {
	Version  int       `json:"version"`
	Folders  []Folder  `json:"folders"`
	Hosts    []Host    `json:"hosts"`
	Presets  []Preset  `json:"presets"`
	Notify   Notify    `json:"notify"`
	Devices  []Device  `json:"devices"`
	PushSubs []PushSub `json:"push_subscriptions"`
	VAPID    VAPID     `json:"vapid"`
}

// Folder is a registered project directory.
type Folder struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	CreatedMs int64  `json:"created_ms"`
}

// Host is another machine's Mori that this hub links to (spec §3 #158~#168).
// ID never changes, even when the host is linked again.
type Host struct {
	ID   string   `json:"id"`
	Name string   `json:"name"`
	URL  string   `json:"url"` // the host's origin
	Link HostLink `json:"link,omitzero"`
}

// HostLink is the hub's pairing with the host. An empty Token means not linked.
type HostLink struct {
	Token    string `json:"token"`
	Version  string `json:"version"` // the host's Mori version when linked
	LinkedMs int64  `json:"linked_ms"`
	Relay    Relay  `json:"relay,omitzero"`
}

// Relay is the push subscription the hub holds on the host (spec §3 #165): the host
// sends its notifications to <Base>/api/relay/<Secret>, encrypted to Key and Auth.
type Relay struct {
	Secret string `json:"secret"`
	Key    string `json:"key"`  // P-256 private key, base64url without padding
	Auth   string `json:"auth"` // 16-byte auth secret, base64url without padding
	Base   string `json:"base"` // the hub public URL the endpoint was made from
	OK     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
}

// Preset is a program a new session starts with. An empty Argv runs the
// machine's shell. A Task preset takes the task text as its last argument.
type Preset struct {
	ID   string   `json:"id"`
	Name string   `json:"name"`
	Argv []string `json:"argv"`
	Task bool     `json:"task"`
}

// Notify holds the host-wide notification settings.
type Notify struct {
	Children bool `json:"children"` // also notify for terminals that have a parent
}

// Device is a paired browser. Only the SHA-256 of its token is kept.
type Device struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	CreatedMs  int64  `json:"created_ms"`
	LastSeenMs int64  `json:"last_seen_ms"`
	UserAgent  string `json:"user_agent"`
	TokenHash  string `json:"token_hash"`
}

// PushSub is a Web Push subscription that belongs to a device.
type PushSub struct {
	ID        string   `json:"id"`
	DeviceID  string   `json:"device_id"`
	Endpoint  string   `json:"endpoint"`
	P256dh    string   `json:"p256dh"`
	Auth      string   `json:"auth"`
	Kinds     []string `json:"kinds"`
	CreatedMs int64    `json:"created_ms"`
}

// VAPID is the key pair that signs Web Push requests, base64url encoded.
type VAPID struct {
	Public  string `json:"public"`
	Private string `json:"private"`
}

// DefaultPresets are the presets of a fresh state (spec §6.3).
func DefaultPresets() []Preset {
	return []Preset{
		{ID: "claude", Name: "Claude Code", Argv: []string{"claude"}, Task: true},
		{ID: "codex", Name: "Codex", Argv: []string{"codex"}, Task: true},
		{ID: "shell", Name: "셸", Argv: []string{}},
	}
}

// NewID returns prefix followed by 8 random hex digits.
func NewID(prefix string) string {
	var b [4]byte
	rand.Read(b[:]) // never fails; the runtime aborts if the OS source does
	return prefix + hex.EncodeToString(b[:])
}

func defaultState() State {
	return normalize(State{Version: SchemaVersion, Presets: DefaultPresets()})
}

// normalize fills what an older or hand-edited file may lack, so callers can
// rely on non-nil slices and JSON always shows [] rather than null.
func normalize(st State) State {
	if st.Version == 0 {
		st.Version = SchemaVersion
	}
	if st.Presets == nil {
		st.Presets = DefaultPresets()
	}
	if st.Folders == nil {
		st.Folders = []Folder{}
	}
	if st.Hosts == nil {
		st.Hosts = []Host{}
	}
	for i := range st.Hosts {
		if st.Hosts[i].ID == "" {
			st.Hosts[i].ID = NewID("h_")
		}
	}
	if st.Devices == nil {
		st.Devices = []Device{}
	}
	if st.PushSubs == nil {
		st.PushSubs = []PushSub{}
	}
	for i := range st.Presets {
		if st.Presets[i].Argv == nil {
			st.Presets[i].Argv = []string{}
		}
	}
	for i := range st.PushSubs {
		if st.PushSubs[i].Kinds == nil {
			st.PushSubs[i].Kinds = []string{}
		}
	}
	return st
}
