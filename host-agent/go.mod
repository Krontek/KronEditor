module github.com/krontek/kron-host-agent

go 1.25.0

require github.com/klauspost/compress v1.18.6

require (
	github.com/kr/fs v0.1.0 // indirect
	github.com/krontek/hotswaplib v0.0.0
	github.com/pkg/sftp v1.13.10 // indirect
	golang.org/x/crypto v0.52.0 // indirect
	golang.org/x/sys v0.45.0 // indirect
)

replace github.com/krontek/hotswaplib => ../hotswaplib
