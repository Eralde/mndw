package socket

import "log/slog"

func socketTestLogger() *slog.Logger {
	return slog.New(slog.DiscardHandler)
}
