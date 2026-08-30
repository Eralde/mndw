// Package frontend serves the SPA document root and approved user plugins.
package frontend

import (
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Handler serves static assets and the SPA fallback.
type Handler struct {
	frontendDir    string
	userPluginsDir string
}

// New validates the document root and builds a frontend handler.
func New(frontendDir, userPluginsDir string) (*Handler, error) {
	if strings.TrimSpace(frontendDir) == "" {
		return nil, fmt.Errorf("frontend dir is required in front-door mode")
	}

	info, err := os.Stat(frontendDir)
	if err != nil {
		return nil, fmt.Errorf("frontend dir %q: %w", frontendDir, err)
	}

	if !info.IsDir() {
		return nil, fmt.Errorf("frontend dir %q is not a directory", frontendDir)
	}

	return &Handler{frontendDir: frontendDir, userPluginsDir: userPluginsDir}, nil
}

// Register mounts the user-plugin alias and the SPA catch-all. More specific
// API, WebSocket, and HTTP-router patterns must be registered by the caller first.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/user-plugins/", h.serveUserPlugin)
	mux.HandleFunc("/", h.serveStatic)
}

func (h *Handler) serveUserPlugin(writer http.ResponseWriter, request *http.Request) {
	if !isReadMethod(request.Method) {
		http.NotFound(writer, request)

		return
	}

	relative := strings.TrimPrefix(request.URL.Path, "/user-plugins/")
	full, ok := safeJoin(h.userPluginsDir, relative)

	if !ok {
		http.NotFound(writer, request)

		return
	}

	h.serveFile(writer, request, full)
}

func (h *Handler) serveStatic(writer http.ResponseWriter, request *http.Request) {
	if !isReadMethod(request.Method) {
		http.NotFound(writer, request)

		return
	}

	relative := strings.TrimPrefix(request.URL.Path, "/")

	if relative == "" {
		h.serveIndex(writer, request)

		return
	}

	full, ok := safeJoin(h.frontendDir, relative)

	if !ok {
		http.NotFound(writer, request)

		return
	}

	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		h.serveIndex(writer, request)

		return
	}

	if !info.Mode().IsRegular() {
		http.NotFound(writer, request)

		return
	}

	h.serveFile(writer, request, full)
}

func (h *Handler) serveFile(writer http.ResponseWriter, request *http.Request, full string) {
	file, err := os.Open(full)
	if err != nil {
		http.NotFound(writer, request)

		return
	}

	defer file.Close()

	info, err := file.Stat()
	if err != nil || info.IsDir() || !info.Mode().IsRegular() {
		http.NotFound(writer, request)

		return
	}

	writer.Header().Set("ETag", etagFor(info))
	http.ServeContent(writer, request, filepath.Base(full), info.ModTime(), file)
}

func (h *Handler) serveIndex(writer http.ResponseWriter, request *http.Request) {
	full, ok := safeJoin(h.frontendDir, "index.html")

	if !ok {
		http.NotFound(writer, request)

		return
	}

	writer.Header().Set("Cache-Control", "no-store")
	h.serveFile(writer, request, full)
}

func etagFor(info os.FileInfo) string {
	return fmt.Sprintf("\"%x-%x\"", info.ModTime().UnixNano(), info.Size())
}

func isReadMethod(method string) bool {
	return method == http.MethodGet || method == http.MethodHead
}

// TraversalGuard rejects requests with a literal .. path segment before
// ServeMux can canonicalize them into a redirect.
func TraversalGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		for _, segment := range strings.Split(request.URL.Path, "/") {
			if segment == ".." {
				http.NotFound(writer, request)

				return
			}
		}

		next.ServeHTTP(writer, request)
	})
}

func safeJoin(root, relative string) (string, bool) {
	for _, segment := range strings.Split(relative, "/") {
		if segment == ".." {
			return "", false
		}
	}

	cleaned := path.Clean("/" + relative)
	full := filepath.Join(root, filepath.FromSlash(cleaned))

	rootReal, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", false
	}

	rootReal, err = filepath.Abs(rootReal)
	if err != nil {
		return "", false
	}

	fullReal, err := filepath.EvalSymlinks(full)
	if err == nil {
		fullReal, err = filepath.Abs(fullReal)
		if err != nil {
			return "", false
		}

		return fullReal, withinRoot(rootReal, fullReal)
	}

	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", false
	}

	fullAbs, err := filepath.Abs(full)
	if err != nil {
		return "", false
	}

	relativePath, err := filepath.Rel(rootAbs, fullAbs)
	if err != nil {
		return "", false
	}

	return full, withinRoot(rootReal, filepath.Join(rootReal, relativePath))
}

func withinRoot(root, candidate string) bool {
	if candidate == root {
		return true
	}

	relative, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}

	return relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
