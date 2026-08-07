package session

import "time"

// RetryDelay implements 1s, 5s, 30s, then once per interval.
func RetryDelay(failures int, interval time.Duration) time.Duration {
	switch failures {
	case 1:
		return time.Second
	case 2:
		return 5 * time.Second
	case 3:
		return 30 * time.Second
	default:
		if interval <= 0 {
			return 30 * time.Second
		}
		return interval
	}
}
