// Package frontend serves the SPA document root and approved user plugins.
package frontend

import (
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

var pluginNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

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
func (h *Handler) Register(mux *http.ServeMux, userPluginGate ...func(http.Handler) http.Handler) {
	userPluginHandler := http.Handler(http.HandlerFunc(h.serveUserPlugin))
	if len(userPluginGate) > 0 && userPluginGate[0] != nil {
		userPluginHandler = userPluginGate[0](userPluginHandler)
	}
	mux.Handle("/user-plugins/", userPluginHandler)
	mux.HandleFunc("/", h.serveStatic)
}

func (h *Handler) serveUserPlugin(writer http.ResponseWriter, request *http.Request) {
	if !isReadMethod(request.Method) {
		http.NotFound(writer, request)

		return
	}

	relative := strings.TrimPrefix(request.URL.Path, "/user-plugins/")
	segments := strings.Split(relative, "/")
	if len(segments) < 2 || !pluginNamePattern.MatchString(segments[0]) {
		http.NotFound(writer, request)

		return
	}

	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			http.NotFound(writer, request)

			return
		}
	}

	if segments[1] == "backend" {
		http.NotFound(writer, request)

		return
	}

	full, ok := safePluginJoin(h.userPluginsDir, segments[0], relative)

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
	if isBuiltinBackendPath(relative) {
		http.NotFound(writer, request)

		return
	}

	if relative == "" {
		h.serveIndex(writer, request)

		return
	}

	var full string
	var ok bool
	if pluginName, isPluginFile := builtinPluginPath(relative); isPluginFile {
		full, ok = safePluginJoin(h.frontendDir, filepath.Join("plugins", pluginName), relative)
	} else {
		full, ok = safeJoin(h.frontendDir, relative)
	}

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

func isBuiltinBackendPath(relative string) bool {
	cleaned := strings.TrimPrefix(path.Clean("/"+relative), "/")
	segments := strings.Split(cleaned, "/")

	return len(segments) >= 3 && segments[0] == "plugins" && segments[2] == "backend"
}

func builtinPluginPath(relative string) (string, bool) {
	cleaned := strings.TrimPrefix(path.Clean("/"+relative), "/")
	segments := strings.Split(cleaned, "/")
	if len(segments) < 3 || segments[0] != "plugins" || segments[1] == "" {
		return "", false
	}

	return segments[1], true
}

func safePluginJoin(root, pluginRootRelative, relative string) (string, bool) {
	full, ok := safeJoin(root, relative)
	if !ok {
		return "", false
	}

	pluginRoot, err := resolvePath(filepath.Join(root, filepath.FromSlash(pluginRootRelative)))
	if err != nil {
		return "", false
	}

	resolvedFull, err := resolvePath(full)
	if err != nil {
		return "", false
	}

	withinPlugin, err := filepath.Rel(pluginRoot, resolvedFull)
	if err != nil || withinPlugin == ".." || strings.HasPrefix(withinPlugin, ".."+string(filepath.Separator)) {
		return "", false
	}

	firstSegment := strings.SplitN(filepath.ToSlash(withinPlugin), "/", 2)[0]
	if firstSegment == "backend" {
		return "", false
	}

	return full, true
}

// resolvePath resolves symlinks in the existing part of a path and appends any
// remaining path segments. This lets missing static assets retain SPA fallback
// behavior while still recognizing a symlinked parent directory.
func resolvePath(full string) (string, error) {
	absolute, err := filepath.Abs(full)
	if err != nil {
		return "", err
	}

	current := absolute
	var missing []string
	for {
		resolved, resolveErr := filepath.EvalSymlinks(current)
		if resolveErr == nil {
			resolved, err = filepath.Abs(resolved)
			if err != nil {
				return "", err
			}

			for i := len(missing) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, missing[i])
			}

			return filepath.Clean(resolved), nil
		}

		if !os.IsNotExist(resolveErr) {
			return "", resolveErr
		}

		parent := filepath.Dir(current)
		if parent == current {
			return "", resolveErr
		}

		missing = append(missing, filepath.Base(current))
		current = parent
	}
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
