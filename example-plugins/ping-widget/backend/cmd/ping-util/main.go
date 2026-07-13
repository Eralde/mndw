package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"ping-widget/internal/cli"
	"ping-widget/internal/daemon"
	"ping-widget/internal/model"
)

func main() {
	subcommand := ""
	if len(os.Args) > 1 {
		subcommand = os.Args[1]
	}

	switch subcommand {
	case "daemon":
		response, err := cli.StartDaemon()
		printResult(response, err)
	case "daemon-run":
		runDaemon()
	case "stop":
		response, err := cli.StopDaemon()
		printResult(response, err)
	case "stats":
		response, err := cli.Stats()
		printResult(response, err)
	case "hosts-list":
		response, err := cli.HostsList()
		printResult(response, err)
	case "hosts-update":
		response, err := cli.HostsUpdate(os.Stdin)
		printResult(response, err)
	case "persist-now":
		response, err := cli.PersistNow()
		printResult(response, err)
	default:
		printResult(model.Response{}, errors.New("usage: ping-util <daemon|stop|stats|hosts-list|hosts-update|persist-now>"))
	}
}

func runDaemon() {
	server, err := daemon.NewServer()
	if err != nil {
		printResult(model.Response{}, err)
		os.Exit(1)
	}

	if err = server.Run(); err != nil {
		printResult(model.Response{}, err)
		os.Exit(1)
	}

	printJSON(model.Response{Success: true, Message: "Daemon stopped"})
}

func printResult(response model.Response, err error) {
	if err != nil {
		printJSON(model.Response{
			Success: false,
			Error:   "COMMAND_FAILED",
			Message: err.Error(),
		})
		os.Exit(1)
	}

	if !response.Success {
		if response.Error == "" {
			response.Error = "REQUEST_FAILED"
		}
		if response.Message == "" {
			response.Message = "Command failed"
		}
		printJSON(response)
		os.Exit(1)
	}

	printJSON(response)
}

func printJSON(value any) {
	encoder := json.NewEncoder(io.Writer(os.Stdout))
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		_, _ = fmt.Fprintf(os.Stdout, "{\"success\":false,\"error\":\"ENCODE_FAILED\",\"message\":%q}\n", err.Error())
	}
}
