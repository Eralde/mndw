module mndwd

go 1.26

require (
	github.com/coder/websocket v1.8.15
	golang.org/x/sys v0.34.0
	mndw.local/contracts v0.0.0
	mndw.local/mws-members v0.0.0
	mndw.local/rci v0.0.0
	mndw.local/rcisock v0.0.0
	mndw.local/rrd v0.0.0
)

replace mndw.local/contracts => ../contracts-go

replace mndw.local/mws-members => ../../packages/go-mws-members

replace mndw.local/rci => ../../packages/go-rci

replace mndw.local/rcisock => ../../packages/go-rcisock

replace mndw.local/rrd => ../../packages/go-rrd

require golang.org/x/text v0.38.0 // indirect
