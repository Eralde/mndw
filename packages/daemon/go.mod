module mndwd

go 1.26

require (
	github.com/coder/websocket v1.8.15
	mndw.local/device-auth v0.0.0
	mndw.local/rci v0.0.0
	mndw.local/rcisock v0.0.0
)

require golang.org/x/crypto v0.40.0 // indirect

require golang.org/x/sys v0.34.0 // indirect

replace mndw.local/device-auth => ../go-device-auth

replace mndw.local/rci => ../go-rci

replace mndw.local/rcisock => ../go-rcisock
