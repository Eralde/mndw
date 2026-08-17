package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"mndwd/internal/rcisession/status"
)

func main() {
	output := flag.String("output", "", "output JSON path")
	flag.Parse()
	if *output == "" {
		fmt.Fprintln(os.Stderr, "--output is required")
		os.Exit(2)
	}
	contents, err := json.MarshalIndent(status.Values(), "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, "encode status categories:", err)
		os.Exit(1)
	}
	if err := os.MkdirAll(filepath.Dir(*output), 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "create output directory:", err)
		os.Exit(1)
	}
	if err := os.WriteFile(*output, append(contents, '\n'), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "write status categories:", err)
		os.Exit(1)
	}
}
