package main

import (
	"os"

	"mws-page/run"
)

func main() {
	os.Exit(run.Main(os.Args[1:]))
}
