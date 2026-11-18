package events

import "log/slog"

func eventsTestLogger() *slog.Logger {
	return slog.New(slog.DiscardHandler)
}
