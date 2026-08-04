package target

import (
	"fmt"
	"net"
	"net/url"
	"strings"

	"mndwd/internal/keenetic/auth"
	"mndwd/internal/keenetic/discovery"
)

type Target struct {
	ID      string
	Address net.IP
	BaseURL string
}

func Resolve(member discovery.Member) (Target, error) {
	ip := net.ParseIP(strings.TrimSpace(member.IP))
	if ip == nil || !AllowedIP(ip) {
		return Target{}, fmt.Errorf("node has unsafe address")
	}
	return Target{ID: member.Identity(), Address: ip, BaseURL: "http://" + net.JoinHostPort(ip.String(), "79")}, nil
}

func AllowedIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() {
		return false
	}
	return ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

func (t Target) AuthTarget() auth.Target { return auth.Target{BaseURL: t.BaseURL} }

func (t Target) URL(path string) (*url.URL, error) {
	if !AllowedIP(t.Address) {
		return nil, fmt.Errorf("unsafe target")
	}
	if err := ValidateRCIPath(path); err != nil {
		return nil, err
	}
	return url.Parse(strings.TrimRight(t.BaseURL, "/") + "/" + strings.TrimLeft(path, "/"))
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
	return nil
}

type ClientPolicy struct {
	MaxResponseBytes int64
	NoRedirect       bool
}

func (p ClientPolicy) ValidateResponse(status int, location string) error {
	if p.NoRedirect && status >= 300 && status < 400 && location != "" {
		return fmt.Errorf("target redirect rejected")
	}
	return nil
}
