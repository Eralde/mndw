package backend

import (
	"time"

	"mndwd/internal/httpx"
)

const (
	DefaultExecTimeout                    = 30 * time.Second
	DefaultExecKillGrace                  = 2 * time.Second
	DefaultBackendBodyReadTimeout         = httpx.DefaultBodyReadTimeout
	DefaultServiceHTTPTimeout             = 30 * time.Second
	DefaultDaemonServiceStopTimeout       = 15 * time.Second
	DefaultStandaloneStopTimeout          = 10 * time.Second
	DefaultFinalReapTimeout               = 2 * time.Second
	DefaultMaxRequestBytes          int64 = 1 << 20
)
