package hc

import (
	"bytes"
	"errors"
	"io"
	"testing"
)

func TestFrameRoundTrip(t *testing.T) {
	in := []Frame{{0, KindData, []byte(`{"a":1}`)}, {7, KindCredit, []byte{1, 0, 0, 0}}, {9, KindClose, nil}}
	var b []byte
	for _, f := range in {
		b = AppendFrame(b, f)
	}
	r := bytes.NewReader(b)
	for _, want := range in {
		got, err := ReadFrame(r)
		if err != nil || got.Channel != want.Channel || got.Kind != want.Kind || !bytes.Equal(got.Payload, want.Payload) {
			t.Fatalf("got %+v %v want %+v", got, err, want)
		}
	}
	if _, err := ReadFrame(r); err != io.EOF {
		t.Fatal(err)
	}
}

func TestFrameHeaderLayout(t *testing.T) {
	b := AppendFrame(nil, Frame{Channel: 0x01020304, Kind: KindResize, Payload: sizePayload(80, 24)})
	want := []byte{4, 3, 2, 1, 3, 4, 0, 0, 0, 0x50, 0, 0x18, 0}
	if !bytes.Equal(b, want) {
		t.Fatalf("% x", b)
	}
}

func TestFrameTooLarge(t *testing.T) {
	h := []byte{0, 0, 0, 0, 0, 0x01, 0x00, 0x00, 0x01} // 16 MiB + 1
	if _, err := ReadFrame(bytes.NewReader(h)); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatal(err)
	}
}

func TestFrameCutShort(t *testing.T) {
	b := AppendFrame(nil, Frame{Channel: 1, Kind: KindData, Payload: []byte("hello")})
	for _, n := range []int{3, len(b) - 2} {
		if _, err := ReadFrame(bytes.NewReader(b[:n])); !errors.Is(err, io.ErrUnexpectedEOF) {
			t.Fatalf("cut at %d: %v", n, err)
		}
	}
}
