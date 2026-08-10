package config

import (
	"testing"
	"time"
)

func TestParseRetainsControllerAndTimeoutOptions(t *testing.T) {
	environ := func(name string) string {
		values := map[string]string{
			"MWSD_CONTROLLER_URL": "http://controller.test:79",
		}
		return values[name]
	}
	cfg, err := Parse([]string{"--controller-url=http://flag.test:79", "--io-timeout=3s", "--auth-timeout=17s", "--max-response-bytes=1024"}, environ)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ControllerURL != "http://flag.test:79" || cfg.IOTimeout != 3*time.Second || cfg.AuthOperation != 17*time.Second || cfg.MaxResponseBytes != 1024 {
		t.Fatalf("config = %#v", cfg)
	}
}

func TestParseRejectsRemovedOptions(t *testing.T) {
	for _, args := range [][]string{
		{"--runtime-dir=/tmp/mwsd"},
		{"--operation-timeout=3s"},
		{"--max-request-bytes=1024"},
	} {
		if _, err := Parse(args, func(string) string { return "" }); err == nil {
			t.Fatalf("Parse(%v) error = nil", args)
		}
	}
}

func TestParseRejectsNonPositiveResponseLimit(t *testing.T) {
	if _, err := Parse([]string{"--max-response-bytes=0"}, func(string) string { return "" }); err == nil {
		t.Fatal("Parse() error = nil")
	}
}
