package system

import (
	"context"
	"errors"
)

// Run waits for scheduled engine events until ctx is canceled.
func Run(ctx context.Context, engine *Engine, waitUntil func(context.Context, int64) error) error {
	if engine == nil {
		return errors.New("telemetry system: engine is required")
	}

	if waitUntil == nil {
		return errors.New("telemetry system: wait function is required")
	}

	for {
		if err := ctx.Err(); err != nil {
			_ = engine.Stop(context.WithoutCancel(ctx))

			return err
		}

		kind, bootMs := engine.Next()

		if err := waitUntil(ctx, bootMs); err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				_ = engine.Stop(context.WithoutCancel(ctx))

				return ctxErr
			}

			return err
		}

		if err := engine.Handle(ctx, kind); err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				_ = engine.Stop(context.WithoutCancel(ctx))

				return ctxErr
			}

			return err
		}
	}
}
