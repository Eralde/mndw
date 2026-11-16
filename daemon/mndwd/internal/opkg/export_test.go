package opkg

import "log/slog"

func New(mode string, logger *slog.Logger) SelfUpdateManager {
	if mode == "stub" {
		return NewStub(logger)
	}

	return NewExecWithPaths(logger, Paths{})
}
