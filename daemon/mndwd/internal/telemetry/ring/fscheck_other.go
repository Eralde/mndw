//go:build !linux

package ring

// CheckFilesystem is a no-op on non-Linux platforms.
func CheckFilesystem(_ string) error {
	return nil
}
