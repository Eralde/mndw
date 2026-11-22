package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/coder/websocket"
	"iperf-widget/internal/session"
	"mndw.local/httpsocket"
)

type Server struct {
	manager *session.Manager
	socket  string
	rootCtx context.Context
}

type readResult struct {
	message clientMessage
	err     error
}

func sendReadResult(ctx context.Context, reads chan<- readResult, result readResult) bool {
	select {
	case reads <- result:
		return true
	case <-ctx.Done():
		return false
	}
}

func New(manager *session.Manager) (*Server, error) {
	socket := os.Getenv("MNDW_BACKEND_SOCKET")

	if socket == "" {
		return nil, fmt.Errorf("MNDW_BACKEND_SOCKET is required")
	}

	if manager == nil {
		return nil, fmt.Errorf("session manager is required")
	}

	return &Server{manager: manager, socket: socket, rootCtx: context.Background()}, nil
}

func (server *Server) Run(ctx context.Context) error {
	server.rootCtx = ctx

	serveErr := httpsocket.Serve(ctx, server.socket, server.handler())
	waitContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)

	defer cancel()

	waitErr := server.manager.Wait(waitContext)

	if waitErr != nil {
		waitErr = fmt.Errorf("wait for active speed test: %w", waitErr)
	}

	return errors.Join(serveErr, waitErr)
}

func (server *Server) handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /_mndw/ready", server.ready)
	mux.HandleFunc("GET /test", server.test)

	return mux
}

func (server *Server) ready(writer http.ResponseWriter, _ *http.Request) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(http.StatusOK)

	_ = json.NewEncoder(writer).Encode(map[string]any{
		"pluginId":        os.Getenv("MNDW_PLUGIN_ID"),
		"protocolVersion": 1,
	})
}

func (server *Server) test(writer http.ResponseWriter, request *http.Request) {
	connection, err := websocket.Accept(writer, request, nil)
	if err != nil {
		return
	}

	defer connection.CloseNow()

	connection.SetReadLimit(64 << 10)

	connectionContext, cancelConnection := context.WithCancel(request.Context())

	defer cancelConnection()

	stopRootWatch := context.AfterFunc(server.rootCtx, cancelConnection)

	defer stopRootWatch()

	reads := make(chan readResult, 1)

	go func() {
		for {
			kind, data, readErr := connection.Read(connectionContext)

			if readErr != nil {
				if !sendReadResult(connectionContext, reads, readResult{err: readErr}) {
					return
				}

				return
			}

			if kind != websocket.MessageText {
				if !sendReadResult(connectionContext, reads, readResult{err: fmt.Errorf("client message must be text")}) {
					return
				}

				return
			}

			var message clientMessage

			if decodeErr := json.Unmarshal(data, &message); decodeErr != nil {
				if !sendReadResult(connectionContext, reads, readResult{err: decodeErr}) {
					return
				}

				continue
			}

			if !sendReadResult(connectionContext, reads, readResult{message: message}) {
				return
			}
		}
	}()

	var writeMu sync.Mutex
	write := func(message session.Message) {
		writeMu.Lock()

		defer writeMu.Unlock()

		writeContext, cancel := context.WithTimeout(context.Background(), 2*time.Second)

		defer cancel()

		data, marshalErr := json.Marshal(message)

		if marshalErr != nil {
			return
		}

		_ = connection.Write(writeContext, websocket.MessageText, data)
	}

	var runCancel context.CancelFunc
	var runDone <-chan struct{}

	for {
		select {
		case <-connectionContext.Done():
			if runCancel != nil {
				runCancel()
			}

			return
		case <-runDone:
			runCancel()

			runCancel = nil
			runDone = nil
		case result := <-reads:
			if result.err != nil {
				if connectionContext.Err() == nil {
					write(session.Message{Type: "error", Code: "invalid-input", Message: "Invalid client message"})
				}

				return
			}

			switch result.message.Type {
			case "start":
				if runDone != nil {
					select {
					case <-runDone:
						runCancel()

						runCancel = nil
						runDone = nil
					default:
					}
				}

				if runCancel != nil {
					write(session.MessageForError(session.ErrBusy))

					continue
				}

				runContext, cancel := context.WithCancel(connectionContext)
				done := make(chan struct{}, 1)
				runCancel = cancel
				runDone = done

				go func(input session.Request) {
					if runErr := server.manager.Run(runContext, input, func(value any) {
						if message, ok := value.(session.Message); ok {
							write(message)
						}
					}); runErr != nil {
						write(session.MessageForError(runErr))
					}

					done <- struct{}{}
				}(result.message.request())
			case "stop":
				if runCancel != nil {
					runCancel()
				}
			default:
				write(session.MessageForError(session.ErrInvalidInput))
			}
		}
	}
}

type clientMessage struct {
	Type     string `json:"type"`
	Host     string `json:"host"`
	PortFrom int    `json:"portFrom"`
	PortTo   int    `json:"portTo"`
	Duration int    `json:"duration"`
	Streams  int    `json:"streams"`
}

func (message clientMessage) request() session.Request {
	return session.Request{
		Host:     message.Host,
		PortFrom: message.PortFrom,
		PortTo:   message.PortTo,
		Duration: message.Duration,
		Streams:  message.Streams,
	}
}
