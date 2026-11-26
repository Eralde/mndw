// Package run provides the dns-lookup-widget backend entry point shared by the standalone
// cmd/dns-util binary and mndwd's "mndwd backend dns-util" command.
package run

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"

	"dns-lookup-widget/internal/lookup"
)

// Main runs the backend and returns the process exit code. args excludes the program name.
func Main(args []string) int {
	if len(args) < 2 {
		printJSON(lookup.LookupResult{
			Success: false,
			Error:   "USAGE",
			Message: "usage: dns-util lookup <hostname>",
		})

		return 1
	}

	subcommand := args[0]

	if subcommand != "lookup" {
		printJSON(lookup.LookupResult{
			Success: false,
			Error:   "UNKNOWN_COMMAND",
			Message: fmt.Sprintf("unknown subcommand: %s", subcommand),
		})

		return 1
	}

	hostname, err := url.QueryUnescape(args[1])
	if err != nil {
		printJSON(lookup.LookupResult{
			Success: false,
			Error:   "INVALID_HOSTNAME_ENCODING",
			Message: "hostname is not valid URL encoding",
		})

		return 1
	}

	result := lookup.Resolve(hostname)

	printJSON(result)

	if !result.Success {
		return 1
	}

	return 0
}

func printJSON(value any) {
	encoder := json.NewEncoder(os.Stdout)

	encoder.SetEscapeHTML(false)

	if err := encoder.Encode(value); err != nil {
		_, _ = fmt.Fprintf(os.Stdout, "{\"success\":false,\"error\":\"ENCODE_FAILED\",\"message\":%q}\n", err.Error())
	}
}
