// Package auth performs the device controller/extender authentication
// handshake. It negotiates the x-ndw4 SCRAM protocol first and falls back to
// the x-ndw2 legacy challenge when a device advertises both and its x-ndw4
// implementation fails.
//
// Transport is the only I/O seam; HTTPTransport is the production
// implementation and is trivially replaced by a fake in tests.
package auth
