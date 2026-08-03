package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"mws-map-page/internal/config"
	"mws-map-page/internal/socket"
)

func main() {
	if len(os.Args) < 2 || len(os.Args) > 3 {
		writeFailure(400, "BAD_REQUEST", "missing command")
		return
	}
	body, err := io.ReadAll(io.LimitReader(os.Stdin, (128<<10)+1))
	if err != nil {
		writeFailure(400, "BAD_REQUEST", "failed to read request")
		return
	}
	if len(body) > 128<<10 {
		writeFailure(413, "REQUEST_TOO_LARGE", "request exceeds size limit")
		return
	}
	request := socket.Request{Command: os.Args[1]}
	if len(os.Args) == 3 && request.Command == socket.CommandSnapshot {
		request.NodeID, err = url.QueryUnescape(os.Args[2])
		if err != nil {
			writeFailure(400, "BAD_REQUEST", "invalid node id")
			return
		}
	} else if len(os.Args) == 3 {
		writeFailure(400, "BAD_REQUEST", "unexpected argument")
		return
	}
	if request.Command == socket.CommandCredentials && len(body) > 0 {
		var credentials struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if err := json.Unmarshal(body, &credentials); err != nil {
			writeFailure(400, "BAD_REQUEST", "invalid credentials request")
			return
		}
		request.Username = credentials.Username
		request.Password = credentials.Password
	}
	runtimeDir := os.Getenv("MNDW_PLUGIN_RUNTIME_DIR")
	if runtimeDir == "" {
		runtimeDir = os.Getenv("MNDW_MWSD_RUNTIME_DIR")
	}
	if runtimeDir == "" {
		runtimeDir = os.Getenv("MWSD_RUNTIME_DIR")
	}
	if runtimeDir == "" {
		runtimeDir = config.Default().RuntimeDir
	}
	client := socket.Client{Path: filepath.Join(runtimeDir, config.Default().SocketName), IOTimeout: config.Default().IOTimeout, MaxResponseBytes: config.Default().MaxResponseBytes}
	client.AuthTimeout = config.Default().AuthOperation
	response, err := client.Call(context.Background(), request)
	if err != nil {
		startMwsd()
		response, err = client.Call(context.Background(), request)
		if err != nil {
			writeFailure(502, "BAD_GATEWAY", "mwsd unavailable")
			return
		}
	}
	data, _ := json.Marshal(response)
	fmt.Printf("Status: %d\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n\r\n%s\n", response.Status, data)
}

func startMwsd() {
	executable, err := os.Executable()
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, filepath.Join(filepath.Dir(executable), "start.sh"))
	_ = command.Run()
	for {
		if _, err := os.Stat(filepath.Join(runtimeDirectory(), config.Default().SocketName)); err == nil {
			return
		}
		if ctx.Err() != nil {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func runtimeDirectory() string {
	if value := os.Getenv("MNDW_PLUGIN_RUNTIME_DIR"); value != "" {
		return value
	}
	if value := os.Getenv("MNDW_MWSD_RUNTIME_DIR"); value != "" {
		return value
	}
	if value := os.Getenv("MWSD_RUNTIME_DIR"); value != "" {
		return value
	}
	return config.Default().RuntimeDir
}

func writeFailure(status int, code, message string) {
	data, _ := json.Marshal(socket.Failure(status, code, message))
	fmt.Printf("Status: %d\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n\r\n%s\n", status, data)
}
