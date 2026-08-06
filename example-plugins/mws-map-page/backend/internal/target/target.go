package target

import (
	"fmt"
	"net"
	"net/url"
	"strings"

	"mndw.local/device-auth"
	"mws-map-page/internal/discovery"
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
	return Target{ID: member.Identity(), Address: ip, BaseURL: "http://" + net.JoinHostPort(ip.String(), "80")}, nil
}

func AllowedIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() {
		return false
	}
	private := ip.IsPrivate()
	linkLocal := ip.IsLinkLocalUnicast()
	return private || linkLocal
}

func (t Target) AuthTarget() auth.Target { return auth.Target{BaseURL: t.BaseURL} }

func (t Target) URL(path string) (*url.URL, error) {
	if !AllowedIP(t.Address) {
		return nil, fmt.Errorf("unsafe target")
	}
	return url.Parse(strings.TrimRight(t.BaseURL, "/") + "/" + strings.TrimLeft(path, "/"))
}

// ClientPolicy is applied to every extender request: pinned address, no
// redirects, and bounded response body.
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
