package system

import "errors"

// parseBootID validates the canonical hyphenated UUID spelling of a Linux boot
// identifier and returns its 16 bytes. It never accepts a truncated,
// overlong, uppercase, or non-hexadecimal spelling.
func parseBootID(raw string) ([16]byte, error) {
	var id [16]byte

	if len(raw) != 36 {
		return [16]byte{}, errors.New("telemetry: boot id must be a 36-character uuid")
	}

	for _, i := range [...]int{8, 13, 18, 23} {
		if raw[i] != '-' {
			return [16]byte{}, errors.New("telemetry: boot id must be hyphenated 8-4-4-4-12")
		}
	}

	digit := func(b byte) (byte, bool) {
		switch {
		case b >= '0' && b <= '9':
			return b - '0', true
		case b >= 'a' && b <= 'f':
			return b - 'a' + 10, true
		default:
			return 0, false
		}
	}

	byteIndex := 0

	for i := 0; i < len(raw); i++ {
		if raw[i] == '-' {
			continue
		}

		high, ok := digit(raw[i])

		if !ok {
			return [16]byte{}, errors.New("telemetry: boot id must use lowercase hexadecimal digits")
		}

		i++
		low, ok := digit(raw[i])

		if !ok {
			return [16]byte{}, errors.New("telemetry: boot id must use lowercase hexadecimal digits")
		}

		id[byteIndex] = high<<4 | low
		byteIndex++
	}

	if byteIndex != len(id) {
		return [16]byte{}, errors.New("telemetry: boot id must encode 16 bytes")
	}

	if id == [16]byte{} {
		return [16]byte{}, errors.New("telemetry: boot id must not be all zeroes")
	}

	return id, nil
}
