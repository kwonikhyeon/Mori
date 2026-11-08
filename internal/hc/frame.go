// Package hc is a client for herdr-core, spoken over `hc connect` in
// framed mode: JSON-RPC on channel 0, attach and event streams on others.
package hc

import (
	"encoding/binary"
	"errors"
	"io"
)

// Frame kinds.
const (
	KindData           byte = 0 // channel 0: one JSON-RPC message; others: stream bytes
	KindCredit         byte = 1 // u32 LE: bytes the receiver consumed
	KindClose          byte = 2 // the channel is over; from the core, a JSON reason
	KindResize         byte = 3 // u16 LE cols, u16 LE rows
	KindFocus          byte = 4 // viewer → core: 1 gained focus, 0 lost it
	KindFacts          byte = 5 // viewer → core: JSON Display facts
	KindAutomaticInput byte = 6 // viewer → core: replies the viewer's terminal typed by itself
)

const (
	// MaxPayload is the largest payload a frame may carry.
	MaxPayload = 16 << 20
	// InitialCredit is how many bytes a new stream may send before the
	// receiver grants more.
	InitialCredit = 256 << 10
	headerLen     = 9
)

// ErrFrameTooLarge reports a frame header announcing more than MaxPayload.
var ErrFrameTooLarge = errors.New("hc: frame payload too large")

// Frame is one unit of framed mode.
type Frame struct {
	Channel uint32
	Kind    byte
	Payload []byte
}

// AppendFrame appends the wire form of f to dst.
func AppendFrame(dst []byte, f Frame) []byte {
	dst = binary.LittleEndian.AppendUint32(dst, f.Channel)
	dst = append(dst, f.Kind)
	dst = binary.LittleEndian.AppendUint32(dst, uint32(len(f.Payload)))
	return append(dst, f.Payload...)
}

// ReadFrame reads one frame. It returns io.EOF only when r ends on a frame
// boundary, and io.ErrUnexpectedEOF when it ends inside a frame.
func ReadFrame(r io.Reader) (Frame, error) {
	var h [headerLen]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return Frame{}, err
	}
	n := binary.LittleEndian.Uint32(h[5:])
	if n > MaxPayload {
		return Frame{}, ErrFrameTooLarge
	}
	f := Frame{Channel: binary.LittleEndian.Uint32(h[:4]), Kind: h[4]}
	if n > 0 {
		f.Payload = make([]byte, n)
		if _, err := io.ReadFull(r, f.Payload); err != nil {
			if errors.Is(err, io.EOF) {
				err = io.ErrUnexpectedEOF
			}
			return Frame{}, err
		}
	}
	return f, nil
}

func u32(n uint32) []byte { return binary.LittleEndian.AppendUint32(nil, n) }

func sizePayload(cols, rows int) []byte {
	b := binary.LittleEndian.AppendUint16(nil, uint16(cols))
	return binary.LittleEndian.AppendUint16(b, uint16(rows))
}
