package backend

import (
	"regexp"
	"strings"
)

var stderrSecret = regexp.MustCompile(`(?i)(password|passwd|token|secret|authorization|cookie)([=:][[:space:]]*)[^[:space:]]+`)

func redactStderrLines(lines []string) []string {
	redacted := make([]string, 0, len(lines))

	for _, line := range lines {
		line = stderrSecret.ReplaceAllString(line, "$1$2[redacted]")

		if strings.ContainsRune(line, '\x00') {
			line = strings.ReplaceAll(line, "\x00", "[redacted]")
		}

		redacted = append(redacted, line)
	}

	return redacted
}
