// Module go-blanklr is a standalone reformatter (stdlib only). It is deliberately
// NOT listed in the repo go.work so `go work sync` never touches it and daemon
// builds never depend on it. Run it via `go run ./tooling/go-blanklr`.
module go-blanklr

go 1.26
