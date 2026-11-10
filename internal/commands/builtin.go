package commands

import "slices"

// builtins are Claude Code's own commands and the skills and workflows it
// comes with, as its documentation lists them (code.claude.com/docs/en/
// commands, read 2026-11-11). The ones its menu hides (heapdump,
// setup-bedrock, setup-vertex) and the removed ones (pr-comments,
// ultraplan, vim) are left out. An alias finds its command but has no row
// of its own. Some need a plan or a platform that this list cannot tell.
var builtins = []Command{
	c("add-dir", "<path>", "이번 세션에서 파일을 다룰 폴더를 더합니다"),
	c("advisor", "[model|off]", "두 번째 모델에게 조언을 구하는 도구를 켜고 끕니다"),
	c("agents", "", "서브에이전트를 관리하는 방법을 알려 줍니다"),
	c("artifact-capabilities", "", "아티팩트가 할 수 있는 일을 불러옵니다"),
	c("artifact-diagramming", "", "아티팩트에 다이어그램을 그리는 법을 불러옵니다"),
	c("artifacts", "", "내 아티팩트와 공유받은 아티팩트를 봅니다").opens(),
	c("auto-mode-setup", "", "자동 모드의 환경 설정을 만들어 저장합니다"),
	c("autocompact", "[auto|<tokens>]", "자동 압축을 시작할 맥락 크기를 정합니다"),
	c("autofix-pr", "[prompt]", "클라우드 세션이 PR의 CI 실패를 고칩니다"),
	c("background", "[prompt]", "이 세션을 백그라운드 에이전트로 돌립니다").also("bg"),
	c("batch", "<instruction>", "큰 변경을 워크트리별 서브에이전트로 나눠 합니다"),
	c("branch", "[name]", "대화를 갈라 다른 방향을 시도합니다"),
	c("btw", "[question]", "기록에 남기지 않고 곁가지 질문을 합니다"),
	c("bug", "[report]", "버그를 알리거나 대화를 공유합니다").also("share"),
	c("cd", "<path>", "대화를 이어 가며 다른 폴더로 옮깁니다"),
	c("chrome", "", "Claude in Chrome 설정을 엽니다").opens(),
	c("claude-api", "[subcommand]", "Claude API와 Managed Agents 참고 자료를 불러옵니다"),
	c("claude-in-chrome", "[task]", "Chrome에서 브라우저 작업을 시킵니다"),
	c("clear", "[name]", "맥락을 비우고 새 대화를 시작합니다").also("reset", "new"),
	c("code-review", "[level] [target]", "변경·PR·브랜치의 버그를 검토합니다").also("review"),
	c("color", "[color|default]", "이 세션의 프롬프트 막대 색을 바꿉니다"),
	c("compact", "[instructions]", "대화를 요약해 맥락 공간을 비웁니다"),
	c("config", "[key=value]", "설정을 열거나 값을 바로 바꿉니다").opens().also("settings"),
	c("context", "[all]", "맥락 사용량을 격자로 보여 줍니다"),
	c("copy", "[N]", "마지막 답이나 N번째 답을 클립보드에 복사합니다"),
	c("dataviz", "[request]", "차트와 대시보드를 디자인하는 지침을 불러옵니다"),
	c("debug", "[description]", "디버그 로그를 켜고 문제를 살핍니다"),
	c("deep-research", "<question>", "웹을 두루 찾아 출처를 단 보고서를 씁니다"),
	c("design", "[brief]", "Claude Design 아트보드에 UI 시안을 그립니다"),
	c("design-login", "", "Claude Design의 디자인 시스템을 쓰려고 로그인합니다"),
	c("design-sync", "[hint]", "React 디자인 시스템을 Claude Design에 올립니다"),
	c("desktop", "", "이 세션을 데스크톱 앱으로 넘깁니다").also("app"),
	c("diff", "", "작업 트리의 변경과 Claude가 고친 곳을 봅니다").opens(),
	c("doctor", "[prompt-audit]", "설치 문제를 진단하고 고칠 방법을 제안합니다").also("checkup"),
	c("effort", "[level|auto|status]", "추론 노력 수준을 정합니다"),
	c("exit", "", "Claude Code를 끝냅니다").also("quit"),
	c("export", "[filename]", "대화를 파일이나 클립보드로 내보냅니다").opens(),
	c("fast", "[on|off]", "빠른 모드를 켜고 끕니다"),
	c("feedback", "[report]", "Claude Code에 의견을 보냅니다"),
	c("fewer-permission-prompts", "", "자주 쓰는 읽기 도구를 허용 목록에 넣습니다"),
	c("focus", "", "프롬프트와 최종 답만 보이는 보기를 켜고 끕니다"),
	c("fork", "[prompt]", "이 대화를 새 백그라운드 세션으로 복사합니다"),
	c("goal", "[condition|clear]", "조건을 이룰 때까지 계속 일하게 합니다"),
	c("help", "", "도움말과 명령 목록을 봅니다").opens(),
	c("hooks", "", "설정된 훅을 봅니다").opens(),
	c("ide", "", "IDE 연결을 관리합니다").opens(),
	c("import", "[codex|gemini|cursor]", "다른 도구의 설정을 가져옵니다"),
	c("init", "", "프로젝트의 CLAUDE.md를 만듭니다"),
	c("insights", "", "최근 세션을 분석한 HTML 보고서를 만듭니다"),
	c("install-github-app", "", "저장소에 Claude GitHub 앱을 설치합니다").opens(),
	c("install-slack-app", "", "Claude Slack 앱을 설치합니다"),
	c("keybindings", "", "단축키 설정 파일을 엽니다"),
	c("list-agents", "", "메시지를 보낼 수 있는 에이전트와 세션을 봅니다").also("peers"),
	c("login", "", "Anthropic 계정에 로그인합니다").opens(),
	c("logout", "", "Anthropic 계정에서 로그아웃합니다"),
	c("loop", "[interval] [prompt]", "정한 간격으로 프롬프트를 되풀이합니다").also("proactive"),
	c("mcp", "[reconnect|enable|disable]", "MCP 서버 연결을 관리합니다").opens(),
	c("memory", "", "CLAUDE.md와 자동 메모리를 편집합니다").opens(),
	c("mobile", "", "모바일 앱을 받는 QR 코드를 보여 줍니다").opens().also("ios", "android"),
	c("model", "[model]", "모델을 바꿉니다").opens(),
	c("output-style", "[style]", "출력 스타일을 고르거나 바꿉니다").opens(),
	c("passes", "", "친구에게 무료 체험을 나눠 줍니다").opens(),
	c("permissions", "", "도구 허용·거부 규칙을 편집합니다").opens().also("allowed-tools"),
	c("plan", "[description]", "계획 모드로 들어갑니다"),
	c("plugin", "[subcommand]", "플러그인을 관리합니다").opens(),
	c("plugin-authoring", "", "모드를 만들 때 따를 참고 자료를 불러옵니다"),
	c("powerup", "", "짧은 애니메이션 강좌로 기능을 익힙니다").opens(),
	c("privacy-settings", "", "개인정보 설정을 봅니다").opens(),
	c("radio", "", "브라우저에서 lo-fi 라디오를 틉니다"),
	c("rate-limit-options", "", "사용 한도에 걸렸을 때 할 수 있는 일을 봅니다").opens(),
	c("recap", "", "이 세션을 한 줄로 요약합니다"),
	c("release-notes", "", "변경 기록을 봅니다").opens(),
	c("reload-plugins", "[--force]", "플러그인 변경을 다시 시작하지 않고 적용합니다"),
	c("reload-skills", "", "스킬 폴더를 다시 읽습니다"),
	c("remote-control", "", "claude.ai에서 이 세션을 원격으로 다루게 합니다").also("rc"),
	c("remote-env", "", "클라우드 세션의 기본 환경을 정합니다").opens(),
	c("rename", "[name]", "세션 이름을 바꿉니다"),
	c("restart", "", "업데이트 뒤 이 세션을 다시 엽니다").also("update"),
	c("resume", "[session]", "이전 대화를 다시 엽니다").opens().also("continue"),
	c("rewind", "", "대화나 코드를 이전 시점으로 되돌립니다").opens().also("checkpoint", "undo"),
	c("run", "", "앱을 실행해 변경이 동작하는지 보여 줍니다"),
	c("run-skill-generator", "", "/run과 /verify가 쓸 프로젝트 스킬을 씁니다"),
	c("sandbox", "", "샌드박스 모드를 켜고 끕니다").opens(),
	c("schedule", "[description]", "클라우드 예약 작업을 관리합니다").also("routines"),
	c("scroll-speed", "", "마우스 휠 스크롤 속도를 맞춥니다").opens(),
	c("security-review", "", "브랜치 변경의 보안 문제를 검토합니다"),
	c("simplify", "[target]", "바뀐 코드를 정리하고 고칩니다"),
	c("skill-doctor", "", "스킬마다 맥락 비용과 쓰는 빈도를 봅니다"),
	c("skills", "", "스킬 목록을 보고 켜고 끕니다").opens(),
	c("slides", "[brief]", "슬라이드 발표 자료를 만듭니다"),
	c("status", "", "버전·모델·계정·연결 상태를 봅니다").opens(),
	c("statusline", "", "상태 줄을 설정합니다"),
	c("stickers", "", "Claude Code 스티커를 주문합니다"),
	c("stop", "", "붙어 있는 백그라운드 세션을 멈춥니다"),
	c("subtask", "<task>", "대화를 물려받는 백그라운드 서브에이전트를 띄웁니다"),
	c("tasks", "", "백그라운드 작업을 보고 다룹니다").opens().also("bashes"),
	c("team-onboarding", "", "팀 온보딩 안내서를 만듭니다"),
	c("teleport", "", "클라우드 세션을 이 터미널로 가져옵니다").opens().also("tp"),
	c("terminal-setup", "", "Shift+Enter 줄바꿈 키를 설치합니다"),
	c("theme", "", "색 테마를 바꿉니다").opens(),
	c("tui", "[default|fullscreen]", "터미널 화면을 그리는 방식을 바꿉니다"),
	c("ultrareview", "[PR|branch]", "여러 에이전트가 클라우드에서 깊이 검토합니다"),
	c("update-config", "[request]", "말한 대로 settings.json을 고칩니다"),
	c("upgrade", "", "요금제를 올리는 페이지를 엽니다"),
	c("usage", "", "비용, 한도 사용량, 활동 통계를 봅니다").opens().also("cost", "stats"),
	c("usage-credits", "", "사용 크레딧을 설정합니다").opens(),
	c("verify", "", "앱을 빌드하고 실행해 변경을 확인합니다"),
	c("voice", "[hold|tap|off]", "음성 받아쓰기를 켜고 끕니다"),
	c("web-setup", "", "클라우드 세션에 GitHub을 연결합니다"),
	c("workflow-authoring", "", "워크플로 스크립트를 쓰는 안내를 불러옵니다"),
	c("workflows", "", "워크플로 실행의 진행을 봅니다").opens(),
}

// Builtins is the list of the built-in commands alone, which a terminal on
// another machine gets: its own files are not here.
func Builtins() []Command { return slices.Clone(builtins) }

func c(name, hint, desc string) Command {
	return Command{Name: name, Desc: desc, Hint: hint, Source: SourceBuiltin}
}

// opens marks a command that, sent bare, opens a picker or a dialog in the
// terminal instead of doing something.
func (c Command) opens() Command {
	c.Menu = true
	return c
}

func (c Command) also(aliases ...string) Command {
	c.Aliases = aliases
	return c
}
