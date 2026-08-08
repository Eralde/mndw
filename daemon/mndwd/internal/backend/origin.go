package backend

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

func CanonicalRoutePath(path string) (string, bool) {
	if path == "" || strings.HasPrefix(path, "/") || strings.ContainsAny(path, `\\?#`) {
		return "", false
	}
	decoded, err := url.PathUnescape(path)
	if err != nil || decoded != path || strings.Contains(decoded, "%") || strings.HasPrefix(decoded, "/") || strings.Contains(decoded, `\`) {
		return "", false
	}
	segments := strings.Split(decoded, "/")
	if len(segments) == 0 || segments[0] == "_mndw" {
		return "", false
	}
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			return "", false
		}
	}

	return decoded, true
}

// ValidWebSocketOrigin accepts a missing Origin (native clients commonly omit
// it) and exactly one well-formed HTTP(S) origin whose authority matches Host.
// It rejects lists, credentials, paths, and default-port variants that do not
// normalize to the request authority.
func ValidWebSocketOrigin(request *http.Request) bool {
	origins := request.Header.Values("Origin")
	if len(origins) == 0 || (len(origins) == 1 && strings.TrimSpace(origins[0]) == "") {
		return true
	}
	if len(origins) != 1 {
		return false
	}
	origin, err := url.Parse(strings.TrimSpace(origins[0]))
	if err != nil || (origin.Scheme != "http" && origin.Scheme != "https") || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || origin.Host == "" {
		return false
	}
	return originMatchesHost(origin.Scheme, origin.Host, request.Host)
}

func originMatchesHost(scheme, originHost, requestHost string) bool {
	if !validAuthorityPort(originHost) || !validAuthorityPort(requestHost) {
		return false
	}
	if !strings.EqualFold(strings.TrimSuffix(hostnameOnly(originHost), "."), strings.TrimSuffix(hostnameOnly(requestHost), ".")) {
		return false
	}
	originPort := portOnly(originHost)
	if originPort == "" {
		if scheme == "https" {
			originPort = "443"
		} else {
			originPort = "80"
		}
	}
	requestPort := portOnly(requestHost)
	if requestPort != "" {
		return requestPort == originPort
	}

	// Host has no scheme, and a reverse proxy may terminate either HTTP or
	// HTTPS before forwarding to mndwd. An omitted Host port therefore matches
	// either standard origin port, but never an arbitrary explicit port.
	return originPort == "80" || originPort == "443"
}

func validAuthorityPort(host string) bool {
	if strings.HasPrefix(host, "[") {
		end := strings.IndexByte(host, ']')
		if end < 0 {
			return false
		}
		suffix := host[end+1:]
		return suffix == "" || (strings.HasPrefix(suffix, ":") && validPort(suffix[1:]) != "")
	}
	if strings.Count(host, ":") == 1 {
		return validPort(host[strings.LastIndexByte(host, ':')+1:]) != ""
	}
	return !strings.Contains(host, ":")
}

func normalizeHost(host string) string {
	parsed, err := url.Parse("http://" + host)
	if err != nil || parsed.Host == "" {
		return ""
	}
	return normalizeAuthority(parsed.Scheme, parsed.Host)
}

func normalizeAuthority(scheme, host string) string {
	hostname := strings.ToLower(strings.TrimSuffix(hostnameOnly(host), "."))
	port := portOnly(host)
	if port == "" {
		if scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return strings.ToLower(scheme) + "://" + hostname + ":" + port
}

func hostnameOnly(host string) string {
	if strings.HasPrefix(host, "[") {
		if end := strings.IndexByte(host, ']'); end >= 0 {
			return host[1:end]
		}
	}
	if colon := strings.LastIndexByte(host, ':'); colon >= 0 && strings.Count(host, ":") == 1 {
		return host[:colon]
	}
	return host
}

func portOnly(host string) string {
	if strings.HasPrefix(host, "[") {
		if end := strings.IndexByte(host, ']'); end >= 0 && len(host) > end+1 && host[end+1] == ':' {
			return validPort(host[end+2:])
		}
		return ""
	}
	if colon := strings.LastIndexByte(host, ':'); colon >= 0 && strings.Count(host, ":") == 1 {
		return validPort(host[colon+1:])
	}
	return ""
}

func validPort(value string) string {
	port, err := strconv.Atoi(value)
	if err != nil || port < 1 || port > 65535 {
		return ""
	}
	return strconv.Itoa(port)
}
