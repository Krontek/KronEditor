module plc-agent

go 1.25.0

require (
	connectrpc.com/connect v1.19.1
	golang.org/x/net v0.52.0
	google.golang.org/protobuf v1.36.9
)

require (
	github.com/krontek/hotswaplib v0.0.0
	golang.org/x/text v0.35.0 // indirect
)

replace github.com/krontek/hotswaplib => ../hotswaplib
