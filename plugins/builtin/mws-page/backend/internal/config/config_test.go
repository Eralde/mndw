package config

import (
	"reflect"
	"testing"
	"time"
)

func TestParseAppliesIOTimeoutOverride(t *testing.T) {
	cfg, err := Parse([]string{"--io-timeout=17s"}, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}

	if cfg.IOTimeout != 17*time.Second {
		t.Fatalf("config = %#v", cfg)
	}
}

func TestParseIgnoresRemovedRuntimeDirectoryEnvironment(t *testing.T) {
	environ := func(name string) string {
		values := map[string]string{
			"MNDW_PLUGIN_RUNTIME_DIR": "/tmp/generic-plugin",
			"MNDW_MWSD_RUNTIME_DIR":   "/tmp/legacy-mwsd",
			"MWSD_RUNTIME_DIR":        "/tmp/old-mwsd",
		}

		return values[name]
	}

	cfg, err := Parse(nil, environ)
	if err != nil {
		t.Fatal(err)
	}

	if !reflect.DeepEqual(cfg, Default()) {
		t.Fatalf("config = %#v, want defaults %#v", cfg, Default())
	}
}

func TestParseRejectsNonPositiveLimits(t *testing.T) {
	if _, err := Parse([]string{"--io-timeout=0"}, func(string) string { return "" }); err == nil {
		t.Fatal("Parse() error = nil")
	}
}

func TestParseRejectsRemovedFlags(t *testing.T) {
	for _, argument := range []string{"--controller-url=http://192.0.2.1:79", "--auth-timeout=3s", "--max-response-bytes=1"} {
		t.Run(argument, func(t *testing.T) {
			if _, err := Parse([]string{argument}, func(string) string { return "" }); err == nil {
				t.Fatalf("Parse(%q) error = nil, want removed-flag error", argument)
			}
		})
	}
}
