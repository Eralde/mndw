package events

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
)

type Publisher interface {
	Publish(Event)
}

func NewHookHandler(publisher Publisher, normalizer *Normalizer) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			writer.WriteHeader(http.StatusMethodNotAllowed)

			return
		}

		if !isLoopbackRemote(request.RemoteAddr) {
			writer.WriteHeader(http.StatusForbidden)

			return
		}

		body, err := io.ReadAll(io.LimitReader(request.Body, MaxEventPayloadBytes*4+1))
		if err != nil {
			writer.WriteHeader(http.StatusBadRequest)

			return
		}

		if len(body) > MaxEventPayloadBytes*4 {
			writer.WriteHeader(http.StatusRequestEntityTooLarge)

			return
		}

		var hook HookRequest
		decoder := json.NewDecoder(bytes.NewReader(body))

		decoder.DisallowUnknownFields()

		if err := decoder.Decode(&hook); err != nil {
			writer.WriteHeader(http.StatusBadRequest)

			return
		}

		var trailing any

		if err := decoder.Decode(&trailing); err != io.EOF {
			writer.WriteHeader(http.StatusBadRequest)

			return
		}

		event, err := normalizer.NormalizeHook(hook)
		if err != nil {
			status := http.StatusBadRequest

			if errors.Is(err, ErrPayloadTooLarge) {
				status = http.StatusRequestEntityTooLarge
			}

			http.Error(writer, http.StatusText(status), status)

			return
		}

		publisher.Publish(event)
		writer.WriteHeader(http.StatusNoContent)
	})
}

func isLoopbackRemote(remote string) bool {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}

	return host == "127.0.0.1" || host == "::1"
}
