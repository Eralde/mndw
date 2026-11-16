// Package target resolves a discovery.Member into a concrete, safe dial target:
// the controller-reported FQDN (preferred, resolved via the controller's DNS
// proxy) or a vetted private/link-local IP. It also validates outbound RCI
// request paths, refusing traversal or absolute paths before a request is sent.
package target

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strings"
)

type Access int

const (
	AccessWrite Access = iota
	AccessRead
)

var readRoots = map[string]struct{}{"show": {}, "whoami": {}}

// Classify returns the least-privileged access that can safely describe an RCI request.
// Any malformed or unknown request is write-classified so read-only grants fail closed.
func Classify(method, path string, body []byte) Access {
	if method != "GET" && method != "POST" {
		return AccessWrite
	}

	if err := ValidateRCIPath(path); err != nil {
		return AccessWrite
	}

	trimmed := strings.TrimSuffix(path, "/")

	if trimmed != "rci" {
		parts := strings.Split(trimmed, "/")

		if len(parts) < 2 {
			return AccessWrite
		}

		for _, part := range parts {
			if part == "" {
				return AccessWrite
			}
		}

		if _, ok := readRoots[parts[1]]; ok {
			return AccessRead
		}

		return AccessWrite
	}

	return classifyBody(body)
}

func classifyBody(body []byte) Access {
	var value any

	if err := json.Unmarshal(body, &value); err != nil {
		return AccessWrite
	}

	switch value := value.(type) {
	case map[string]any:
		return classifyRoot(value)
	case []any:
		if len(value) == 0 {
			return AccessWrite
		}

		for _, element := range value {
			object, ok := element.(map[string]any)

			if !ok || classifyRoot(object) != AccessRead {
				return AccessWrite
			}
		}

		return AccessRead
	default:
		return AccessWrite
	}
}

func classifyRoot(object map[string]any) Access {
	if len(object) != 1 {
		return AccessWrite
	}

	for root, value := range object {
		if containsArray(value) {
			return AccessWrite
		}

		path := root

		for {
			nested, ok := value.(map[string]any)

			if !ok || len(nested) != 1 {
				break
			}

			for key, child := range nested {
				path += "." + key
				value = child
			}
		}

		if _, ok := readRoots[strings.Split(path, ".")[0]]; ok {
			return AccessRead
		}
	}

	return AccessWrite
}

func containsArray(value any) bool {
	switch value := value.(type) {
	case []any:
		return true
	case map[string]any:
		for _, child := range value {
			if containsArray(child) {
				return true
			}
		}
	}

	return false
}

func NormalizeFQDN(value string) (string, error) {
	value = strings.TrimSpace(value)
	value = strings.TrimRight(value, ".")

	if value == "" || len(value) > 253 || net.ParseIP(value) != nil {
		return "", fmt.Errorf("node has invalid FQDN")
	}

	// Internationalized names are rejected rather than punycode-encoded. Firmware
	// supplied names must use the explicit ASCII hostname policy below.
	value = strings.ToLower(value)
	labels := strings.Split(value, ".")

	if len(labels) < 2 {
		return "", fmt.Errorf("node has invalid FQDN")
	}

	for _, label := range labels {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", fmt.Errorf("node has invalid FQDN")
		}

		for _, character := range []byte(label) {
			if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' {
				return "", fmt.Errorf("node has invalid FQDN")
			}
		}
	}

	return value, nil
}

func ValidateRCIPath(path string) error {
	if path == "" || !strings.HasPrefix(path, "rci/") {
		return fmt.Errorf("path must start with rci/")
	}

	parsed, err := url.Parse(path)
	if err != nil || parsed.IsAbs() || parsed.Host != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("path must be a relative RCI path")
	}

	if strings.Contains(path, "..") || strings.Contains(path, `\`) {
		return fmt.Errorf("path contains unsafe traversal")
	}

	trimmed := strings.TrimSuffix(path, "/")

	for _, segment := range strings.Split(trimmed, "/") {
		if segment == "" {
			return fmt.Errorf("path contains an empty segment")
		}
	}

	return nil
}
