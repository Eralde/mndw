package backend

import (
	"bufio"
	"bytes"
	"strings"
	"sync"
)

type StderrRing struct {
	mu       sync.Mutex
	maxBytes int
	maxLines int
	data     []byte
}

func NewStderrRing(maxBytes, maxLines int) *StderrRing {
	return &StderrRing{maxBytes: maxBytes, maxLines: maxLines}
}

func (r *StderrRing) Write(data []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.data = append(r.data, data...)
	if r.maxBytes > 0 && len(r.data) > r.maxBytes {
		r.data = r.data[len(r.data)-r.maxBytes:]
	}
	if r.maxLines > 0 {
		for bytes.Count(r.data, []byte{'\n'}) > r.maxLines {
			if index := bytes.IndexByte(r.data, '\n'); index >= 0 {
				r.data = r.data[index+1:]
			} else {
				break
			}
		}
	}

	return len(data), nil
}

func (r *StderrRing) Bytes() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()

	return append([]byte(nil), r.data...)
}

func (r *StderrRing) Lines() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	scanner := bufio.NewScanner(bytes.NewReader(r.data))
	lines := make([]string, 0)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			lines = append(lines, line)
		}
	}

	return lines
}
