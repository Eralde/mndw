package timekeeper

import "encoding/json"

// NTPStatus contains the fields returned by show.ntp.status.
type NTPStatus struct {
	ElapsedS     int64
	Server       string
	Accurate     bool
	Synchronized bool
	NDSSTime     bool
	UserTime     bool
}

// DecodeNTPStatus decodes the JSON body returned by show.ntp.status.
func DecodeNTPStatus(body []byte) (NTPStatus, error) {
	var wire struct {
		Elapsed      int64  `json:"elapsed"`
		Server       string `json:"server"`
		Accurate     bool   `json:"accurate"`
		Synchronized bool   `json:"synchronized"`
		NDSSTime     bool   `json:"ndsstime"`
		UserTime     bool   `json:"usertime"`
	}

	if err := json.Unmarshal(body, &wire); err != nil {
		return NTPStatus{}, err
	}

	return NTPStatus{
		ElapsedS:     wire.Elapsed,
		Server:       wire.Server,
		Accurate:     wire.Accurate,
		Synchronized: wire.Synchronized,
		NDSSTime:     wire.NDSSTime,
		UserTime:     wire.UserTime,
	}, nil
}

// IsEvidence reports whether the status is acceptable NTP evidence.
func (s NTPStatus) IsEvidence() bool {
	return s.Accurate && s.Server != "" && !s.UserTime && !s.NDSSTime
}
