package events

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

const (
	ReplayDefaultLimit     = 100
	ReplayMaxLimit         = 500
	WebSocketWriteTimeout  = 5 * time.Second
	WebSocketReadLimit     = 64 * 1024
	webSocketErrorCode     = "INVALID_MESSAGE"
	webSocketCursorExpired = "CURSOR_EXPIRED"
)

type clientMessage struct {
	Type   string    `json:"type"`
	Topics *[]string `json:"topics"`
	After  string    `json:"after"`
	Limit  int       `json:"limit"`
}

type eventMessage struct {
	Type  string `json:"type"`
	Event Event  `json:"event"`
}

type replayMessage struct {
	Type    string  `json:"type"`
	Events  []Event `json:"events"`
	HasMore bool    `json:"hasMore"`
}

type errorMessage struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type replaySnapshot struct {
	events       []Event
	lastReturned string
}

// NewWebSocketHandler serves the daemon-owned event stream. Authentication is
// applied by the route owner; originCheck runs before the protocol upgrade.
func NewWebSocketHandler(bus *Bus, originCheck func(*http.Request) bool) http.Handler {
	if bus == nil {
		panic("events: nil bus")
	}

	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			writer.Header().Set("Allow", http.MethodGet)
			http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)

			return
		}

		if originCheck != nil && !originCheck(request) {
			http.Error(writer, "forbidden websocket origin", http.StatusForbidden)

			return
		}

		connection, err := websocket.Accept(writer, request, &websocket.AcceptOptions{})
		if err != nil {
			return
		}

		defer connection.Close(websocket.StatusNormalClosure, "")

		connection.SetReadLimit(WebSocketReadLimit)
		serveWebSocket(request.Context(), connection, bus)
	})
}

func serveWebSocket(parent context.Context, connection *websocket.Conn, bus *Bus) {
	messages := make(chan []byte, 8)
	readErrors := make(chan error, 1)

	go func() {
		for {
			_, message, err := connection.Read(parent)
			if err != nil {
				readErrors <- err

				return
			}

			select {
			case messages <- message:
			case <-parent.Done():
				return
			}
		}
	}()

	var (
		filter       TopicFilter
		liveEvents   <-chan Event
		cancelLive   CancelFunc
		snapshot     *replaySnapshot
		connectionOK = true
	)

	defer func() {
		if cancelLive != nil {
			cancelLive()
		}
	}()

	for connectionOK {
		select {
		case err := <-readErrors:
			if err != nil && !errors.Is(err, context.Canceled) {
				return
			}

			return
		case event, ok := <-liveEvents:
			if !ok {
				return
			}

			connectionOK = writeWebSocketMessage(connection, eventMessage{Type: "event", Event: event})
		case message := <-messages:
			var incoming clientMessage

			if err := json.Unmarshal(message, &incoming); err != nil {
				connectionOK = writeWebSocketError(connection, webSocketErrorCode, "message must be valid JSON")

				continue
			}

			connectionOK = handleClientMessage(connection, bus, incoming, &filter, &liveEvents, &cancelLive, &snapshot)
		}
	}
}

func handleClientMessage(connection *websocket.Conn, bus *Bus, incoming clientMessage, filter *TopicFilter, liveEvents *<-chan Event, cancelLive *CancelFunc, snapshot **replaySnapshot) bool {
	switch incoming.Type {
	case "subscribe":
		if incoming.Topics == nil {
			return writeWebSocketError(connection, webSocketErrorCode, "missing 'topics' field in subscribe")
		}

		parsed, err := ParseTopicFilter(*incoming.Topics)
		if err != nil {
			return writeWebSocketError(connection, webSocketErrorCode, err.Error())
		}

		var nextEvents <-chan Event
		var nextCancel CancelFunc

		if !parsed.Empty() {
			nextEvents, nextCancel, err = bus.Subscribe(parsed)
			if err != nil {
				return writeWebSocketError(connection, webSocketErrorCode, err.Error())
			}
		}

		if *cancelLive != nil {
			(*cancelLive)()
		}

		*cancelLive = nextCancel
		*liveEvents = nextEvents
		*filter = parsed
		*snapshot = nil

		return true
	case "unsubscribe":
		if *cancelLive != nil {
			(*cancelLive)()
		}

		*cancelLive = nil
		*liveEvents = nil
		*filter = TopicFilter{}
		*snapshot = nil

		return true
	case "replay":
		return handleReplay(connection, bus, incoming, *filter, snapshot)
	default:
		return writeWebSocketError(connection, webSocketErrorCode, fmt.Sprintf("unsupported message type %q", incoming.Type))
	}
}

func handleReplay(connection *websocket.Conn, bus *Bus, incoming clientMessage, filter TopicFilter, snapshot **replaySnapshot) bool {
	if incoming.Limit < 0 {
		return writeWebSocketError(connection, webSocketErrorCode, "replay limit must not be negative")
	}

	limit := incoming.Limit

	if limit == 0 {
		limit = ReplayDefaultLimit
	}

	if limit > ReplayMaxLimit {
		limit = ReplayMaxLimit
	}

	var events []Event

	if *snapshot != nil && incoming.After == (*snapshot).lastReturned {
		events = eventsAfterCursor((*snapshot).events, incoming.After)
	} else {
		var err error
		events, err = bus.Snapshot(incoming.After, filter)
		if err != nil {
			if errors.Is(err, ErrCursorExpired) {
				return writeWebSocketError(connection, webSocketCursorExpired, "replay cursor is no longer retained")
			}

			return writeWebSocketError(connection, webSocketErrorCode, err.Error())
		}

		*snapshot = &replaySnapshot{events: events}
	}

	if len(events) == 0 {
		*snapshot = nil

		return writeWebSocketMessage(connection, replayMessage{Type: "replay", Events: []Event{}, HasMore: false})
	}

	if len(events) > limit {
		batch := append([]Event(nil), events[:limit]...)
		(*snapshot).lastReturned = batch[len(batch)-1].ID

		return writeWebSocketMessage(connection, replayMessage{Type: "replay", Events: batch, HasMore: true})
	}

	batch := append([]Event(nil), events...)
	*snapshot = nil

	return writeWebSocketMessage(connection, replayMessage{Type: "replay", Events: batch, HasMore: false})
}

func eventsAfterCursor(events []Event, after string) []Event {
	for index, event := range events {
		if event.ID == after {
			return events[index+1:]
		}
	}

	return nil
}

func writeWebSocketError(connection *websocket.Conn, code, message string) bool {
	return writeWebSocketMessage(connection, errorMessage{Type: "error", Code: code, Message: message})
}

func writeWebSocketMessage(connection *websocket.Conn, message any) bool {
	payload, err := json.Marshal(message)
	if err != nil {
		return false
	}

	ctx, cancel := context.WithTimeout(context.Background(), WebSocketWriteTimeout)

	defer cancel()

	if err := connection.Write(ctx, websocket.MessageText, payload); err != nil {
		_ = connection.Close(websocket.StatusPolicyViolation, "event stream write failed")

		return false
	}

	return true
}
