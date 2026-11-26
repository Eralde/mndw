//go:build linux

package main

import "os"

func setBackendProcessName(name string) {
	_ = os.WriteFile("/proc/self/comm", []byte(name), 0)
}
