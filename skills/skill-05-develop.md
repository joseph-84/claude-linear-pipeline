---
name: linear-develop
description: >
  Linear 이슈가 Develop 상태로 변경되면 GitHub repo 자동 생성(없는 경우),
  Feature Branch 생성, 코드 개발, 개발 서버 구동, PR 생성,
  Playwright E2E 테스트, 백엔드 테스트, 보안 점검(SAST/SCA/DAST),
  이슈 자동수정까지 전체 개발 워크플로우를 실행한다. (파이프라인 Step 5-6)
  "develop 감지", "feature branch", "PR 생성", "개발 시작",
  "테스트", "보안점검" 키워드에 반드시 사용하라.
---

# Skill: Develop (Step 5-6)

## 역할
Linear 이슈가 **Develop** 상태가 되면 자동으로 실행된다.
코드 개발부터 테스트·보안점검·자동수정까지 전 과정을 수행한 뒤
이상 없으면 **Review** 상태로 이동한다.

**재트리거 감지**: 스킬 시작 시 `TRIGGER` 환경변수와 `BRANCH_NAME` 환경변수를 확인한다.
`TRIGGER=comment` 이거나 `BRANCH_NAME` 이 비어있지 않으면 **Step 7 로 바로 이동**한다.
(사람이 개입 후 Linear 댓글을 남겨 재트리거한 경우이므로 코드 개발을 다시 하지 않는다.)

1. 이슈 및 프로젝트 정보 로드 (모든 댓글 포함)
2. GitHub repo 존재 확인 → 없으면 자동 생성 및 clone
3. 기술 스택 판단
4. 포트 자동 할당 (3001~3010)
5. Feature Branch 생성
6. 코드 개발
7. 개발 서버 구동 (자동 오류 수정 루프 — 성공할 때까지 반복)
8. Commit & Push
9. PR 생성
10. Playwright E2E 테스트 (자동수정 루프)
11. 백엔드 테스트 (자동수정 루프)
12. 보안 점검 SAST + SCA + DAST (HIGH 취약점 자동수정)
13. 수정사항 Commit & Push
14. 통합 리포트 Linear 댓글 등록
15. Linear 상태 → Review 변경
16. Slack 알림
17. 컨텍스트 저장

---

## 필수 환경변수
```
LINEAR_API_KEY
LINEAR_REVIEW_STATE_ID   (Linear의 "Review" 상태 ID)
GITHUB_TOKEN
GITHUB_REPO              (기본 저장소, 예: joseph-84/claude-linear-dev)
SLACK_WEBHOOK_URL
ISSUE_ID                 (linear-monitor.js 가 주입)
ISSUE_IDENTIFIER         (linear-monitor.js 가 주입)
ISSUE_TITLE              (linear-monitor.js 가 주입)
PROJECT_NAME             (linear-monitor.js 가 주입, 예: Privacy Policy)
PROJECT_SLUG             (linear-monitor.js 가 주입, 예: Privacy Policy)
REPO_NAME                (linear-monitor.js 가 주입, 예: Privacy-Policy)
PROJECT_DIR              (linear-monitor.js 가 주입, 예: /workspace/Privacy Policy)
```

---

## Step 1. 이슈 및 프로젝트 정보 로드

이슈의 제목, 설명, **모든 댓글**을 가져와서 Claude 가 전체 맥락을 파악한다.
댓글에는 플랜, 피드백, 수정 요청 등이 포함될 수 있으므로 모두 읽어야 한다.

```bash
STATE_FILE="/workspace/linear-pipeline/state/${ISSUE_ID}.json"

ISSUE_IDENTIFIER=$(jq -r '.identifier'  "$STATE_FILE")
ISSUE_TITLE=$(jq -r '.title'            "$STATE_FILE")
ISSUE_LABEL=$(jq -r '.label'            "$STATE_FILE")
PROJECT_NAME=$(jq -r '.projectName'     "$STATE_FILE")
PROJECT_SLUG=$(jq -r '.projectSlug'     "$STATE_FILE")
REPO_NAME=$(jq -r '.repoName'           "$STATE_FILE")
PROJECT_DIR=$(jq -r '.projectDir'       "$STATE_FILE")

GITHUB_USER=$(echo "$GITHUB_REPO" | cut -d'/' -f1)
FULL_REPO="${GITHUB_USER}/${REPO_NAME}"

echo "프로젝트: $PROJECT_NAME"
echo "GitHub repo: $FULL_REPO"
echo "로컬 경로: $PROJECT_DIR"

# 이슈 상세 정보 + 모든 댓글 조회
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"{ issue(id: \\\"$ISSUE_ID\\\") {
      title
      description
      comments {
        nodes {
          createdAt
          body
          user { name }
        }
      }
    } }\"
  }" > /tmp/issue_full.json

ISSUE_DESC=$(jq -r '.data.issue.description // "없음"' /tmp/issue_full.json)

# 모든 댓글을 시간순으로 하나의 텍스트로 합치기
ALL_COMMENTS=$(jq -r '
  .data.issue.comments.nodes[] |
  "---\n작성자: \(.user.name // "Unknown")\n시간: \(.createdAt)\n\n\(.body)\n"
' /tmp/issue_full.json 2>/dev/null || echo "댓글 없음")

COMMENT_COUNT=$(jq '.data.issue.comments.nodes | length' /tmp/issue_full.json 2>/dev/null || echo 0)

echo "=== 이슈 정보 ==="
echo "제목: $ISSUE_TITLE"
echo "설명: $ISSUE_DESC"
echo "댓글 수: $COMMENT_COUNT"
echo ""
echo "=== 전체 댓글 내용 ==="
echo "$ALL_COMMENTS"
echo "=================="
```

Claude 는 위 전체 댓글 내용을 읽고 아래 사항을 파악한다:
- 개발 플랜 (📋 로 시작하는 댓글)
- 플랜에 대한 피드백이나 수정 요청
- 추가 요구사항
- 주의사항

댓글 내용이 서로 상충되는 경우 **가장 최근 댓글을 우선**으로 한다.

---

## Step 2. GitHub repo 및 로컬 폴더 준비

프로젝트 폴더가 없으면 GitHub repo 를 생성하고 clone 한다.
이미 있으면 최신 상태로 pull 만 한다.

```bash
if [ ! -d "$PROJECT_DIR/.git" ]; then
  echo "신규 프로젝트 — GitHub repo 생성 및 clone"

  REPO_CHECK=$(curl -s -o /dev/null -w "%{http_code}" \
    "https://api.github.com/repos/${FULL_REPO}" \
    -H "Authorization: token $GITHUB_TOKEN")

  if [ "$REPO_CHECK" = "404" ]; then
    echo "GitHub repo 생성 중: $FULL_REPO"
    curl -s -X POST "https://api.github.com/user/repos" \
      -H "Authorization: token $GITHUB_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{
        \"name\": \"$REPO_NAME\",
        \"description\": \"$PROJECT_NAME — Claude Code 자동 생성\",
        \"private\": true,
        \"auto_init\": true
      }" | jq '.html_url'
    echo "GitHub repo 생성 완료"
    sleep 3

    # Workflow permissions: Read and write 설정
    curl -s -X PUT "https://api.github.com/repos/${FULL_REPO}/actions/permissions/workflow" \
      -H "Authorization: token $GITHUB_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"default_workflow_permissions": "write"}' | jq '.default_workflow_permissions'
    echo "✅ Workflow permissions: write 설정 완료"
  fi

  mkdir -p "$(dirname "$PROJECT_DIR")"
  git clone "https://${GITHUB_TOKEN}@github.com/${FULL_REPO}.git" "$PROJECT_DIR"
  echo "✅ clone 완료: $PROJECT_DIR"
else
  echo "기존 프로젝트 — 최신 상태로 pull"
  cd "$PROJECT_DIR"
  git checkout main
  git pull origin main
fi

cd "$PROJECT_DIR"
```

---

## Step 3. 기술 스택 판단

기존 프로젝트이면 현재 파일로 판단한다.
신규 프로젝트이면 이슈 제목, 설명, 댓글 전체 내용을 분석하여 판단한다.

판단 기준:
- "웹사이트", "사이트", "프론트", "UI", "페이지", "화면" 키워드 → **nextjs**
- "API", "서버", "백엔드", "REST", "endpoint" 키워드 → **express**
- "크롤링", "스크래핑", "자동화", "데이터 수집" 키워드 → **python**
- 명확하지 않으면 → **nextjs** (기본값)

```bash
if [ -f "$PROJECT_DIR/package.json" ]; then
  if grep -q '"next"' "$PROJECT_DIR/package.json"; then
    STACK="nextjs"
  else
    STACK="express"
  fi
elif [ -f "$PROJECT_DIR/requirements.txt" ] || [ -f "$PROJECT_DIR/pyproject.toml" ]; then
  STACK="python"
else
  # Claude 가 이슈 내용과 댓글 전체를 분석하여 판단 후 아래 변수에 할당
  STACK="nextjs"
fi

echo "선택된 스택: $STACK"
```

---

## Step 4. 포트 및 URL 확인

포트는 linear-monitor.js 가 프로젝트별로 고정 할당하여 환경변수로 주입한다.
같은 프로젝트는 항상 동일한 포트를 사용한다. (_port_map.json 에 영구 저장)

```bash
# linear-monitor.js 에서 주입된 값 사용
echo "✅ 프로젝트 포트: $PORT_INTERNAL"
echo "✅ 개발 URL: $DEV_URL"

if [ -z "$PORT_INTERNAL" ]; then
  echo "❌ 포트 정보 없음"
  exit 1
fi
```

---

## Step 5. Feature Branch 생성

```bash
cd "$PROJECT_DIR"

BRANCH_SUFFIX=$(echo "$ISSUE_TITLE" | tr '[:upper:]' '[:lower:]' \
  | sed 's/[^a-z0-9 ]//g' | tr ' ' '-' | cut -c1-40)
BRANCH_NAME="feature/${ISSUE_IDENTIFIER}-${BRANCH_SUFFIX}"

git checkout main
git pull origin main
git checkout -b "$BRANCH_NAME"

echo "✅ Branch: $BRANCH_NAME"

curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"mutation {
      commentCreate(input: {
        issueId: \\\"$ISSUE_ID\\\",
        body: \\\"🌿 Branch: \`$BRANCH_NAME\`\\\\n📁 경로: \`$PROJECT_DIR\`\\\\n🔌 포트: $PORT_INTERNAL\\\"
      }) { success }
    }\"
  }"
```

---

## Step 6. 코드 개발

신규 프로젝트이면 스택에 맞게 프로젝트를 생성한다.
기존 프로젝트이면 이슈 요구사항에 맞게 코드를 수정/추가한다.

**중요: Step 1 에서 읽은 이슈 설명과 모든 댓글 내용을 반드시 반영한다.**
특히 플랜 댓글의 구현 전략과 피드백 댓글의 수정 요청을 우선 적용한다.

### 신규 프로젝트 — Next.js:
```bash
cd "$PROJECT_DIR"
npx create-next-app@latest . \
  --typescript --tailwind --eslint --app \
  --no-src-dir --import-alias "@/*" --yes
```

### 신규 프로젝트 — Express:
```bash
cd "$PROJECT_DIR"
npm init -y
npm install express cors dotenv
mkdir -p src
```

### 신규 프로젝트 — Python:
```bash
cd "$PROJECT_DIR"
python3 -m venv venv
source venv/bin/activate
pip install flask gunicorn requests beautifulsoup4
```

코드 작성 원칙:
- 이슈 설명과 모든 댓글 내용을 바탕으로 실제 기능 완성도 있게 구현
- 가장 최근 댓글의 피드백/수정 요청을 우선 반영
- 환경변수·시크릿 하드코딩 금지
- 포트는 환경변수 PORT 로 받되 기본값은 $PORT_INTERNAL 사용
- README.md 에 실행 방법 및 기능 설명 작성

---

## Step 7. 개발 서버 구동 (자동 오류 수정 루프)

서버가 정상 응답할 때까지 오류를 분석·수정하며 무제한 재시도한다.
Claude 가 자체 해결할 수 없는 경우에만 Linear 댓글 + Slack 알림 후 중단한다.

### 7-1. 초기 준비

```bash
cd "$PROJECT_DIR"

PID_FILE="/workspace/linear-pipeline/state/port-${PORT_INTERNAL}.pid"
LOG_FILE="/workspace/linear-pipeline/logs/${ISSUE_IDENTIFIER}-server.log"

# 기존 프로세스 종료
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  kill "$OLD_PID" 2>/dev/null || true
  rm "$PID_FILE"
  sleep 2
fi

# 포트 점유 프로세스 강제 종료
fuser -k ${PORT_INTERNAL}/tcp 2>/dev/null || true
sleep 1
```

### 7-2. 서버 시작 함수 (매 시도마다 실행)

```bash
start_server() {
  cd "$PROJECT_DIR"
  > "$LOG_FILE"   # 로그 초기화 (시도마다 새로 기록)
  case "$STACK" in
    "nextjs")
      npm run build >> "$LOG_FILE" 2>&1
      BUILD_EXIT=$?
      if [ $BUILD_EXIT -ne 0 ]; then
        echo "BUILD_FAILED"
        return 1
      fi
      PORT=$PORT_INTERNAL nohup npm start >> "$LOG_FILE" 2>&1 &
      ;;
    "express")
      PORT=$PORT_INTERNAL nohup node src/index.js >> "$LOG_FILE" 2>&1 &
      ;;
    "python")
      source venv/bin/activate
      nohup gunicorn app:app --bind "0.0.0.0:$PORT_INTERNAL" >> "$LOG_FILE" 2>&1 &
      ;;
  esac
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PID_FILE"
  echo "$SERVER_PID"
}
```

### 7-3. 응답 대기 (매 시도마다 최대 90초)

```bash
wait_for_server() {
  for i in $(seq 1 90); do
    sleep 1
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      "http://localhost:${PORT_INTERNAL}" --max-time 3 2>/dev/null || echo "000")
    if [ "$HTTP_STATUS" != "000" ] && [ "$HTTP_STATUS" != "" ]; then
      echo "✅ 서버 응답: HTTP $HTTP_STATUS (${i}초)"
      return 0
    fi
  done
  return 1
}
```

### 7-4. 오류 분석 및 자동 수정 루프

아래 루프를 **서버가 성공할 때까지** 반복한다. 시도 횟수에 제한 없음.

```bash
ATTEMPT=0

while true; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "=== 서버 시작 시도 #${ATTEMPT} ==="

  start_server
  if wait_for_server; then
    echo "✅ 서버 정상 기동 (시도 #${ATTEMPT})"
    break
  fi

  # 실패: 로그 분석
  ERROR_LOG=$(tail -80 "$LOG_FILE" 2>/dev/null || echo "로그 없음")
  echo "--- 오류 로그 (최근 80줄) ---"
  echo "$ERROR_LOG"
  echo "----------------------------"
```

Claude 는 위 로그를 읽고 아래 기준으로 판단한다.

**Claude 가 자체 수정 가능한 오류 → 수정 후 루프 재시작**

| 오류 패턴 | 수정 방법 |
|-----------|-----------|
| `Cannot find module`, `Module not found` | `npm install` 또는 누락 패키지 직접 설치 |
| `EADDRINUSE` (포트 충돌) | `fuser -k ${PORT_INTERNAL}/tcp` 후 재시도 |
| TypeScript/ESLint 빌드 오류 | 코드 파일 수정 |
| `ModuleNotFoundError` (Python) | `pip install <패키지>` |
| `.env` 파일 없거나 값 오류 (시크릿 불필요한 경우) | `.env` 파일 생성 또는 수정 |
| 파일/디렉토리 없음 | 파일 생성 |
| `EACCES` 권한 오류 | `chmod` 적용 |
| next.config.js 설정 오류 | 설정 파일 수정 |
| 동일 오류 반복 시 | 다른 접근 방법 시도 (포트 변경, 실행 방식 변경 등) |

수정 작업을 마친 뒤 `continue` 로 루프를 반복한다.

**즉시 중단하고 사람에게 전달해야 하는 경우 → 아래 7-5 실행 후 `exit 1`**

- API 키·DB 비밀번호·외부 서비스 자격증명이 없어서 연결 불가
- 외부 DB/서버가 내려가 있거나 Claude 가 접근 권한 없음
- `apt install` 등 시스템 패키지 설치가 필요한 경우 (root 권한 필요)
- 네트워크·DNS·포트포워딩 등 인프라 레벨 문제
- 정확히 동일한 오류가 5회 이상 반복되어 더 이상 새로운 수정 방법이 없는 경우

```bash
done  # while 루프 끝
```

### 7-5. 사람 개입 필요 시 알림 (사람이 해결 불가 오류에만 실행)

```bash
# HUMAN_REASON 변수에 원인 요약을 한국어로 작성한 뒤 아래 실행

ERROR_DETAIL=$(tail -80 "$LOG_FILE" 2>/dev/null | head -c 3000)

HUMAN_COMMENT="## ⚠️ 서버 시작 실패 — 사람의 개입 필요

### 원인
${HUMAN_REASON}

### 시도 횟수
${ATTEMPT}회 시도 후 자동 해결 불가 판단

### 오류 로그
\`\`\`
${ERROR_DETAIL}
\`\`\`

### 재시도 방법
문제를 해결한 뒤 **이 이슈에 댓글을 남기면** 자동으로 재시도합니다.
(이슈는 Develop 상태를 유지하고 있습니다.)"

# Linear 댓글 등록
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"mutation {
      commentCreate(input: {
        issueId: \\\"$ISSUE_ID\\\",
        body: $(echo "$HUMAN_COMMENT" | jq -Rs .)
      }) { success }
    }\"
  }"

# Slack 알림
LINEAR_ISSUE_URL="https://linear.app/issue/$ISSUE_IDENTIFIER"

curl -s -X POST "$SLACK_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"channel\": \"#claude_dev_automation\",
    \"blocks\": [
      {
        \"type\": \"header\",
        \"text\": {\"type\": \"plain_text\", \"text\": \"🚨 서버 시작 실패 — 개입 필요\"}
      },
      {
        \"type\": \"section\",
        \"fields\": [
          {\"type\": \"mrkdwn\", \"text\": \"*이슈*\\n<${LINEAR_ISSUE_URL}|[${ISSUE_IDENTIFIER}] ${ISSUE_TITLE}>\"},
          {\"type\": \"mrkdwn\", \"text\": \"*프로젝트*\\n${PROJECT_NAME}\"},
          {\"type\": \"mrkdwn\", \"text\": \"*시도 횟수*\\n${ATTEMPT}회\"},
          {\"type\": \"mrkdwn\", \"text\": \"*원인*\\n${HUMAN_REASON}\"}
        ]
      },
      {
        \"type\": \"context\",
        \"elements\": [{\"type\": \"mrkdwn\", \"text\": \"문제 해결 후 이슈에 댓글을 남기면 자동으로 재시도합니다.\"}]
      },
      {
        \"type\": \"actions\",
        \"elements\": [
          {
            \"type\": \"button\",
            \"text\": {\"type\": \"plain_text\", \"text\": \"이슈 보기\"},
            \"url\": \"${LINEAR_ISSUE_URL}\",
            \"style\": \"primary\"
          }
        ]
      }
    ]
  }"

echo "❌ 사람 개입 필요 알림 완료 — 스킬 중단"
exit 1
```

---

## Step 8. Commit & Push

```bash
cd "$PROJECT_DIR"

git add -A
COMMIT_TYPE=$(echo "$ISSUE_LABEL" | tr '[:upper:]' '[:lower:]')
COMMIT_MSG="${COMMIT_TYPE}: ${ISSUE_IDENTIFIER} ${ISSUE_TITLE}"
git commit -m "$COMMIT_MSG"
git push origin "$BRANCH_NAME"

echo "✅ Commit & Push: $COMMIT_MSG"
```

---

## Step 9. PR 생성

```bash
cd "$PROJECT_DIR"

PR_BODY="## 개요
${ISSUE_TITLE}

## Linear 이슈
https://linear.app/issue/${ISSUE_IDENTIFIER}

## 개발 서버
${DEV_URL}

## 반영된 댓글/피드백
총 ${COMMENT_COUNT}개의 댓글 내용을 반영하여 개발하였습니다.

## 변경 내역
$(git log main..HEAD --oneline 2>/dev/null || echo '신규 프로젝트')

## 체크리스트
- [ ] 기능 구현 완료
- [ ] 댓글 피드백 반영 확인
- [ ] 개발 서버 동작 확인"

PR_RESPONSE=$(gh pr create \
  --title "[$ISSUE_IDENTIFIER] $ISSUE_TITLE" \
  --body "$PR_BODY" \
  --base main \
  --head "$BRANCH_NAME" \
  --repo "$FULL_REPO" 2>&1)

PR_URL=$(echo "$PR_RESPONSE" | grep "https://github.com" | tail -1)
PR_NUMBER=$(echo "$PR_URL" | grep -o '[0-9]*$')

echo "✅ PR 생성: $PR_URL"
```

---

## Step 10. Playwright E2E 테스트 (프론트엔드) + 자동수정 루프

nextjs / react 계열이 아닌 경우(python, express API 전용 등) 이 Step 은 건너뛴다.

```bash
cd "$PROJECT_DIR"

if [ "$STACK" = "nextjs" ] || [ "$STACK" = "react" ]; then

  PLAYWRIGHT_ATTEMPTS=0
  PLAYWRIGHT_MAX=5

  # Playwright 설치
  if ! npx playwright --version &>/dev/null 2>&1; then
    npm install -D @playwright/test
  fi
  npx playwright install chromium 2>/dev/null || true

  # playwright.config.ts 없으면 생성
  if [ ! -f "playwright.config.ts" ] && [ ! -f "playwright.config.js" ]; then
    cat > playwright.config.ts << EOF
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: 'http://localhost:${PORT_INTERNAL}',
    headless: true,
    screenshot: 'only-on-failure',
  },
});
EOF
  fi

  # e2e 테스트 파일 없으면 Claude 가 생성
  # Claude 는 pages/, app/, src/ 구조를 분석해 주요 페이지의 기본 E2E 테스트를 작성한다.
  # 최소 기준: 메인 페이지 로드 확인, 콘솔 에러 없음, 핵심 UI 요소 존재 확인
  if [ ! -d "e2e" ] || [ -z "$(ls e2e/*.spec.* 2>/dev/null)" ]; then
    mkdir -p e2e
    echo "⚠️ E2E 테스트 없음 — 앱 구조 분석 후 기본 테스트 생성"
  fi

  while true; do
    PLAYWRIGHT_ATTEMPTS=$((PLAYWRIGHT_ATTEMPTS + 1))
    echo "=== Playwright 테스트 시도 #${PLAYWRIGHT_ATTEMPTS} ==="

    PLAYWRIGHT_LOG="/tmp/playwright_${PLAYWRIGHT_ATTEMPTS}.log"
    BASE_URL="http://localhost:${PORT_INTERNAL}" npx playwright test --reporter=line 2>&1 | tee "$PLAYWRIGHT_LOG"
    PLAYWRIGHT_EXIT=${PIPESTATUS[0]}

    if [ "$PLAYWRIGHT_EXIT" -eq 0 ]; then
      echo "✅ Playwright 테스트 통과"
      PLAYWRIGHT_RESULT="✅ 통과"
      break
    fi

    if [ "$PLAYWRIGHT_ATTEMPTS" -ge "$PLAYWRIGHT_MAX" ]; then
      echo "❌ Playwright ${PLAYWRIGHT_MAX}회 실패 — 사람 개입 필요"
      HUMAN_REASON="Playwright E2E 테스트 ${PLAYWRIGHT_MAX}회 시도 후 해결 불가"
      # Step 7-5 와 동일한 패턴으로 Linear 댓글 + Slack 알림 후 중단
      exit 1
    fi

    # Claude 가 실패 로그를 분석하고 코드를 수정한다
    # - 컴포넌트 렌더링 오류 → 해당 컴포넌트 파일 수정
    # - 라우팅/셀렉터 불일치 → 앱 코드가 맞으면 테스트 셀렉터 수정
    # - 빌드 오류 → 소스 파일 수정 후 재빌드
    echo "--- 실패 로그 분석 중 ---"
    tail -50 "$PLAYWRIGHT_LOG"
    # 수정 후 서버 재시작
    start_server
    wait_for_server
  done

else
  PLAYWRIGHT_RESULT="⏭️ 해당 없음 (스택: $STACK)"
  echo "ℹ️ Playwright 스킵 (프론트엔드 스택 아님)"
fi
```

---

## Step 11. 백엔드 테스트 + 자동수정 루프

```bash
cd "$PROJECT_DIR"

BACKEND_ATTEMPTS=0
BACKEND_MAX=5
BACKEND_RESULT=""

# 테스트 명령어 결정
case "$STACK" in
  "nextjs"|"express")
    if ls **/*.test.{js,ts} **/*.spec.{js,ts} 2>/dev/null | grep -qv "e2e\|playwright"; then
      TEST_CMD="npx jest --testPathIgnorePatterns=e2e --passWithNoTests"
    else
      TEST_CMD=""
    fi
    ;;
  "python")
    if find . -name "test_*.py" -o -name "*_test.py" 2>/dev/null | grep -q .; then
      TEST_CMD="python -m pytest -v"
    else
      TEST_CMD=""
    fi
    ;;
esac

if [ -z "$TEST_CMD" ]; then
  echo "ℹ️ 단위 테스트 파일 없음 — 핵심 API 엔드포인트 curl 점검 실행"
  # Claude 는 routes/api 파일을 읽고 주요 엔드포인트를 curl 로 점검한다
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT_INTERNAL}" --max-time 10)
  echo "메인 엔드포인트 응답: HTTP $HTTP_STATUS"
  BACKEND_RESULT="✅ API 기본 응답 확인 (HTTP $HTTP_STATUS)"
else
  while true; do
    BACKEND_ATTEMPTS=$((BACKEND_ATTEMPTS + 1))
    echo "=== 백엔드 테스트 시도 #${BACKEND_ATTEMPTS} ==="

    BACKEND_LOG="/tmp/backend_${BACKEND_ATTEMPTS}.log"
    eval "$TEST_CMD" 2>&1 | tee "$BACKEND_LOG"
    BACKEND_EXIT=${PIPESTATUS[0]}

    if [ "$BACKEND_EXIT" -eq 0 ]; then
      echo "✅ 백엔드 테스트 통과"
      BACKEND_RESULT="✅ 통과"
      break
    fi

    if [ "$BACKEND_ATTEMPTS" -ge "$BACKEND_MAX" ]; then
      echo "❌ 백엔드 테스트 ${BACKEND_MAX}회 실패 — 사람 개입 필요"
      HUMAN_REASON="백엔드 테스트 ${BACKEND_MAX}회 시도 후 해결 불가"
      exit 1
    fi

    # Claude 가 실패 로그를 분석하고 테스트 대상 코드를 수정한다
    echo "--- 실패 로그 분석 중 ---"
    tail -50 "$BACKEND_LOG"
  done
fi
```

---

## Step 12. 보안 점검 (SAST + SCA + DAST) + HIGH 취약점 자동수정

```bash
cd "$PROJECT_DIR"

# --- SAST (Semgrep) ---
if ! command -v semgrep &>/dev/null; then
  pip3 install semgrep --break-system-packages -q
fi

semgrep scan \
  --config "p/owasp-top-ten" \
  --config "p/cwe-top-25" \
  --config "p/secrets" \
  --json --output /tmp/semgrep_result.json \
  "$PROJECT_DIR" 2>/dev/null

SAST_HIGH=$(jq   '[.results[] | select(.extra.severity == "ERROR")]   | length' /tmp/semgrep_result.json 2>/dev/null || echo 0)
SAST_MEDIUM=$(jq '[.results[] | select(.extra.severity == "WARNING")] | length' /tmp/semgrep_result.json 2>/dev/null || echo 0)
SAST_LOW=$(jq    '[.results[] | select(.extra.severity == "INFO")]    | length' /tmp/semgrep_result.json 2>/dev/null || echo 0)

echo "SAST — 상: $SAST_HIGH / 중: $SAST_MEDIUM / 하: $SAST_LOW"

# HIGH 취약점 자동수정 (최대 3회)
SECURITY_FIX_ATTEMPTS=0
while [ "$SAST_HIGH" -gt 0 ] && [ "$SECURITY_FIX_ATTEMPTS" -lt 3 ]; do
  SECURITY_FIX_ATTEMPTS=$((SECURITY_FIX_ATTEMPTS + 1))
  echo "🔧 HIGH 취약점 자동수정 시도 #${SECURITY_FIX_ATTEMPTS} (${SAST_HIGH}건)"

  # Claude 가 Semgrep 결과의 파일:라인 정보를 바탕으로 각 취약점을 수정한다
  # SQL Injection → Parameterized Query / XSS → 출력 이스케이프 / Hardcoded Secret → 환경변수
  jq -r '.results[] | select(.extra.severity == "ERROR") |
    "[\(.check_id)] \(.path):\(.start.line) — \(.extra.message)"
  ' /tmp/semgrep_result.json | head -20

  # 수정 후 재스캔
  semgrep scan \
    --config "p/owasp-top-ten" --config "p/cwe-top-25" --config "p/secrets" \
    --json --output /tmp/semgrep_result.json "$PROJECT_DIR" 2>/dev/null
  SAST_HIGH=$(jq '[.results[] | select(.extra.severity == "ERROR")] | length' /tmp/semgrep_result.json 2>/dev/null || echo 0)
  echo "재스캔 — 상: $SAST_HIGH"
done

# --- SCA (의존성 취약점) ---
SCA_CRITICAL=0; SCA_HIGH=0
if [ -f "package.json" ]; then
  npm audit --json > /tmp/sca_result.json 2>/dev/null || true
  SCA_CRITICAL=$(jq '.metadata.vulnerabilities.critical // 0' /tmp/sca_result.json 2>/dev/null || echo 0)
  SCA_HIGH=$(jq     '.metadata.vulnerabilities.high     // 0' /tmp/sca_result.json 2>/dev/null || echo 0)
  if [ "$((SCA_CRITICAL + SCA_HIGH))" -gt 0 ]; then
    npm audit fix 2>/dev/null || true
    npm audit --json > /tmp/sca_result.json 2>/dev/null || true
    SCA_CRITICAL=$(jq '.metadata.vulnerabilities.critical // 0' /tmp/sca_result.json 2>/dev/null || echo 0)
  fi
elif [ -f "requirements.txt" ]; then
  pip3 install pip-audit --break-system-packages -q
  pip-audit -r requirements.txt --format json > /tmp/sca_result.json 2>/dev/null || true
fi

# --- DAST (Nuclei) ---
DAST_HIGH=0; DAST_MEDIUM=0; DAST_LOW=0; DAST_STATUS="스킵"

NUCLEI_BIN="/tmp/nuclei"
if [ ! -x "$NUCLEI_BIN" ]; then
  echo "Nuclei 다운로드 중..."
  wget -q "https://github.com/projectdiscovery/nuclei/releases/latest/download/nuclei_linux_amd64.zip" \
    -O /tmp/nuclei.zip \
    && unzip -q /tmp/nuclei.zip -d /tmp/ \
    && chmod +x "$NUCLEI_BIN"
fi

if [ -x "$NUCLEI_BIN" ]; then
  echo "=== DAST: Nuclei ==="
  "$NUCLEI_BIN" \
    -u "http://localhost:${PORT_INTERNAL}" \
    -tags "owasp,cve,exposure,misconfig" \
    -severity "critical,high,medium,low" \
    -jsonl -o /tmp/nuclei_report.jsonl \
    -timeout 10 -retries 1 -silent 2>&1 | tail -5

  if [ -f /tmp/nuclei_report.jsonl ]; then
    DAST_HIGH=$(grep   -c '"severity":"critical"\|"severity":"high"'   /tmp/nuclei_report.jsonl 2>/dev/null || echo 0)
    DAST_MEDIUM=$(grep -c '"severity":"medium"'                        /tmp/nuclei_report.jsonl 2>/dev/null || echo 0)
    DAST_LOW=$(grep    -c '"severity":"low"\|"severity":"info"'        /tmp/nuclei_report.jsonl 2>/dev/null || echo 0)
    DAST_STATUS="Nuclei 완료"
  else
    DAST_STATUS="Nuclei 완료 (발견 없음)"
  fi
else
  echo "❌ Nuclei 다운로드 실패 — DAST 스킵"
  DAST_STATUS="DAST 스킵 (Nuclei 설치 실패)"
fi

echo "DAST: $DAST_STATUS (상: $DAST_HIGH / 중: $DAST_MEDIUM / 하: $DAST_LOW)"

# 종합 위험도
TOTAL_HIGH=$((SAST_HIGH + DAST_HIGH + SCA_CRITICAL))
TOTAL_MEDIUM=$((SAST_MEDIUM + DAST_MEDIUM + SCA_HIGH))
if   [ "$TOTAL_HIGH"   -gt 0 ]; then OVERALL_RISK="🔴 상 (HIGH)"
elif [ "$TOTAL_MEDIUM" -gt 2 ]; then OVERALL_RISK="🟠 중 (MEDIUM)"
else                                  OVERALL_RISK="🟢 양호"
fi

echo "보안 점검 완료: $OVERALL_RISK"
```

---

## Step 13. 자동수정 사항 Commit & Push

```bash
cd "$PROJECT_DIR"

if ! git diff --quiet || ! git diff --cached --quiet; then
  git add -A
  git commit -m "fix: $ISSUE_IDENTIFIER 테스트·보안 자동수정"
  git push origin "$BRANCH_NAME"
  echo "✅ 자동수정 커밋 완료"
else
  echo "ℹ️ 추가 수정사항 없음"
fi
```

---

## Step 14. 통합 리포트 Linear 댓글 등록

```bash
REPORT_COMMENT="## 🔍 개발·테스트·보안 완료 보고

### 개요
| 항목 | 내용 |
|------|------|
| 이슈 | ${ISSUE_IDENTIFIER}: ${ISSUE_TITLE} |
| PR | ${PR_URL} |
| 개발 서버 | ${DEV_URL} |
| 스택 | ${STACK} |
| 반영 댓글 | ${COMMENT_COUNT}건 |
| 완료 일시 | $(date '+%Y-%m-%d %H:%M') |

---

### 테스트 결과
| 항목 | 결과 |
|------|------|
| Playwright E2E | ${PLAYWRIGHT_RESULT:-✅ 통과} |
| 백엔드 테스트 | ${BACKEND_RESULT:-✅ 통과} |

### 보안 점검 결과
| 구분 | 상(High) | 중(Medium) | 하(Low) |
|------|----------|------------|---------|
| SAST (Semgrep) | ${SAST_HIGH} | ${SAST_MEDIUM} | ${SAST_LOW} |
| DAST (Nuclei) | ${DAST_HIGH} | ${DAST_MEDIUM} | ${DAST_LOW} |
| SCA | ${SCA_CRITICAL} | ${SCA_HIGH} | — |
| **종합** | **$TOTAL_HIGH** | **$TOTAL_MEDIUM** | — |

**종합 판정:** ${OVERALL_RISK}
**DAST:** ${DAST_STATUS}

---

### 변경된 파일
$(git diff --name-only main..HEAD 2>/dev/null | sed 's/^/- /' || echo '- 신규 프로젝트')

### 검토 요청
PR 내용과 위 리포트를 확인 후 Linear 이슈를 **Reviewed** 로 이동해주세요."

REPORT_RESPONSE=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"mutation {
      commentCreate(input: {
        issueId: \\\"$ISSUE_ID\\\",
        body: $(echo "$REPORT_COMMENT" | jq -Rs .)
      }) { success comment { id url } }
    }\"
  }")

REPORT_COMMENT_URL=$(echo "$REPORT_RESPONSE" | jq -r '.data.commentCreate.comment.url')
echo "✅ 통합 리포트 등록: $REPORT_COMMENT_URL"
```

---

## Step 15. Linear 이슈 상태를 Review 로 변경

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"mutation {
      issueUpdate(id: \\\"$ISSUE_ID\\\", input: {
        stateId: \\\"$LINEAR_REVIEW_STATE_ID\\\"
      }) { success }
    }\"
  }" | jq '.data.issueUpdate.success'

echo "✅ Linear 상태: Develop → Review"
```

---

## Step 16. Slack 알림 전송

```bash
LINEAR_ISSUE_URL="https://linear.app/issue/$ISSUE_IDENTIFIER"

if   [ "$TOTAL_HIGH"   -gt 0 ]; then RISK_EMOJI="🔴"
elif [ "$TOTAL_MEDIUM" -gt 2 ]; then RISK_EMOJI="🟠"
else                                  RISK_EMOJI="🟢"; fi

curl -s -X POST "$SLACK_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"channel\": \"#claude_dev_automation\",
    \"blocks\": [
      {
        \"type\": \"header\",
        \"text\": {\"type\": \"plain_text\", \"text\": \"$RISK_EMOJI 개발 완료 — 리뷰 요청\"}
      },
      {
        \"type\": \"section\",
        \"fields\": [
          {\"type\": \"mrkdwn\", \"text\": \"*이슈*\\n<$LINEAR_ISSUE_URL|[$ISSUE_IDENTIFIER] $ISSUE_TITLE>\"},
          {\"type\": \"mrkdwn\", \"text\": \"*보안 판정*\\n${OVERALL_RISK}\"},
          {\"type\": \"mrkdwn\", \"text\": \"*E2E 테스트*\\n${PLAYWRIGHT_RESULT:-✅ 통과}\"},
          {\"type\": \"mrkdwn\", \"text\": \"*백엔드 테스트*\\n${BACKEND_RESULT:-✅ 통과}\"},
          {\"type\": \"mrkdwn\", \"text\": \"*개발 서버*\\n<$DEV_URL|$DEV_URL>\"},
          {\"type\": \"mrkdwn\", \"text\": \"*스택*\\n$STACK (포트: $PORT_INTERNAL)\"}
        ]
      },
      {
        \"type\": \"context\",
        \"elements\": [{\"type\": \"mrkdwn\", \"text\": \"PR과 리포트를 검토한 뒤 이슈를 Reviewed로 이동해주세요.\"}]
      },
      {
        \"type\": \"actions\",
        \"elements\": [
          {
            \"type\": \"button\",
            \"text\": {\"type\": \"plain_text\", \"text\": \"리포트 보기\"},
            \"url\": \"$REPORT_COMMENT_URL\",
            \"style\": \"primary\"
          },
          {
            \"type\": \"button\",
            \"text\": {\"type\": \"plain_text\", \"text\": \"개발 서버\"},
            \"url\": \"$DEV_URL\"
          },
          {
            \"type\": \"button\",
            \"text\": {\"type\": \"plain_text\", \"text\": \"PR 보기\"},
            \"url\": \"$PR_URL\"
          }
        ]
      }
    ]
  }"
```

---

## Step 17. 컨텍스트 저장

```bash
STATE_FILE="/workspace/linear-pipeline/state/${ISSUE_ID}.json"
EXISTING=$(cat "$STATE_FILE" 2>/dev/null || echo '{}')

echo "$EXISTING" | jq \
  --arg branch     "$BRANCH_NAME" \
  --arg prUrl      "$PR_URL" \
  --argjson prNum  "${PR_NUMBER:-0}" \
  --arg reportUrl  "$REPORT_COMMENT_URL" \
  --arg risk       "$OVERALL_RISK" \
  --arg stack      "$STACK" \
  --argjson port   "$PORT_INTERNAL" \
  --arg devUrl     "$DEV_URL" \
  --arg fullRepo   "$FULL_REPO" \
  '. + {
    branchName:       $branch,
    prUrl:            $prUrl,
    prNumber:         $prNum,
    reportCommentUrl: $reportUrl,
    overallRisk:      $risk,
    stack:            $stack,
    port:             $port,
    devUrl:           $devUrl,
    fullRepo:         $fullRepo
  }' > "$STATE_FILE"

# 완료 마커 기록 (중복 실행 방지)
EXISTING=$(cat "$STATE_FILE")
echo "$EXISTING" | jq --arg s "$CURRENT_STATE" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '. + {lastCompletedState: $s, lastCompletedAt: $t}' > "$STATE_FILE"
echo "✅ 완료"
```

---

## 오류 처리

| 상황 | 처리 |
|------|------|
| 포트 모두 사용 중 | Slack 알림 후 중단 |
| GitHub repo 생성 실패 | Slack 에러 알림 후 중단 |
| 서버 미응답 | 로그 기록 후 자동수정 루프 재시도 |
| PR 생성 실패 | Branch 유지, Slack 에러 알림 |
| Playwright 5회 실패 | Linear 댓글 + Slack 사람 개입 요청 후 중단 |
| 백엔드 테스트 5회 실패 | Linear 댓글 + Slack 사람 개입 요청 후 중단 |
| SAST HIGH 3회 수정 후 잔존 | 리포트에 미해결 항목 표기 후 Review 진행 |
| DAST Docker 미설치 | curl 기본 점검으로 대체 |