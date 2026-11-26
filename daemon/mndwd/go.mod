module mndwd

go 1.26

require (
	dns-lookup-widget v0.0.0
	github.com/coder/websocket v1.8.15
	golang.org/x/sys v0.34.0
	mndw.local/contracts v0.0.0
	mndw.local/mws-members v0.0.0
	mndw.local/rci v0.0.0
	mndw.local/rcisock v0.0.0
	mws-page v0.0.0
	terminal-page v0.0.0
)

replace dns-lookup-widget => ../../plugins/builtin/dns-lookup-widget/backend

replace mndw.local/contracts => ../contracts-go

replace mndw.local/httpsocket => ../../packages/go-httpsocket

replace mndw.local/mws-members => ../../packages/go-mws-members

replace mndw.local/rci => ../../packages/go-rci

replace mndw.local/rcisock => ../../packages/go-rcisock

replace mws-page => ../../plugins/builtin/mws-page/backend

replace terminal-page => ../../plugins/builtin/terminal-page/backend

require (
	golang.org/x/text v0.38.0 // indirect
	mndw.local/httpsocket v0.0.0 // indirect
)
