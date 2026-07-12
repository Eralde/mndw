package httpx

import (
	"log/slog"
	"net/http"
	"time"
)

// statusRecorder captures the status code an inner handler writes so the log line
// can report it. Defaults to 200 (net/http's implicit status when WriteHeader is
// never called).
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

// Unwrap exposes the underlying ResponseWriter so http.ResponseController (and thus
// the http.Hijacker the WS proxy needs to upgrade a connection) can reach through the
// wrapper. Without this, websocket.Accept on a logged route fails.
func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

// Write records an implicit 200 the first time a body is written without an explicit
// WriteHeader, so the log line matches what the client sees.
func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}

	return r.ResponseWriter.Write(b)
}

// LogMiddleware emits exactly one request line per API call at info level:
// `method path status duration`. Body contents are never logged (§5.6).
func LogMiddleware(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}

		next.ServeHTTP(rec, r)

		if rec.status == 0 {
			rec.status = http.StatusOK
		}

		logger.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration", time.Since(start).String(),
		)
	})
}
