package backend

import (
	"net/http"
	"testing"
)

func TestValidWebSocketOrigin(t *testing.T) {
	tests := []struct {
		name   string
		origin string
		host   string
		want   bool
	}{
		{name: "missing", host: "router.local", want: true},
		{name: "case insensitive", origin: "HTTP://ROUTER.LOCAL", host: "router.local", want: true},
		{name: "default port", origin: "http://router.local:80", host: "router.local", want: true},
		{name: "https default port behind proxy", origin: "https://router.local", host: "router.local", want: true},
		{name: "wrong authority", origin: "https://evil.local", host: "router.local", want: false},
		{name: "path", origin: "http://router.local/path", host: "router.local", want: false},
		{name: "multiple", origin: "http://router.local http://evil.local", host: "router.local", want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request, _ := http.NewRequest(http.MethodGet, "http://"+test.host+"/ws/plugins/demo/live", nil)
			request.Host = test.host
			if test.origin != "" {
				request.Header.Set("Origin", test.origin)
			}
			if got := ValidWebSocketOrigin(request); got != test.want {
				t.Fatalf("ValidWebSocketOrigin = %v, want %v", got, test.want)
			}
		})
	}
}

func TestNegotiateWebSocketProtocol(t *testing.T) {
	if got, ok := negotiateWebSocketProtocol([]string{"mndw.tty", "mndw.raw"}, []string{"other, mndw.raw"}); !ok || got != "mndw.raw" {
		t.Fatalf("protocol = %q, %v", got, ok)
	}
	if got, ok := negotiateWebSocketProtocol([]string{"mndw.v1"}, []string{"other"}); ok || got != "" {
		t.Fatalf("unexpected protocol = %q, %v", got, ok)
	}
	if got, ok := negotiateWebSocketProtocol(nil, nil); !ok || got != "" {
		t.Fatalf("empty protocol = %q, %v", got, ok)
	}
}
