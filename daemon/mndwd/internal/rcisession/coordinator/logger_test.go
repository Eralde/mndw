package coordinator

import "log/slog"

func coordinatorTestLogger() *slog.Logger {
	return slog.New(slog.DiscardHandler)
}
