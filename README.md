# EchoLoopMCP

Agentic AI가 작업을 마치면 텔레그램/디스코드로 알림을 보내고, **사용자의 답장을 세션 안에서 그대로 다음 지시로 받아오는** MCP 서버.

```
Claude 세션 ──notify()──▶ 텔레그램/디스코드 ──▶ 폰
Claude 세션 ──ask()────▶ (전송 후 블로킹) ◀──답장── 폰
                └─▶ 답장 텍스트 = 다음 작업 지시
```

상시 무료, 서버리스. 인바운드는 Telegram `getUpdates` 롱폴링 / Discord REST 폴링으로 처리하므로 공개 엔드포인트가 필요 없다.

## 툴

| 툴 | 동작 |
|---|---|
| `notify(message)` | 메시지를 보내고 즉시 반환. 답장을 기다리지 않음. |
| `ask(message, timeout_seconds?)` | 메시지를 보내고 답장이 올 때까지 블로킹. 답장 텍스트를 반환. |

`ask`는 호출 시점 이전에 온 메시지를 버리므로, 이전 대화가 답장으로 오인되지 않는다. 대기 중에는 20초마다 progress 알림을 보내 MCP 클라이언트 타임아웃을 갱신한다.

## 설치

```bash
npm install
npm run build
```

## 채널 설정

키가 있는 채널만 사용된다. 둘 다 설정된 경우 텔레그램이 우선이며 `ECHOLOOP_CHANNEL`로 강제할 수 있다.

### 텔레그램 (양방향, 권장)

1. [@BotFather](https://t.me/BotFather)에서 `/newbot` → 봇 토큰 발급
2. 만든 봇에게 아무 메시지나 1회 전송
3. `chat_id` 확인:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
   # → result[0].message.chat.id
   ```

```
TELEGRAM_BOT_TOKEN=123456:AA...
TELEGRAM_CHAT_ID=987654321
```

### 디스코드 (양방향)

1. [Developer Portal](https://discord.com/developers/applications)에서 애플리케이션 → Bot 생성 → 토큰 발급
2. 서버에 초대. 필요 권한: **View Channel**, **Send Messages**, **Read Message History**
   (REST로 읽으므로 Message Content Intent는 필요 없다)
3. 채널 우클릭 → ID 복사 (개발자 모드 필요)

```
DISCORD_BOT_TOKEN=...
DISCORD_CHANNEL_ID=...
```

### 디스코드 웹훅 (단방향)

채널 설정 → 연동 → 웹훅 URL. `notify`만 동작하고 `ask`는 에러를 반환한다.

```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

## Claude Code에 등록

프로젝트의 `.mcp.json`이 셸 환경변수를 읽는다:

```bash
export TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=...
claude
```

또는 값을 직접 박아서 등록:

```bash
claude mcp add echoloop \
  -e TELEGRAM_BOT_TOKEN=... -e TELEGRAM_CHAT_ID=... \
  -- node /path/to/EchoLoop/dist/index.js
```

`ask`의 대기 시간이 클라이언트 기본 타임아웃보다 길면 `MCP_TOOL_TIMEOUT`을 함께 올린다.

## 옵션

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `ECHOLOOP_CHANNEL` | 자동 | `telegram` \| `discord` 강제 선택 |
| `ECHOLOOP_TIMEOUT` | `240` | `ask` 기본 대기 시간(초) |
