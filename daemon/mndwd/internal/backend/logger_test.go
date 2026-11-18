package backend

import "log/slog"

func backendTestLogger() *slog.Logger {
	return slog.New(slog.DiscardHandler)
}
