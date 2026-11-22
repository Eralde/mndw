package iperf

import (
	"bytes"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseLineInterval(t *testing.T) {
	content, err := os.ReadFile(filepath.Join("testdata", "download.jsonl"))
	if err != nil {
		t.Fatal(err)
	}

	lines := bytes.Split(bytes.TrimSpace(content), []byte("\n"))

	if len(lines) < 2 {
		t.Fatalf("fixture has %d lines, want at least 2", len(lines))
	}

	event, ok, err := ParseLine(lines[1])
	if err != nil {
		t.Fatal(err)
	}

	if !ok {
		t.Fatal("interval was ignored")
	}

	if event.Kind != EventInterval || event.Second != 1 || math.Abs(event.BitsPerSecond-19893838.208391715) > 1e-6 {
		t.Fatalf("unexpected interval: %#v", event)
	}
}

func TestParseLineEndReceiver(t *testing.T) {
	tests := []struct {
		name string
		file string
		want float64
	}{
		{name: "download", file: "download.jsonl", want: 44728776.13305153},
		{name: "upload", file: "upload.jsonl", want: 66267223.6399282},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			content, err := os.ReadFile(filepath.Join("testdata", test.file))
			if err != nil {
				t.Fatal(err)
			}

			lines := bytes.Split(bytes.TrimSpace(content), []byte("\n"))
			event, ok, err := ParseLine(lines[len(lines)-1])
			if err != nil {
				t.Fatal(err)
			}

			if !ok || event.Kind != EventEnd || math.Abs(event.BitsPerSecond-test.want) > 1e-6 {
				t.Fatalf("unexpected end event: ok=%v event=%#v", ok, event)
			}
		})
	}
}

func TestParseLineError(t *testing.T) {
	content, err := os.ReadFile(filepath.Join("testdata", "busy.jsonl"))
	if err != nil {
		t.Fatal(err)
	}

	line := bytes.Split(bytes.TrimSpace(content), []byte("\n"))[0]
	event, ok, err := ParseLine(line)
	if err != nil {
		t.Fatal(err)
	}

	if !ok || event.Kind != EventError || !strings.Contains(event.ErrorText, "server is busy") {
		t.Fatalf("unexpected error event: ok=%v event=%#v", ok, event)
	}
}

func TestParseLineEmptyEnd(t *testing.T) {
	content, err := os.ReadFile(filepath.Join("testdata", "busy.jsonl"))
	if err != nil {
		t.Fatal(err)
	}

	line := bytes.Split(bytes.TrimSpace(content), []byte("\n"))[1]
	_, ok, err := ParseLine(line)
	if err != nil {
		t.Fatal(err)
	}

	if ok {
		t.Fatal("empty end event was not ignored")
	}
}

func TestParseLineMalformed(t *testing.T) {
	if _, _, err := ParseLine([]byte(`{"event":`)); err == nil {
		t.Fatal("malformed JSON returned no error")
	}
}
