package main

import (
	"fmt"
	"io"
	"strings"

	dnslookup "dns-lookup-widget/run"
	mwspage "mws-page/run"
	terminalpage "terminal-page/run"
)

type backendEntry struct {
	name string
	main func([]string) int
}

var builtinBackendEntries = []backendEntry{
	{name: "terminal-backend", main: terminalpage.Main},
	{name: "mwsd", main: mwspage.Main},
	{name: "dns-util", main: dnslookup.Main},
}

func dispatchBackend(args []string, entries []backendEntry, stderr io.Writer, setProcessName func(string)) (bool, int) {
	if len(args) == 0 || args[0] != "backend" {
		return false, 0
	}

	knownNames := make([]string, 0, len(entries))

	for _, entry := range entries {
		knownNames = append(knownNames, entry.name)
	}

	if len(args) < 2 {
		_, _ = fmt.Fprintf(stderr, "mndwd backend: expected a name; known backends: %s\n", strings.Join(knownNames, ", "))

		return true, 2
	}

	name := args[1]

	for _, entry := range entries {
		if entry.name == name {
			setProcessName(name)

			return true, entry.main(args[2:])
		}
	}

	_, _ = fmt.Fprintf(stderr, "mndwd backend: unknown name %q; known backends: %s\n", name, strings.Join(knownNames, ", "))

	return true, 2
}
