package dispatch

import (
	"bytes"
	"net/http"
	"strconv"
	"strings"
)

// parseCGIResponse splits a script's stdout into a status, headers, and body under
// the CGI-ish contract (design §5.3): an optional block of `Key: Value` lines, a
// blank line, then the body. `Status:` sets the HTTP status; other lines become
// response headers.
//
// The parse is deliberately conservative: it only treats the leading bytes as a
// header block when a blank-line separator exists AND every line before it is a
// valid `token: value` header. Otherwise the whole output is the body with a 200 —
// so a script that just prints JSON (which may contain colons and blank lines) is
// never misread as headers.
func parseCGIResponse(out []byte) (int, http.Header, []byte) {
	sepEnd, bodyStart := findHeaderSep(out)
	if sepEnd < 0 {
		return http.StatusOK, http.Header{}, out
	}

	status := http.StatusOK
	header := http.Header{}

	for _, raw := range bytes.Split(out[:sepEnd], []byte("\n")) {
		line := strings.TrimRight(string(raw), "\r")
		if line == "" {
			continue
		}

		colon := strings.IndexByte(line, ':')
		if colon <= 0 {
			return http.StatusOK, http.Header{}, out
		}

		key := strings.TrimSpace(line[:colon])
		if !isToken(key) {
			return http.StatusOK, http.Header{}, out
		}
		value := strings.TrimSpace(line[colon+1:])

		if strings.EqualFold(key, "Status") {
			status = parseStatus(value)

			continue
		}
		header.Add(key, value)
	}

	return status, header, out[bodyStart:]
}

// findHeaderSep returns the end index of the header block and the start index of the
// body, or (-1, -1) when no blank-line separator is present.
func findHeaderSep(out []byte) (sepEnd, bodyStart int) {
	if i := bytes.Index(out, []byte("\r\n\r\n")); i >= 0 {
		return i, i + 4
	}
	if i := bytes.Index(out, []byte("\n\n")); i >= 0 {
		return i, i + 2
	}

	return -1, -1
}

// parseStatus reads the leading integer of a Status line ("200" or "200 OK").
func parseStatus(value string) int {
	fields := strings.Fields(value)
	if len(fields) == 0 {
		return http.StatusOK
	}
	code, err := strconv.Atoi(fields[0])
	if err != nil || code < 100 || code > 599 {
		return http.StatusOK
	}

	return code
}

// isToken reports whether s is a valid HTTP header field-name token. A JSON key like
// `{"a"` fails this, so JSON bodies are never mistaken for a header block.
func isToken(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-' || r == '_':
		default:
			return false
		}
	}

	return true
}
