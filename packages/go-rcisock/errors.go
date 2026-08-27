package rcisock

import "errors"

var ErrClosed = errors.New("rcisock: connection closed")

var (
	errNotHandshaken             = errors.New("rcisock: handshake required")
	errHandshakeAlreadyAttempted = errors.New("rcisock: handshake already attempted")
	errHandshakeRejected         = errors.New("rcisock: handshake rejected")
)

type RemoteError struct {
	Code string
}

func (e *RemoteError) Error() string {
	return e.Code
}
