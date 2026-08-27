package backend

import (
	"bytes"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

type CGIResponse struct {
	Status  int
	Headers http.Header
	Body    []byte
}

const (
	CodeBackendBodyTooLarge   = "BACKEND_BODY_TOO_LARGE"
	CodeBackendOutputTooLarge = "BACKEND_OUTPUT_TOO_LARGE"
)

func ParseCGIResponse(output []byte, maxBytes int64) (CGIResponse, error) {
	if maxBytes > 0 && int64(len(output)) > maxBytes {
		return CGIResponse{}, fmt.Errorf("backend response exceeds output limit")
	}

	response := CGIResponse{Status: http.StatusOK, Headers: make(http.Header), Body: output}
	separator, bodyStart := findCGIHeaderSeparator(output)

	if separator < 0 {
		response.Headers.Set("Content-Type", "application/json")
		response.Headers.Set("Cache-Control", "no-store")

		return response, nil
	}

	for _, rawLine := range bytes.Split(output[:separator], []byte("\n")) {
		line := strings.TrimSuffix(string(rawLine), "\r")

		if line == "" {
			continue
		}

		colon := strings.IndexByte(line, ':')

		if colon <= 0 {
			return CGIResponse{}, fmt.Errorf("malformed CGI response header")
		}

		name := strings.TrimSpace(line[:colon])
		value := strings.TrimSpace(line[colon+1:])

		if !validHeaderName(name) || hasControl(value) {
			return CGIResponse{}, fmt.Errorf("malformed CGI response header")
		}

		if strings.EqualFold(name, "Status") {
			status, err := parseCGIStatus(value)
			if err != nil {
				return CGIResponse{}, err
			}

			response.Status = status

			continue
		}

		if forbiddenResponseHeader(name) {
			continue
		}

		response.Headers.Add(name, value)
	}

	response.Body = output[bodyStart:]

	if response.Headers.Get("Content-Type") == "" {
		response.Headers.Set("Content-Type", "application/json")
	}

	response.Headers.Set("Cache-Control", "no-store")

	return response, nil
}

func findCGIHeaderSeparator(output []byte) (int, int) {
	if index := bytes.Index(output, []byte("\r\n\r\n")); index >= 0 {
		return index, index + 4
	}

	if index := bytes.Index(output, []byte("\n\n")); index >= 0 {
		return index, index + 2
	}

	return -1, -1
}

func parseCGIStatus(value string) (int, error) {
	fields := strings.Fields(value)

	if len(fields) == 0 {
		return 0, fmt.Errorf("malformed CGI status")
	}

	status, err := strconv.Atoi(fields[0])
	if err != nil || status < 100 || status > 599 {
		return 0, fmt.Errorf("malformed CGI status")
	}

	return status, nil
}

func validHeaderName(name string) bool {
	if name == "" {
		return false
	}

	for _, char := range name {
		if char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-' || char == '_' {
			continue
		}

		return false
	}

	return true
}

func hasControl(value string) bool {
	for _, char := range value {
		if char < 0x20 && char != '\t' || char == 0x7f {
			return true
		}
	}

	return false
}

func forbiddenResponseHeader(name string) bool {
	if strings.HasPrefix(strings.ToLower(name), "access-control-") {
		return true
	}

	switch strings.ToLower(name) {
	case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "set-cookie", "content-length":
		return true
	default:
		return false
	}
}
