package socket

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"time"
)

type Client struct {
	Path             string
	IOTimeout        time.Duration
	AuthTimeout      time.Duration
	MaxResponseBytes int64
}

func (c Client) Call(ctx context.Context, request Request) (Response, error) {
	if c.IOTimeout <= 0 {
		c.IOTimeout = 5 * time.Second
	}
	if c.AuthTimeout <= 0 {
		c.AuthTimeout = 15 * time.Second
	}
	connection, err := (&net.Dialer{Timeout: c.IOTimeout}).DialContext(ctx, "unix", c.Path)
	if err != nil {
		return Response{}, err
	}
	defer connection.Close()
	deadlineDuration := c.IOTimeout
	if request.Command == CommandCredentials {
		deadlineDuration = c.AuthTimeout
	}
	deadline := time.Now().Add(deadlineDuration)
	if err := connection.SetDeadline(deadline); err != nil {
		return Response{}, err
	}
	data, err := json.Marshal(request)
	if err != nil {
		return Response{}, err
	}
	data = append(data, '\n')
	if _, err := connection.Write(data); err != nil {
		return Response{}, err
	}
	limit := c.MaxResponseBytes
	if limit <= 0 {
		limit = 512 << 10
	}
	line, err := bufio.NewReader(io.LimitReader(connection, limit+1)).ReadBytes('\n')
	if err != nil {
		return Response{}, err
	}
	if int64(len(line)) > limit {
		return Response{}, fmt.Errorf("mwsd response exceeds size limit")
	}
	var response Response
	if err := json.Unmarshal(line, &response); err != nil {
		return Response{}, fmt.Errorf("invalid mwsd response")
	}
	return response, nil
}
