// Package output holds helpers for bounding captured subprocess output.
package output

// TailBytes is the maximum number of trailing bytes retained by Tail.
const TailBytes = 4 << 10

// Tail returns the last TailBytes of v, or v unchanged when it is shorter.
// It works on both string and []byte captures.
func Tail[T ~[]byte | ~string](v T) T {
	if len(v) <= TailBytes {
		return v
	}

	return v[len(v)-TailBytes:]
}
