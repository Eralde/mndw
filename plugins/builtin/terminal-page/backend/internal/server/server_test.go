package server

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"
)

func TestWaitForTCPWaitsForLateListener(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)

	defer cancel()

	attempts := 0
	dial := func(context.Context, string) (net.Conn, error) {
		attempts++

		if attempts < 3 {
			return nil, errors.New("listener is not ready")
		}

		connection, peer := net.Pipe()
		_ = peer.Close()

		return connection, nil
	}

	if err := waitForTCPWithDial(ctx, "127.0.0.1:7681", dial); err != nil {
		t.Fatalf("waitForTCP() error = %v", err)
	}

	if attempts != 3 {
		t.Fatalf("dial attempts = %d, want 3", attempts)
	}
}

func TestTtydDialOptionsRequestTTYProtocol(t *testing.T) {
	options := ttydDialOptions()

	if len(options.Subprotocols) != 1 || options.Subprotocols[0] != "tty" {
		t.Fatalf("ttyd subprotocols = %#v, want [tty]", options.Subprotocols)
	}
}

func TestTtydWebSocketURLUsesRootPath(t *testing.T) {
	if url := ttydWebSocketURL(); url != "ws://127.0.0.1:7681/" {
		t.Fatalf("ttyd websocket URL = %q, want root path", url)
	}
}
