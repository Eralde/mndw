package config

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

type Config struct {
	RuntimeDir       string
	ControllerURL    string
	SocketName       string
	PIDName          string
	IOTimeout        time.Duration
	Operation        time.Duration
	AuthOperation    time.Duration
	MaxRequestBytes  int64
	MaxResponseBytes int64
}

func Default() Config {
	return Config{
		RuntimeDir:       "/opt/var/run/mndw-mws-map-page",
		ControllerURL:    "http://127.0.0.1:79",
		SocketName:       "mwsd.sock",
		PIDName:          "mwsd.pid",
		IOTimeout:        5 * time.Second,
		Operation:        5 * time.Second,
		AuthOperation:    15 * time.Second,
		MaxRequestBytes:  128 << 10,
		MaxResponseBytes: 512 << 10,
	}
}

func (c Config) SocketPath() string { return filepath.Join(c.RuntimeDir, c.SocketName) }
func (c Config) PIDPath() string    { return filepath.Join(c.RuntimeDir, c.PIDName) }

func Parse(args []string, environ func(string) string) (Config, error) {
	cfg := Default()
	fs := flag.NewFlagSet("mwsd", flag.ContinueOnError)
	runtimeDir := envOr(environ, "MNDW_PLUGIN_RUNTIME_DIR", "")

	if runtimeDir == "" {
		runtimeDir = envOr(environ, "MNDW_MWSD_RUNTIME_DIR", "")
	}

	if runtimeDir == "" {
		runtimeDir = envOr(environ, "MWSD_RUNTIME_DIR", cfg.RuntimeDir)
	}

	fs.StringVar(&cfg.RuntimeDir, "runtime-dir", runtimeDir, "runtime directory")
	fs.StringVar(&cfg.ControllerURL, "controller-url", envOr(environ, "MWSD_CONTROLLER_URL", cfg.ControllerURL), "controller URL")
	fs.DurationVar(&cfg.IOTimeout, "io-timeout", cfg.IOTimeout, "socket I/O timeout")
	fs.DurationVar(&cfg.Operation, "operation-timeout", cfg.Operation, "non-auth operation timeout")
	fs.DurationVar(&cfg.AuthOperation, "auth-timeout", cfg.AuthOperation, "authentication operation timeout")
	fs.Int64Var(&cfg.MaxRequestBytes, "max-request-bytes", cfg.MaxRequestBytes, "request cap")
	fs.Int64Var(&cfg.MaxResponseBytes, "max-response-bytes", cfg.MaxResponseBytes, "response cap")

	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}

	if cfg.IOTimeout <= 0 || cfg.Operation <= 0 || cfg.AuthOperation <= 0 || cfg.MaxRequestBytes <= 0 || cfg.MaxResponseBytes <= 0 {
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

func ParseIntEnv(environ func(string) string, name string, fallback int64) int64 {
	value := envOr(environ, name, "")

	if value == "" {
		return fallback
	}

	parsed, err := strconv.ParseInt(value, 10, 64)

	if err != nil || parsed <= 0 {
		return fallback
	}

	return parsed
}
