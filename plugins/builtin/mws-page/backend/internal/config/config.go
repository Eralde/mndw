package config

import (
	"flag"
	"fmt"
	"os"
	"time"
)

type Config struct {
	ControllerURL    string
	IOTimeout        time.Duration
	AuthOperation    time.Duration
	MaxResponseBytes int64
}

func Default() Config {
	return Config{
		ControllerURL:    "http://127.0.0.1:79",
		IOTimeout:        5 * time.Second,
		AuthOperation:    15 * time.Second,
		MaxResponseBytes: 512 << 10,
	}
}

func Parse(args []string, environ func(string) string) (Config, error) {
	cfg := Default()
	fs := flag.NewFlagSet("mwsd", flag.ContinueOnError)

	fs.StringVar(&cfg.ControllerURL, "controller-url", envOr(environ, "MWSD_CONTROLLER_URL", cfg.ControllerURL), "controller URL")
	fs.DurationVar(&cfg.IOTimeout, "io-timeout", cfg.IOTimeout, "socket I/O timeout")
	fs.DurationVar(&cfg.AuthOperation, "auth-timeout", cfg.AuthOperation, "authentication operation timeout")
	fs.Int64Var(&cfg.MaxResponseBytes, "max-response-bytes", cfg.MaxResponseBytes, "response cap")

	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}

	if cfg.IOTimeout <= 0 || cfg.AuthOperation <= 0 || cfg.MaxResponseBytes <= 0 {
		return Config{}, fmt.Errorf("timeouts and message limits must be positive")
	}

	return cfg, nil
}

func envOr(environ func(string) string, name, fallback string) string {
	if environ == nil {
		environ = os.Getenv
	}

	if value := environ(name); value != "" {
		return value
	}

	return fallback
}
