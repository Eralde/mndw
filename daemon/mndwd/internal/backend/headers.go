package backend

import (
	"net/http"
	"strings"
)

type noCORSResponseWriter struct {
	http.ResponseWriter
	wroteHeader bool
}

func NewNoCORSResponseWriter(writer http.ResponseWriter) http.ResponseWriter {
	return &noCORSResponseWriter{ResponseWriter: writer}
}

func (w *noCORSResponseWriter) WriteHeader(status int) {
	stripCORSHeaders(w.Header())
	w.wroteHeader = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *noCORSResponseWriter) Write(data []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}

	return w.ResponseWriter.Write(data)
}

func (w *noCORSResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func stripCORSHeaders(headers http.Header) {
	for key := range headers {
		if strings.HasPrefix(strings.ToLower(key), "access-control-") {
			delete(headers, key)
		}
	}
}
