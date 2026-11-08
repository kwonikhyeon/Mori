# Mori (몰이)

herdr-core(`hc`) 위에서 도는 원격 작업 웹앱입니다. 터미널 세션과 코딩 에이전트(Claude Code, Codex)를 폴더별로 띄우고, 승인·입력 대기 알림을 받고, Git 워크트리를 다룹니다. 휴대폰을 포함해 어느 기기의 브라우저에서든 씁니다. 밖에서는 Tailscale을 거쳐 접속합니다.

- **세션은 herdr-core에 삽니다.** 브라우저를 닫거나 Mori를 다시 띄워도 세션은 그대로입니다.
- **호스트마다 Mori 하나:** 세션을 돌릴 컴퓨터마다 Mori를 설치합니다. 한 호스트가 꺼져도 나머지는 계속 돕니다.
- **tailnet 안에서만:** Mori는 127.0.0.1에서만 듣습니다. 다른 기기에서는 `tailscale serve`가 주는 `https://<호스트>.<tailnet>.ts.net`으로 엽니다.

> 지금은 백엔드 v1입니다. 웹 화면은 자리표시 페이지이고, UI는 [설계](docs/superpowers/specs/2026-11-08-mori-design.md) §12의 단계 9~10에서 만듭니다.

## 요구 사항

| 무엇 | 버전 | 쓰는 곳 |
|---|---|---|
| herdr-core의 `hc` | 0.1.19 이상 | 세션 전부. 없으면 서버는 뜨지만 세션을 다룰 수 없습니다 |
| git | 2.36 이상 | 브랜치·워크트리·변경 보기 |
| Tailscale | MagicDNS와 HTTPS 인증서를 켠 tailnet | 다른 기기에서 접속 |
| OS | macOS, Windows 10 이상 | 서비스 설치. Linux는 빌드만 하므로 `mori serve`를 직접 띄웁니다 |

## 설치

1. **실행 파일 놓기.** 소스에서 빌드하려면 Go 1.26.5 이상이 필요합니다. go 명령이 go.mod의 툴체인(go1.26.10)을 받아 씁니다.

   ```sh
   make release   # dist/mori-<os>-<arch>/
   ```

   - macOS: `mori`를 계속 둘 곳(예: `~/.local/bin`)에 놓습니다. 서비스는 설치할 때의 경로를 가리키므로 임시 디렉터리 안의 파일로는 설치하지 않습니다.
   - Windows: `mori.exe`와 `moriw.exe`를 같은 폴더에 둡니다. 로그인할 때는 콘솔 창이 없는 `moriw.exe`가 뜹니다.

2. **서비스 설치.** 로그인할 때마다 서버가 뜨도록 등록하고, 지금 바로 띄워서 응답을 기다립니다.

   ```sh
   mori service install            # --dry-run을 붙이면 할 일만 보여 줍니다
   ```

   - macOS: `~/Library/LaunchAgents/dev.mori.plist`(LaunchAgent)를 씁니다. 서버가 끝나면 launchd가 다시 띄웁니다.
   - Windows: `HKCU\…\CurrentVersion\Run`에 `Mori` 값을 씁니다. 관리자 권한이 필요 없습니다.
   - 옵션: `--home`(상태 디렉터리), `--listen`(기본 `127.0.0.1:7761`, 루프백만), `--public-url`(페어링 링크의 주소), `--hc`(hc 경로), `--hc-session`(herdr-core 세션, 기본은 이 셸의 `HC_SESSION`, 없으면 hc의 기본 세션)

3. **tailnet에 열기.** tailnet 관리 콘솔에서 MagicDNS와 HTTPS 인증서를 켠 뒤 실행합니다. Mori는 Tailscale 설정을 직접 바꾸지 않습니다.

   ```sh
   tailscale serve --bg http://127.0.0.1:7761
   ```

4. **점검.**

   ```sh
   mori doctor
   ```

   한 줄에 한 항목씩 `✓`(정상), `!`(주의: 일부 기능이 빠지거나 이 컴퓨터에서만 열림), `✗`(실패)로 보여 주고, 고칠 방법을 그 아래에 적습니다. `✗`가 있으면 종료 코드가 1입니다. 보는 항목은 Mori 버전, 상태 디렉터리 권한, 서버와 herdr-core 연결, hc·git 버전, Tailscale 이름과 `tailscale serve` 설정, 서비스 설치, 프리셋 프로그램(`claude`, `codex`)입니다. 읽기만 하고 아무것도 바꾸지 않습니다.

## 기기 페어링

```sh
mori pair --name "iPhone"   # 코드, 링크, QR을 보여 줍니다
mori devices                # 페어링된 기기
mori revoke <기기 ID>       # 페어링 철회. 그 기기의 열린 연결이 바로 끊깁니다
```

- 새 기기에서 QR을 찍거나 링크를 엽니다. 코드는 5분 동안 한 번만 쓸 수 있습니다.
- 호스트마다 주소(origin)가 다르므로 페어링, 홈 화면 추가, 알림 켜기도 호스트마다 따로 합니다.
- iPhone·iPad에서 알림을 받으려면 Safari의 "홈 화면에 추가"로 설치한 앱에서 열어야 합니다.

## 업데이트와 제거

- **업데이트:** 서비스를 지우고, 파일을 바꾸고, 다시 설치합니다. Windows는 돌고 있는 `moriw.exe`를 덮어쓸 수 없으므로 이 순서를 지켜야 합니다. 세션은 herdr-core에 있으므로 그동안에도 살아 있습니다.

  ```sh
  mori service uninstall
  # mori(Windows는 mori.exe와 moriw.exe 둘 다)를 새 파일로 바꾼다
  mori service install
  ```

- **제거:** `mori service uninstall`은 서비스를 지우고 서버를 멈춥니다. 상태 디렉터리와 herdr-core, 그 세션은 남깁니다. 모두 지우려면 상태 디렉터리를 지웁니다. 그러면 모든 기기를 다시 페어링해야 합니다.

## 알아 둘 것

- **상태 디렉터리:** `--home`, 다음 `MORI_HOME`, 그다음 OS의 설정 디렉터리 아래 `Mori`입니다(macOS `~/Library/Application Support/Mori`, Windows `%AppData%\Mori`, Linux `~/.config/Mori`). 안에는 `state.json`(폴더, 프리셋, 기기, 알림 구독과 키), `mori.sock`(관리 소켓), `mori.log`(서비스의 로그)가 있습니다.
- **macOS의 PATH:** 서비스의 서버는 설치할 때 셸의 `PATH`로 hc, git, 프리셋 프로그램을 찾습니다. LaunchAgent의 기본 `PATH`에는 `/opt/homebrew/bin`이나 `~/.local/bin`이 없기 때문입니다. `PATH`를 바꿨다면 `mori service install`을 다시 실행합니다. 서비스가 설치되어 있으면 `mori doctor`도 그 `PATH`로 찾아 봅니다.
- **실행 파일을 옮겼다면** `mori service install`을 다시 실행합니다. 서비스는 설치할 때의 경로를 가리킵니다.
- **Windows의 Run 키:** 로그인 뒤 조금 늦게 뜰 수 있고, 안전 모드에서는 뜨지 않습니다. 명령은 260자까지만 보장되므로, 너무 길면 `mori service install`이 경고합니다. 서버가 비정상 종료하면 다음 로그인까지 다시 뜨지 않으니 `mori service install`로 다시 띄웁니다.
- **herdr-core:** 기본은 hc의 기본 세션, 즉 공식 Herdr 앱과 같은 코어입니다. herdr-core는 처음 자신을 띄운 프로그램의 환경을 모든 세션에 물려줍니다. 그래서 서비스는 정해진 환경으로 서버를 띄웁니다. macOS에서는 설치할 때의 `PATH`, 로캘, XDG 디렉터리 변수만 쓰고, Windows에서는 로그인 환경을 씁니다.
- **로그:** 서비스로 돌 때 `mori.log`에 덧붙이고, 패닉도 그 파일에 남깁니다. 로그를 돌려 쓰지 않으므로 너무 커지면 서버를 멈추고 지웁니다.

## 명령

| 명령 | 하는 일 |
|---|---|
| `mori serve` | 서버를 실행합니다(`--home`, `--listen`, `--public-url`, `--log`, `--hc`, `--hc-session`) |
| `mori service install` / `uninstall` | 로그인할 때 서버를 띄우도록 설치하거나 제거합니다(`--dry-run`) |
| `mori pair` / `devices` / `revoke` | 기기를 페어링하고, 보고, 철회합니다 |
| `mori doctor` | 설치와 연결 상태를 점검합니다(`--home`, `--hc`) |
| `mori version` | 버전, OS, Go 버전을 출력합니다 |

명령마다 `-h`로 옵션을 볼 수 있습니다.

## 보안

- **노출 범위:** Mori는 127.0.0.1에서만 듣고, 밖에서는 `tailscale serve`를 거쳐 tailnet 안에서만 닿습니다. HTTPS 인증서의 이름(`<호스트>.<tailnet>.ts.net`)은 공개 인증서 투명성(CT) 로그에 남습니다.
- **기기 인증:** 페어링한 기기만 들어옵니다. 기기 토큰은 JS가 읽을 수 없는 쿠키(SameSite=Strict)로만 오가고, 서버에는 해시만 저장합니다. 상태를 바꾸는 요청과 WebSocket은 `Origin`이 같은 호스트여야 합니다.
- **페어링 남용:** 코드는 한 번만 쓰고 5분 뒤 만료됩니다. 실패가 10분 안에 10번을 넘으면 그 창이 끝날 때까지 모든 페어링을 거절합니다.
- **코어 보호:** 브라우저는 herdr-core에 직접 명령을 보낼 수 없고, Mori가 정해진 동작만 중계합니다. git 경로는 등록한 폴더의 워크트리로 제한합니다.
- **로컬 파일:** 상태 디렉터리는 0700, `state.json`과 관리 소켓은 0600입니다(Windows는 사용자 프로필의 ACL을 따릅니다). `state.json`에는 알림 서명 키(VAPID 개인 키)와 토큰 해시가 들어 있습니다. 관리 소켓은 같은 사용자의 `mori` 명령만 씁니다.
- **서비스 환경:** macOS의 plist에는 `PATH`, 로캘, XDG 디렉터리 변수만 넣습니다. 셸의 토큰이나 키는 plist와 세션에 들어가지 않습니다.
- **응답 헤더:** 모든 응답에 CSP(`default-src 'self'`, 인라인 스크립트 금지), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`를 붙입니다.

## 개발

```sh
make build       # bin/mori
make test        # go test ./...
make vet         # go vet ./...
make release     # darwin/arm64, darwin/amd64, windows/amd64, windows/arm64, linux/amd64
make vuln        # govulncheck: 코드가 닿는 알려진 취약점
make test-clean  # 통합 테스트가 남긴 격리 코어를 멈추고 지웁니다
```

- 통합 테스트는 실제 `hc`로 테스트마다 격리 코어를 띄웁니다. 세션은 `mori-test-<id>`이고, 소켓과 XDG 디렉터리는 저장소의 `.dev/test/<id>`에 둡니다. 사용자의 기본 코어는 건드리지 않습니다. hc가 없으면 그 테스트는 건너뜁니다. 다른 hc로 시험하려면 `MORI_TEST_HC`에 경로를 줍니다.
- 설계는 [docs/superpowers/specs/2026-11-08-mori-design.md](docs/superpowers/specs/2026-11-08-mori-design.md), 구현 계획은 [docs/superpowers/plans/2026-11-09-mori-backend-v1.md](docs/superpowers/plans/2026-11-09-mori-backend-v1.md)에 있습니다.
