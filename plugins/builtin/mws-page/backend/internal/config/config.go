package config

import (
	"flag"
	"fmt"
	"time"
)

type Config struct {
	IOTimeout time.Duration
}

func Default() Config {
	return Config{
		IOTimeout: 5 * time.Second,
	}
}

func Parse(args []string, environ func(string) string) (Config, error) {
	cfg := Default()
	fs := flag.NewFlagSet("mwsd", flag.ContinueOnError)

	fs.DurationVar(&cfg.IOTimeout, "io-timeout", cfg.IOTimeout, "socket I/O timeout")

	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}

	if cfg.IOTimeout <= 0 {
		return Config{}, fmt.Errorf("I/O timeout must be positive")
	}

	return cfg, nil
}
