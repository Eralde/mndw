module mndwd

go 1.26

require (
	github.com/coder/websocket v1.8.15
	mndw.local/shared v0.0.0
)

replace mndw.local/shared => ../../packages/go-shared

require golang.org/x/crypto v0.40.0 // indirect

require golang.org/x/sys v0.34.0 // indirect
