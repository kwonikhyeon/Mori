VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X github.com/kwonikhyeon/mori/internal/version.Version=$(VERSION)
TARGETS := darwin/arm64 darwin/amd64 windows/amd64 windows/arm64 linux/amd64

build:
	go build -ldflags '$(LDFLAGS)' -o bin/mori ./cmd/mori

test:
	go test ./...

vet:
	go vet ./...

# Windows also gets moriw.exe, a GUI-subsystem build that opens no console
# window; the service runs it.
release:
	@rm -rf dist
	@for t in $(TARGETS); do os=$${t%/*}; arch=$${t#*/}; ext=; [ $$os = windows ] && ext=.exe; \
	  out=dist/mori-$$os-$$arch; \
	  GOOS=$$os GOARCH=$$arch CGO_ENABLED=0 go build -trimpath -ldflags '$(LDFLAGS)' -o $$out/mori$$ext ./cmd/mori || exit 1; \
	  if [ $$os = windows ]; then \
	    GOOS=$$os GOARCH=$$arch CGO_ENABLED=0 go build -trimpath -ldflags '$(LDFLAGS) -H=windowsgui' -o $$out/moriw.exe ./cmd/mori || exit 1; \
	  fi; \
	  echo "built $$out"; \
	done

# Reports the known vulnerabilities the code can reach, in the standard
# library and the dependencies (spec §3 #88).
vuln:
	go run golang.org/x/vuln/cmd/govulncheck@v1.1.4 ./...

# Stops the isolated cores integration tests leave behind under .dev/test.
test-clean:
	@for d in .dev/test/*/; do [ -d "$$d" ] || continue; d=$${d%/}; id=$${d##*/}; a=$$PWD/$$d; \
	  HC_SESSION=mori-test-$$id XDG_STATE_HOME=$$a/state XDG_CONFIG_HOME=$$a/config XDG_RUNTIME_DIR=$$a/run HC_SOCKET=$$a/c.sock \
	  hc server stop >/dev/null 2>&1; rm -rf "$$a"; echo "stopped $$id"; done

.PHONY: build test vet vuln release test-clean
