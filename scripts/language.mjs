export const messages = {
  en: {
    help: `EchoLoop
  setup          Connect Telegram and install Codex / Claude Code hooks
  on [path]      Enable notifications for a project (default: current folder)
  off [path]     Disable notifications for a project
  status [path]  Show connection and project settings
  language en|ko Change the CLI language
  help          Show this help`,
    bot: 'Open https://t.me/BotFather and send /newbot. Choose a display name and a unique username ending in bot. Copy the API token from BotFather.',
    token: 'Telegram bot token (hidden): ',
    invalidToken: 'Invalid bot token format. Run echoloop setup again.',
    pair: 'Open this link and press Start within 2 minutes. Your private chat ID will be saved automatically:',
    timeout: 'Pairing timed out. Run echoloop setup again.',
    first: 'Run echoloop setup first.',
    clients: 'No supported client found. Install Codex or Claude Code, add it to PATH, and rerun echoloop setup.',
    codexEntry: 'Cannot find the Codex executable. Check your Codex installation.',
    connected: 'Connected',
    missing: 'Not configured',
    project: 'Project',
    restart: 'Restart the connected clients after setup. Later on/off changes apply immediately.',
    language: 'Language saved: English',
    usage: 'Invalid command or arguments. Run echoloop help.',
    eof: 'Input ended. Run echoloop setup in an interactive terminal.',
  },
  ko: {
    help: `EchoLoop
  setup          텔레그램 연결 및 Codex / Claude Code 훅 설치
  on [경로]      프로젝트 알림 켜기 (기본: 현재 폴더)
  off [경로]     프로젝트 알림 끄기
  status [경로]  연결 및 프로젝트 설정 확인
  language en|ko CLI 출력 언어 변경
  help           도움말 표시`,
    bot: 'https://t.me/BotFather 에서 /newbot을 보내세요. 표시 이름과 bot으로 끝나는 고유 사용자명을 정하고, BotFather가 발급한 API 토큰을 복사하세요.',
    token: 'Telegram 봇 토큰 (입력 숨김): ',
    invalidToken: '봇 토큰 형식을 확인한 후 echoloop setup을 다시 실행하세요.',
    pair: '아래 링크를 열고 2분 안에 시작(Start)을 누르세요. 개인 챗 ID를 자동 저장합니다:',
    timeout: '연결 대기 시간이 끝났습니다. echoloop setup을 다시 실행하세요.',
    first: '먼저 echoloop setup을 실행하세요.',
    clients: 'Codex 또는 Claude Code를 설치하고 PATH에 추가한 뒤 echoloop setup을 다시 실행하세요.',
    codexEntry: 'Codex 실행 파일을 찾을 수 없습니다. Codex 설치를 확인하세요.',
    connected: '연결됨',
    missing: '미설정',
    project: '프로젝트',
    restart: '설정 후 연결한 클라이언트를 재시작하세요. 이후 on/off는 즉시 반영됩니다.',
    language: '출력 언어: 한국어',
    usage: '명령어나 인수가 올바르지 않습니다. echoloop help를 실행하세요.',
    eof: '입력이 종료되었습니다. 터미널에서 echoloop setup을 실행하세요.',
  },
};

export function languageOf(settings) { return settings.language === 'ko' ? 'ko' : 'en'; }
