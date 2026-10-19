package lookup

import (
	"errors"
	"net"
	"time"
)

// lookupHost and lookupCNAME are DNS resolution functions. Tests replace both
// with mocks so NXDOMAIN and success tests are deterministic and offline-safe.
// The real functions only run in the CLI/shell smoke tests, not in `go test`.
var lookupHost = net.LookupHost
var lookupCNAME = net.LookupCNAME

func Resolve(hostname string) LookupResult {
	if hostname == "" {
		return LookupResult{
			Success: false,
			Error:   "EMPTY_HOSTNAME",
			Message: "hostname is required",
		}
	}

	start := time.Now()

	addrs, err := lookupHost(hostname)
	duration := time.Since(start).Seconds() * 1000

	if err != nil {
		var dnsErr *net.DNSError

		if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
			return LookupResult{
				Success:  false,
				Error:    "NXDOMAIN",
				Message:  "hostname not found",
				Hostname: hostname,
			}
		}

		return LookupResult{
			Success:    false,
			Error:      "LOOKUP_FAILED",
			Message:    err.Error(),
			Hostname:   hostname,
			DurationMs: duration,
		}
	}

	cname := ""

	if net.ParseIP(hostname) == nil {
		cname, _ = lookupCNAME(hostname)
	}

	return LookupResult{
		Success:    true,
		Hostname:   hostname,
		Addresses:  addrs,
		Cname:      cname,
		DurationMs: duration,
	}
}
