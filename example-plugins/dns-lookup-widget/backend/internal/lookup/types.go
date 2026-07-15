package lookup

type LookupResult struct {
	Success    bool     `json:"success"`
	Error      string   `json:"error,omitempty"`
	Message    string   `json:"message,omitempty"`
	Hostname   string   `json:"hostname,omitempty"`
	Addresses  []string `json:"addresses,omitempty"`
	Cname      string   `json:"cname,omitempty"`
	DurationMs float64  `json:"durationMs,omitempty"`
}
