# Linear Pipeline

Linear 이슈 상태 변경을 감지해 Claude Code가 개발·테스트·보안점검·배포 파일 생성까지 자동으로 처리하는 파이프라인입니다.

## 파이프라인 흐름

```
이슈 생성
  ↓
Todo        → [자동] 개발 플랜 작성 → Linear 댓글 등록 → Slack 알림
  ↓
Plan Review → [수동] 플랜 검토 후 Develop으로 이동
  ↓
Develop     → [자동] 코드 개발 → 서버 구동 → E2E/백엔드 테스트 → 보안점검 → PR 생성 → Slack 알림
  ↓
Review      → [수동] 리포트·PR 검토 후 Reviewed로 이동
  ↓
Reviewed    → [자동] Squash Merge → Dockerfile + docker-compose.yml 생성 → Slack 알림 (NAS 배포 명령어 포함)
  ↓
Done        → [수동] NAS에서 docker compose up -d --build
```

## 자동화 범위

### Todo → Plan Review (`skill-02-todo-detect.md`)
- Linear 이슈 분석 (제목, 설명, 우선순위)
- 구현 전략·Feature Branch명·테스트 계획·DoD 포함한 개발 플랜 작성
- Linear 댓글 등록 + Slack 알림

### Develop → Review (`skill-05-develop.md`)
- GitHub repo 자동 생성 (없는 경우) 및 clone
- 기술 스택 자동 감지 (Next.js / Express / Python)
- 프로젝트별 포트 고정 할당 (3001~3010, `_port_map.json`에 영구 저장)
- Feature Branch 생성 및 코드 개발
- 개발 서버 구동 — 오류 자동수정 루프 (성공할 때까지 무한 재시도)
- **테스트**
  - Playwright E2E 테스트 (Next.js/React 스택, 자동수정 루프 최대 5회)
  - Jest / pytest 백엔드 테스트 (자동수정 루프 최대 5회)
- **보안점검**
  - SAST: Semgrep (OWASP Top 10, CWE Top 25, Secrets)
  - SCA: npm audit / pip-audit (critical·high 시 자동수정)
  - DAST: Nuclei (owasp·cve·exposure·misconfig 템플릿, Docker 불필요)
  - HIGH 취약점 자동수정 후 재스캔 (최대 3회)
- 통합 리포트 Linear 댓글 등록 + PR 생성 + Slack 알림

### Reviewed → Done (`skill-11-reviewed-merge.md`)
- PR Squash Merge + Feature Branch 삭제
- Dockerfile 자동 생성 (스택별 멀티스테이지)
- `docker-compose.yml` 생성 (포트는 `HOST_PORT` 환경변수로 수동 지정)
- `.env.example` 생성
- main 브랜치 commit & push
- Linear Done 처리 + Slack 알림 (git clone → HOST_PORT 설정 → docker compose up -d --build 명령어 포함)

## 실행 방식

`linear-monitor.js`가 5분 주기 cron으로 실행되어 Linear API를 폴링합니다.

```
*/5 * * * * /usr/bin/node /workspace/linear-pipeline/linear-monitor.js >> logs/cron.log 2>&1
```

Webhook 방식도 지원합니다 (`webhook-server.js`, 기본 포트 3001).

## 설치 및 설정

### 1. 의존성 설치

```bash
npm install
```

### 2. 환경변수 설정

```bash
cp .env.example .env
# .env 파일을 열어 각 항목 입력
```

### 3. Linear 상태 ID 조회

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: lin_api_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ workflowStates { nodes { id name } } }"}' \
  | python3 -m json.tool
```

조회한 ID를 `.env`의 `LINEAR_*_STATE_ID` 항목에 입력합니다.

### 4. cron 등록

```bash
crontab -e
# 아래 줄 추가:
*/5 * * * * /usr/bin/node /workspace/linear-pipeline/linear-monitor.js >> /workspace/linear-pipeline/logs/cron.log 2>&1
```

## 환경변수

| 항목 | 설명 |
|------|------|
| `LINEAR_API_KEY` | Linear API 키 |
| `LINEAR_WEBHOOK_SECRET` | Webhook 서명 검증용 시크릿 |
| `LINEAR_TODO_STATE_ID` | Todo 상태 ID |
| `LINEAR_PLAN_REVIEW_STATE_ID` | Plan Review 상태 ID |
| `LINEAR_DEVELOP_STATE_ID` | Develop 상태 ID |
| `LINEAR_REVIEW_STATE_ID` | Review 상태 ID |
| `LINEAR_REVIEWED_STATE_ID` | Reviewed 상태 ID |
| `LINEAR_DONE_STATE_ID` | Done 상태 ID |
| `GITHUB_TOKEN` | GitHub PAT (repo, pull_requests, workflow 권한) |
| `GITHUB_REPO` | 기본 GitHub 저장소 (예: `username/repo`) |
| `DEV_SERVER_URL` | 개발 서버 베이스 URL |
| `PROJECT_ROOT` | 로컬 프로젝트 루트 경로 |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook URL |
| `WEBHOOK_PORT` | Webhook 서버 포트 (기본: 3001) |

## 파일 구조

```
linear-pipeline/
├── linear-monitor.js        # Linear API 폴링 모니터 (cron 실행)
├── webhook-server.js        # Webhook 수신 서버 (선택)
├── skills/
│   ├── skill-02-todo-detect.md     # Todo → Plan Review
│   ├── skill-05-develop.md         # Develop → Review
│   └── skill-11-reviewed-merge.md  # Reviewed → Done
├── ref/
│   └── pipeline-guide.html  # 전체 프로세스 가이드
├── state/                   # 런타임 이슈 상태 (gitignore)
├── logs/                    # 실행 로그 (gitignore)
├── .env                     # 실제 환경변수 (gitignore)
└── .env.example             # 환경변수 템플릿
```

## NAS 배포 (Reviewed 완료 후)

```bash
# 최초 1회
git clone https://github.com/your-id/project-name.git
cd project-name
echo 'HOST_PORT=원하는포트번호' > .env
docker compose up -d --build   # Dockerfile로 로컬 빌드 후 실행

# 이후 업데이트 시
git pull origin main
docker compose up -d --build
```

## Slack 알림 채널

모든 알림은 `#claude_dev_automation` 채널로 전송됩니다.

| 상황 | 알림 |
|------|------|
| Todo → Plan Review | 📋 플랜 리뷰 요청 |
| 서버 시작 실패 | 🚨 개입 필요 알림 |
| Develop → Review | 🟢/🟠/🔴 개발 완료 + 보안 판정 |
| PR Merge 불가 | ⚠️ 수동 처리 요청 |
| Reviewed → Done | 🎉 개발 완료 (NAS 배포 명령어 포함) |
