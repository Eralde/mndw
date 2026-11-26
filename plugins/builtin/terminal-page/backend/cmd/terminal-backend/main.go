package main

import (
	"os"

	"terminal-page/run"
)

func main() {
	os.Exit(run.Main(os.Args[1:]))
}
