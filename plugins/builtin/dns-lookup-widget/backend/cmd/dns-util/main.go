package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"

	"dns-lookup-widget/internal/lookup"
)

func main() {
	if len(os.Args) < 3 {
		printJSON(lookup.LookupResult{
			Success: false,
			Error:   "USAGE",
			Message: "usage: dns-util lookup <hostname>",
		})
		os.Exit(1)
	}

	subcommand := os.Args[1]

	if subcommand != "lookup" {
		printJSON(lookup.LookupResult{
			Success: false,
			Error:   "UNKNOWN_COMMAND",
			Message: fmt.Sprintf("unknown subcommand: %s", subcommand),
		})
		os.Exit(1)
	}

	hostname, err := url.QueryUnescape(os.Args[2])
	if err != nil {
		printJSON(lookup.LookupResult{
			Success: false,
			Error:   "INVALID_HOSTNAME_ENCODING",
			Message: "hostname is not valid URL encoding",
		})
		os.Exit(1)
	}

	result := lookup.Resolve(hostname)
	printJSON(result)

	if !result.Success {
		os.Exit(1)
	}
}

func printJSON(value any) {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		_, _ = fmt.Fprintf(os.Stdout, "{\"success\":false,\"error\":\"ENCODE_FAILED\",\"message\":%q}\n", err.Error())
	}
}
