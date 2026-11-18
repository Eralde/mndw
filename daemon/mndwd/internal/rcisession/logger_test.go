package rcisession

import "log/slog"

func serviceTestLogger() *slog.Logger {
	return slog.New(slog.DiscardHandler)
}
