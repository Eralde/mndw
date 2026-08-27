module mws-page

go 1.26

require (
	mndw.local/httpsocket v0.0.0
	mndw.local/rci v0.0.0
	mndw.local/rcisock v0.0.0
)

replace mndw.local/httpsocket => ../../../../packages/go-httpsocket

replace mndw.local/rci => ../../../../packages/go-rci

replace mndw.local/rcisock => ../../../../packages/go-rcisock
