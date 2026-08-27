package service

import (
	"bufio"
	"io"
	"strings"
)

// scriptMetaScanLimit bounds how much of an init script the parser reads.
const scriptMetaScanLimit = 8192

// scriptMeta holds the machine-readable declarations an Entware init script
// exposes. enabled is nil when the script has no ENABLED= line.
type scriptMeta struct {
	enabled *bool
	// procs is the first declared process name; multi-proc PROCS is intentionally
	// narrowed to its first token.
	procs   string
	name    string
	daemon  string
	script  string
	pidFile string
}

func parseScriptMeta(r io.Reader) scriptMeta {
	var meta scriptMeta
	scanner := bufio.NewScanner(io.LimitReader(r, scriptMetaScanLimit))

	for scanner.Scan() {
		key, value, resolvable := splitAssignment(scanner.Text())

		if key == "" {
			continue
		}

		switch key {
		case "ENABLED":
			// rc.func enables only for exactly "yes"; any other *resolvable*
			// value, including an empty ENABLED=, disables the service. An
			// unresolvable value (shell expansion) leaves enabled nil so
			// discovery falls back to the S/K prefix rather than guessing.
			if resolvable {
				truthy := isTruthy(value)
				meta.enabled = &truthy
			}
		case "PROCS":
			// A multi-value PROCS ("a b c") is narrowed to its first token.
			if resolvable && meta.procs == "" {
				meta.procs = firstField(value)
			}
		case "NAME":
			if resolvable && meta.name == "" {
				meta.name = firstField(value)
			}
		case "DAEMON":
			if resolvable && meta.daemon == "" {
				meta.daemon = firstField(value)
			}
		case "SCRIPT":
			if resolvable && meta.script == "" {
				meta.script = firstField(value)
			}
		case "PID_FILE", "PIDFILE":
			if resolvable && value != "" && meta.pidFile == "" {
				meta.pidFile = value
			}
		}
	}

	return meta
}

// splitAssignment parses a shell `KEY=VALUE` line. It reports key=="" for
// non-assignments. resolvable is false when the value needs shell evaluation
// (`$` or backtick); an empty value is resolvable (it denotes the empty string),
// which lets ENABLED= be read as an explicit disable rather than as absent.
func splitAssignment(line string) (key, value string, resolvable bool) {
	line = strings.TrimSpace(line)
	line = strings.TrimPrefix(line, "export ")
	eq := strings.IndexByte(line, '=')

	if eq <= 0 {
		return "", "", false
	}

	key = strings.TrimSpace(line[:eq])

	if !isAssignmentKey(key) {
		return "", "", false
	}

	raw := strings.TrimSpace(line[eq+1:])

	if strings.ContainsAny(raw, "$`") {
		return key, "", false
	}

	return key, firstToken(raw), true
}

// firstField returns the first whitespace-delimited word of an already-unquoted
// value, so a quoted `PROCS="a b c"` narrows to "a".
func firstField(value string) string {
	if fields := strings.Fields(value); len(fields) > 0 {
		return fields[0]
	}

	return ""
}

func isAssignmentKey(key string) bool {
	if key == "" {
		return false
	}

	for i, r := range key {
		isUpper := r >= 'A' && r <= 'Z'
		isDigit := r >= '0' && r <= '9'

		if r == '_' || isUpper || (i > 0 && isDigit) {
			continue
		}

		return false
	}

	return true
}

// firstToken returns the first shell word of a value. A quoted value returns
// its inner content verbatim; an unquoted value returns up to the first space.
func firstToken(raw string) string {
	if raw == "" {
		return ""
	}

	if quote := raw[0]; quote == '"' || quote == '\'' {
		if end := strings.IndexByte(raw[1:], quote); end >= 0 {
			return raw[1 : 1+end]
		}

		return raw[1:]
	}

	if space := strings.IndexAny(raw, " \t"); space >= 0 {
		return raw[:space]
	}

	return raw
}

func isTruthy(value string) bool {
	return strings.ToLower(value) == "yes"
}
