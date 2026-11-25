//go:build !linux

package devices

import "fmt"

type unsupportedOS struct{}

func NewOS() OS {
	return unsupportedOS{}
}

func (unsupportedOS) Inspect(string) (Binding, error) {
	return Binding{}, fmt.Errorf("block-device inspection is supported on Linux only")
}
