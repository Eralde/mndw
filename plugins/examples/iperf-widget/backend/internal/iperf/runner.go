package iperf

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os/exec"
	"strings"
	"time"
)

const defaultBinary = "/opt/bin/iperf3"

var (
	ErrBusy        = errors.New("iperf3 server is busy")
	ErrUnreachable = errors.New("iperf3 server is unreachable")
	ErrMissing     = errors.New("iperf3 binary is missing")
)

type Options struct {
	Binary   string
	Host     string
	Port     int
	Duration int
	Streams  int
	Reverse  bool
}

func Args(options Options) []string {
	args := []string{
		"-c", options.Host,
		"-p", fmt.Sprint(options.Port),
		"-t", fmt.Sprint(options.Duration),
		"-P", fmt.Sprint(options.Streams),
		"--json-stream",
	}

	if options.Reverse {
		args = append(args, "-R")
	}

	return args
}

func Run(ctx context.Context, options Options, emit func(Event)) error {
	binary := options.Binary

	if binary == "" {
		binary = defaultBinary
	}

	command := exec.CommandContext(ctx, binary, Args(options)...)
	command.Cancel = func() error {
		if command.Process == nil {
			return nil
		}

		return command.Process.Kill()
	}
	command.WaitDelay = time.Second

	output, err := command.StdoutPipe()
	if err != nil {
		return fmt.Errorf("open iperf3 stdout: %w", err)
	}

	var stderr bytes.Buffer
	command.Stderr = &stderr

	if err := command.Start(); err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, exec.ErrNotFound) {
			return fmt.Errorf("%w: %s", ErrMissing, binary)
		}

		return fmt.Errorf("start iperf3: %w", err)
	}

	scanner := bufio.NewScanner(output)

	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)

	var streamErr error

	for scanner.Scan() {
		event, ok, parseErr := ParseLine(scanner.Bytes())

		if parseErr != nil {
			streamErr = parseErr

			break
		}

		if !ok {
			continue
		}

		emit(event)

		if event.Kind == EventError {
			switch {
			case strings.Contains(strings.ToLower(event.ErrorText), "server is busy"):
				streamErr = ErrBusy
			case strings.Contains(strings.ToLower(event.ErrorText), "unable to connect"):
				streamErr = ErrUnreachable
			default:
				streamErr = fmt.Errorf("iperf3: %s", event.ErrorText)
			}

			break
		}
	}

	if scanErr := scanner.Err(); streamErr == nil && scanErr != nil {
		streamErr = fmt.Errorf("read iperf3 output: %w", scanErr)
	}

	if streamErr != nil {
		if command.Process != nil {
			_ = command.Process.Kill()
		}

		_ = command.Wait()

		return streamErr
	}

	if err := command.Wait(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		message := strings.TrimSpace(stderr.String())

		if message != "" {
			return fmt.Errorf("iperf3 failed: %s: %w", message, err)
		}

		return fmt.Errorf("iperf3 failed: %w", err)
	}

	if ctx.Err() != nil {
		return ctx.Err()
	}

	return nil
}
