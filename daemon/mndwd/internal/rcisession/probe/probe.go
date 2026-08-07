// Package probe detects whether a controller's firmware supports RCI token
// authentication, distinguishing unsupported firmware from an unknown result.
package probe

import (
	"context"
	"errors"
	"fmt"

	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/model"
)

var (
	ErrUnsupported = errors.New("token authentication unsupported")
	ErrUnknown     = errors.New("token authentication unknown")
)

type Request func(context.Context, enumeration.Member, model.TokenRecord) (int, error)

type Checker struct {
	Request Request
}

func (c Checker) Check(ctx context.Context, member enumeration.Member, record model.TokenRecord) (model.Support, error) {
	if c.Request == nil {
		return model.SupportUnknown, ErrUnknown
	}
	status, err := c.Request(ctx, member, record)
	if err != nil {
		return model.SupportUnknown, ErrUnknown
	}
	switch {
	case status >= 200 && status < 300:
		return model.SupportSupported, nil
	case status == 401 || status == 403 || status == 404 || status == 405 || status == 501:
		return model.SupportUnsupported, ErrUnsupported
	default:
		return model.SupportUnknown, fmt.Errorf("%w: status %d", ErrUnknown, status)
	}
}
