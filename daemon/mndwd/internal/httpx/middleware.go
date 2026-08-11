package httpx

import (
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// statusRecorder captures the status code an inner handler writes so the log line
// can report it. Defaults to 200 (net/http's implicit status when WriteHeader is
// never called).
type statusRecorder struct {
	http.ResponseWriter
	status int
}

type noCORSWriter struct {
	http.ResponseWriter
	wroteHeader bool
}

func (w *noCORSWriter) WriteHeader(status int) {
	for key := range w.Header() {
		if strings.HasPrefix(strings.ToLower(key), "access-control-") {
			delete(w.Header(), key)
		}
	}
	w.wroteHeader = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *noCORSWriter) Write(data []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(data)
}

func (w *noCORSWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// NoCORSHandler is the daemon-wide response boundary. Backend-specific wrappers
// apply the same policy before proxy headers are copied; this catches management,
// auth, palette, and diagnostics responses too.
func NoCORSHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		next.ServeHTTP(&noCORSWriter{ResponseWriter: writer}, request)
	})
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

// Unwrap exposes the underlying ResponseWriter so http.ResponseController (and thus
// the http.Hijacker the WebSocket gateway needs to upgrade a connection) can reach through the
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
// `method path status duration`. Body contents are never logged.
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

// PluginNoStoreMiddleware is registered outside backend routing, so even
// unauthenticated route-gate errors cannot reveal whether a sensitive endpoint
// exists through caching or referrer propagation.
func PluginNoStoreMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}
