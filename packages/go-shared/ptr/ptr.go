// Package ptr provides small pointer helpers.
package ptr

// To returns a pointer to value.
func To[T any](value T) *T {
	return &value
}
