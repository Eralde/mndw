module mws-map-page

go 1.26

require (
	golang.org/x/crypto v0.40.0
	mndw.local/device-auth v0.0.0
	mndw.local/rci v0.0.0
)

require golang.org/x/sys v0.34.0 // indirect

replace mndw.local/device-auth => ../../../packages/go-device-auth

replace mndw.local/rci => ../../../packages/go-rci
