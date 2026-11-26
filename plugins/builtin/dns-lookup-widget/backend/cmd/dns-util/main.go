package main

import (
	"os"

	"dns-lookup-widget/run"
)

func main() {
	os.Exit(run.Main(os.Args[1:]))
}
