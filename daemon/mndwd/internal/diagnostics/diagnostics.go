// Package diagnostics collects bounded, redacted runtime information for support reports.
package diagnostics

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"mndwd/internal/httpx"
)

const (
	defaultMaxLogBytes         int64 = 64 * 1024
	defaultMaxPluginBytes      int64 = 256 * 1024
	defaultMaxTotalPluginBytes int64 = 1024 * 1024
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

// Plugin identifies one service and its daemon-owned status/live callbacks.
type Plugin struct {
	ID         string
	Supervisor func() SupervisorDiagnostics
	Live       func(context.Context) ([]byte, error)
}

// SupervisorDiagnostics is daemon-owned state reconstructed on startup.
type SupervisorDiagnostics struct {
	State               string   `json:"state"`
	RestartCount        int      `json:"restartCount"`
	ConsecutiveFailures int      `json:"consecutiveFailures"`
	LastExit            string   `json:"lastExit,omitempty"`
	LastError           string   `json:"lastError,omitempty"`
	RecentStderr        []string `json:"recentStderr"`
}

// LiveDiagnostics is the optional, service-owned diagnostics snapshot. It is
// unavailable unless supervisor state is ready and a bounded callback succeeds.
type LiveDiagnostics struct {
	Status string         `json:"status"`
	Reason string         `json:"reason,omitempty"`
	Data   map[string]any `json:"data,omitempty"`
}

// Config controls diagnostics collection. LogFile is a read-only input.
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

// Response is the JSON contract returned by the diagnostics endpoints.
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

// PluginDiagnostics contains daemon supervisor state and optional live data.
type PluginDiagnostics struct {
	PluginID   string                `json:"pluginId"`
	Supervisor SupervisorDiagnostics `json:"supervisor"`
	Live       LiveDiagnostics       `json:"live"`
	Errors     []string              `json:"errors"`
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

// Register mounts protected diagnostics routes. Session protection is applied
// by the caller's /api/mndw/ middleware; this handler enforces CSRF.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/mndw/diagnostics", h.handle)
	mux.HandleFunc("POST /api/mndw/diagnostics/export", h.handle)
}

func (h *Handler) handle(w http.ResponseWriter, r *http.Request) {
	if !httpx.RequireCSRF(w, nil, r) {
		return
	}

	response := h.collect(r.Context())
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	httpx.WriteJSON(w, nil, http.StatusOK, response)
}

func (h *Handler) collect(ctx context.Context) Response {
	logTail, logError := readTail(h.config.LogFile, h.config.MaxLogBytes)
	plugins := make([]PluginDiagnostics, 0, len(h.config.Plugins))
	var totalBytes int64
	for _, plugin := range h.config.Plugins {
		result := PluginDiagnostics{
			PluginID: plugin.ID,
			Supervisor: SupervisorDiagnostics{
				State:        "stopped",
				RecentStderr: []string{},
			},
			Errors: []string{},
		}
		if plugin.Supervisor != nil {
			result.Supervisor = plugin.Supervisor()
			if result.Supervisor.RecentStderr == nil {
				result.Supervisor.RecentStderr = []string{}
			}
		}
		h.collectLive(ctx, plugin.Live, &result, &totalBytes)
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

func (h *Handler) collectLive(ctx context.Context, live func(context.Context) ([]byte, error), result *PluginDiagnostics, totalBytes *int64) {
	state := result.Supervisor.State
	if state == "" {
		state = "stopped"
		result.Supervisor.State = state
	}
	if state != "ready" {
		result.Live = LiveDiagnostics{Status: "unavailable", Reason: state}
		return
	}
	if live == nil {
		result.Live = LiveDiagnostics{Status: "unavailable", Reason: "live diagnostics are not configured"}
		return
	}
	if *totalBytes >= h.config.MaxTotalPluginBytes {
		result.Live = LiveDiagnostics{Status: "unavailable", Reason: "aggregate diagnostics byte limit reached"}
		return
	}

	data, err := live(ctx)
	if err != nil {
		result.Live = LiveDiagnostics{Status: "unavailable", Reason: boundedError("live diagnostics", err)}
		return
	}
	bytesRead := int64(len(data))
	remaining := h.config.MaxTotalPluginBytes - *totalBytes
	if bytesRead > h.config.MaxPluginBytes {
		*totalBytes += h.config.MaxPluginBytes
		result.Live = LiveDiagnostics{Status: "unavailable", Reason: "diagnostics response exceeds per-plugin byte limit"}
		return
	}
	if bytesRead > remaining {
		*totalBytes = h.config.MaxTotalPluginBytes
		result.Live = LiveDiagnostics{Status: "unavailable", Reason: "aggregate diagnostics byte limit exceeded"}
		return
	}
	*totalBytes += bytesRead

	dataMap, err := decodeLive(data)
	if err != nil {
		result.Live = LiveDiagnostics{Status: "unavailable", Reason: boundedError("decode live diagnostics", err)}
		return
	}
	result.Live = LiveDiagnostics{Status: "available", Data: sanitizeMap(dataMap)}
}

func decodeLive(data []byte) (map[string]any, error) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, fmt.Errorf("diagnostics response must be an object")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var object map[string]any
	if err := decoder.Decode(&object); err != nil {
		return nil, err
	}
	if err := rejectTrailingJSON(decoder); err != nil {
		return nil, err
	}
	if object == nil {
		return nil, fmt.Errorf("diagnostics response must be an object")
	}

	return object, nil
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
