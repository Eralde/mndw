// Package diagnostics collects bounded, redacted runtime information for support reports.
package diagnostics

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"mndwd/internal/httpx"
)

const (
	defaultMaxLogBytes         int64 = 64 * 1024
	defaultMaxPluginBytes      int64 = 256 * 1024
	defaultMaxTotalPluginBytes int64 = 1024 * 1024
	diagnosticsFilename              = "diagnostics.json"
)

var sensitiveValuePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(["']?(?:password|passwd|token|secret|authorization|cookie|x-ndma-tkn)["']?\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s}\]]+)`),
	regexp.MustCompile(`(?i)(\b(?:password|passwd|token|secret|authorization|cookie|x-ndma-tkn)\s*[=:]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)`),
}

var sensitiveKeys = map[string]struct{}{
	"password":      {},
	"passwd":        {},
	"token":         {},
	"secret":        {},
	"authorization": {},
	"cookie":        {},
	"x-ndma-tkn":    {},
}

// Plugin identifies one daemon-owned plugin runtime directory.
type Plugin struct {
	ID         string
	RuntimeDir string
}

// Config controls diagnostics collection. Paths are read-only inputs; diagnostics
// never uses LogFile as a logging destination.
type Config struct {
	LogFile             string
	Plugins             []Plugin
	MaxLogBytes         int64
	MaxPluginBytes      int64
	MaxTotalPluginBytes int64
}

// Handler serves bounded diagnostics data.
type Handler struct {
	config Config
}

// Response is the JSON contract returned by GET /api/mndw/diagnostics.
type Response struct {
	GeneratedAt time.Time           `json:"generatedAt"`
	Mndwd       MndwdDiagnostics    `json:"mndwd"`
	Plugins     []PluginDiagnostics `json:"plugins"`
}

// MndwdDiagnostics contains the daemon log tail and its source status.
type MndwdDiagnostics struct {
	LogPath  string `json:"logPath"`
	LogTail  string `json:"logTail"`
	LogError string `json:"logError"`
}

// PluginDiagnostics contains one plugin's published diagnostics result.
type PluginDiagnostics struct {
	PluginID        string         `json:"pluginId"`
	RuntimeDir      string         `json:"runtimeDir"`
	DiagnosticsPath string         `json:"diagnosticsPath"`
	FilePresent     bool           `json:"filePresent"`
	FileModifiedAt  *time.Time     `json:"fileModifiedAt,omitempty"`
	GeneratedAt     *time.Time     `json:"generatedAt,omitempty"`
	Data            map[string]any `json:"data,omitempty"`
	Errors          []string       `json:"errors"`
}

// New constructs a diagnostics handler with safe read limits.
func New(config Config) *Handler {
	if config.MaxLogBytes <= 0 {
		config.MaxLogBytes = defaultMaxLogBytes
	}
	if config.MaxPluginBytes <= 0 {
		config.MaxPluginBytes = defaultMaxPluginBytes
	}
	if config.MaxTotalPluginBytes <= 0 {
		config.MaxTotalPluginBytes = defaultMaxTotalPluginBytes
	}

	return &Handler{config: config}
}

// Register mounts the protected diagnostics route onto mux. Session protection is
// applied by the caller's /api/mndw/ middleware, while this handler enforces CSRF.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/mndw/diagnostics", h.handle)
}

func (h *Handler) handle(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Mndw-Csrf") != "1" {
		httpx.WriteError(w, nil, httpx.NewError(http.StatusForbidden, httpx.CodeCsrfRequired, "CSRF header required"))
		return
	}

	response := h.collect()
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	httpx.WriteJSON(w, nil, http.StatusOK, response)
}

func (h *Handler) collect() Response {
	logTail, logError := readTail(h.config.LogFile, h.config.MaxLogBytes)
	plugins := make([]PluginDiagnostics, 0, len(h.config.Plugins))
	var totalBytes int64
	for _, plugin := range h.config.Plugins {
		result := PluginDiagnostics{
			PluginID:   plugin.ID,
			RuntimeDir: plugin.RuntimeDir,
			Errors:     []string{},
		}
		if plugin.RuntimeDir == "" {
			result.Errors = append(result.Errors, "plugin runtime directory is empty")
			plugins = append(plugins, result)
			continue
		}
		result.DiagnosticsPath = filepath.Join(plugin.RuntimeDir, diagnosticsFilename)
		h.collectPlugin(&result, &totalBytes)
		plugins = append(plugins, result)
	}

	return Response{
		GeneratedAt: time.Now().UTC(),
		Mndwd: MndwdDiagnostics{
			LogPath:  h.config.LogFile,
			LogTail:  redact(logTail),
			LogError: logError,
		},
		Plugins: plugins,
	}
}

func (h *Handler) collectPlugin(result *PluginDiagnostics, totalBytes *int64) {
	if *totalBytes >= h.config.MaxTotalPluginBytes {
		result.Errors = append(result.Errors, "aggregate diagnostics byte limit reached")
		return
	}

	file, err := os.OpenFile(result.DiagnosticsPath, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		result.Errors = append(result.Errors, boundedError("open diagnostics", err))
		return
	}
	defer file.Close()
	result.FilePresent = true

	info, err := file.Stat()
	if err != nil {
		result.Errors = append(result.Errors, boundedError("stat diagnostics", err))
		return
	}
	modifiedAt := info.ModTime().UTC()
	result.FileModifiedAt = &modifiedAt
	if !info.Mode().IsRegular() {
		result.Errors = append(result.Errors, "diagnostics file is not regular")
		return
	}

	remaining := h.config.MaxTotalPluginBytes - *totalBytes
	readLimit := h.config.MaxPluginBytes + 1
	if remaining+1 < readLimit {
		readLimit = remaining + 1
	}
	data, readErr := io.ReadAll(io.LimitReader(file, readLimit))
	readBytes := int64(len(data))
	if readErr != nil {
		*totalBytes += minInt64(readBytes, remaining)
		result.Errors = append(result.Errors, boundedError("read diagnostics", readErr))
		return
	}
	if readBytes > remaining {
		*totalBytes = h.config.MaxTotalPluginBytes
		result.Errors = append(result.Errors, "aggregate diagnostics byte limit exceeded")
		return
	}
	if readBytes > h.config.MaxPluginBytes {
		*totalBytes += h.config.MaxPluginBytes
		result.Errors = append(result.Errors, "diagnostics file truncated at per-plugin byte limit")
		return
	}
	*totalBytes += readBytes

	envelope, err := decodeEnvelope(data)
	if err != nil {
		result.Errors = append(result.Errors, boundedError("decode diagnostics", err))
		return
	}
	generatedAt := envelope.GeneratedAt.UTC()
	result.GeneratedAt = &generatedAt
	result.Data = sanitizeMap(envelope.Data)
}

type diagnosticsEnvelope struct {
	SchemaVersion int
	GeneratedAt   time.Time
	Data          map[string]any
}

func decodeEnvelope(data []byte) (diagnosticsEnvelope, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var raw struct {
		SchemaVersion int             `json:"schemaVersion"`
		GeneratedAt   string          `json:"generatedAt"`
		Data          json.RawMessage `json:"data"`
	}
	if err := decoder.Decode(&raw); err != nil {
		return diagnosticsEnvelope{}, err
	}
	if err := rejectTrailingJSON(decoder); err != nil {
		return diagnosticsEnvelope{}, err
	}
	if raw.SchemaVersion != 1 {
		return diagnosticsEnvelope{}, fmt.Errorf("unsupported schema version %d", raw.SchemaVersion)
	}
	if raw.GeneratedAt == "" {
		return diagnosticsEnvelope{}, fmt.Errorf("generatedAt is required")
	}
	generatedAt, err := time.Parse(time.RFC3339, raw.GeneratedAt)
	if err != nil {
		return diagnosticsEnvelope{}, fmt.Errorf("invalid generatedAt: %w", err)
	}
	if len(bytes.TrimSpace(raw.Data)) == 0 || bytes.TrimSpace(raw.Data)[0] != '{' {
		return diagnosticsEnvelope{}, fmt.Errorf("data must be an object")
	}
	dataDecoder := json.NewDecoder(bytes.NewReader(raw.Data))
	dataDecoder.UseNumber()
	var object map[string]any
	if err := dataDecoder.Decode(&object); err != nil {
		return diagnosticsEnvelope{}, fmt.Errorf("decode data: %w", err)
	}
	if err := rejectTrailingJSON(dataDecoder); err != nil {
		return diagnosticsEnvelope{}, fmt.Errorf("data has trailing JSON: %w", err)
	}
	if object == nil {
		return diagnosticsEnvelope{}, fmt.Errorf("data must be an object")
	}
	return diagnosticsEnvelope{SchemaVersion: raw.SchemaVersion, GeneratedAt: generatedAt.UTC(), Data: object}, nil
}

func rejectTrailingJSON(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if err == io.EOF {
		return nil
	}
	if err == nil {
		return fmt.Errorf("trailing JSON data")
	}
	return err
}

func sanitizeMap(value map[string]any) map[string]any {
	result := make(map[string]any, len(value))
	for key, item := range value {
		if isSensitiveKey(key) {
			result[key] = "[REDACTED]"
			continue
		}
		result[key] = sanitizeValue(item)
	}
	return result
}

func sanitizeValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return sanitizeMap(typed)
	case []any:
		result := make([]any, len(typed))
		for index, item := range typed {
			result[index] = sanitizeValue(item)
		}
		return result
	case string:
		return redact(typed)
	default:
		return value
	}
}

func isSensitiveKey(key string) bool {
	_, ok := sensitiveKeys[strings.ToLower(key)]
	return ok
}

func minInt64(left, right int64) int64 {
	if left < right {
		return left
	}
	return right
}

func readTail(path string, maxBytes int64) (string, string) {
	file, err := os.Open(path)
	if err != nil {
		return "", boundedError("read log", err)
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return "", boundedError("stat log", err)
	}
	offset := info.Size() - maxBytes
	if offset < 0 {
		offset = 0
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return "", boundedError("seek log", err)
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBytes))
	if err != nil {
		return "", boundedError("read log", err)
	}

	return string(data), ""
}

func boundedError(operation string, err error) string {
	message := fmt.Sprintf("%s: %v", operation, err)
	if len(message) > 1024 {
		return message[:1024]
	}
	return message
}

func redact(value string) string {
	redacted := value
	for _, pattern := range sensitiveValuePatterns {
		redacted = pattern.ReplaceAllString(redacted, `${1}[REDACTED]`)
	}
	return redacted
}
