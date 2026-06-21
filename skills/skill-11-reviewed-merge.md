---
name: linear-reviewed-merge
description: >
  Linear 이슈가 Reviewed 상태로 변경되면 PR Merge, Dockerfile 생성,
  Linear Done 처리, Slack 완료 알림을 순서대로 실행한다. (파이프라인 Step 11-12)
  "reviewed 감지", "merge", "dockerfile 생성", "done 처리", "완료 알림" 키워드에 반드시 사용하라.
---

# Skill: Reviewed → Merge & Dockerfile & Done (Step 11-12)

## 역할
Linear 이슈가 **Reviewed** 상태가 되면 자동으로 실행된다.
PR Squash Merge → Feature Branch 삭제 → Dockerfile 생성 및 Commit →
Linear 이슈 Done 처리 → Slack 완료 알림 순으로 진행한다.

---

## 필수 환경변수
```
LINEAR_API_KEY
LINEAR_DONE_STATE_ID
GITHUB_TOKEN
GITHUB_REPO
SLACK_WEBHOOK_URL
ISSUE_ID             (webhook-server.js 가 주입)
ISSUE_IDENTIFIER     (webhook-server.js 가 주입)
ISSUE_TITLE          (webhook-server.js 가 주입)
```

---

## Step 1. 컨텍스트 로드

```bash
STATE_FILE="/workspace/linear-pipeline/state/${ISSUE_ID}.json"

ISSUE_IDENTIFIER=$(jq -r '.identifier' "$STATE_FILE")
ISSUE_TITLE=$(jq -r '.title'           "$STATE_FILE")
BRANCH_NAME=$(jq -r '.branchName'      "$STATE_FILE")
PR_NUMBER=$(jq -r '.prNumber'          "$STATE_FILE")
PR_URL=$(jq -r '.prUrl'                "$STATE_FILE")
FULL_REPO=$(jq -r '.fullRepo // empty' "$STATE_FILE")
FULL_REPO="${FULL_REPO:-$GITHUB_REPO}"

echo "Merge 대상 PR: #$PR_NUMBER ($PR_URL)"
echo "대상 repo: $FULL_REPO"
```

---

## Step 2. PR Merge 전 상태 확인

```bash
PR_INFO=$(curl -s \
  "https://api.github.com/repos/$FULL_REPO/pulls/$PR_NUMBER" \
  -H "Authorization: token $GITHUB_TOKEN")

PR_MERGEABLE=$(echo "$PR_INFO"   | jq -r '.mergeable')
MERGE_STATE=$(echo "$PR_INFO"    | jq -r '.mergeable_state')

echo "Mergeable: $PR_MERGEABLE / 상태: $MERGE_STATE"

if [ "$PR_MERGEABLE" != "true" ]; then
  echo "❌ Merge 불가 — 상태: $MERGE_STATE"

  # Slack 에 수동 처리 요청
  LINEAR_ISSUE_URL="https://linear.app/issue/$ISSUE_IDENTIFIER"
  curl -s -X POST "$SLACK_WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "{
      \"channel\": \"#claude_dev_automation\",
      \"blocks\": [
        {
          \"type\": \"header\",
          \"text\": {\"type\": \"plain_text\", \"text\": \"⚠️ PR Merge 불가\"}
        },
        {
          \"type\": \"section\",
          \"fields\": [
            {\"type\": \"mrkdwn\", \"text\": \"*이슈*\\n<$LINEAR_ISSUE_URL|[$ISSUE_IDENTIFIER] $ISSUE_TITLE>\"},
            {\"type\": \"mrkdwn\", \"text\": \"*Merge 상태*\\n$MERGE_STATE\"}
          ]
        },
        {
          \"type\": \"context\",
          \"elements\": [{\"type\": \"mrkdwn\", \"text\": \"수동으로 Merge한 뒤 이슈 상태를 업데이트해주세요.\"}]
        },
        {
          \"type\": \"actions\",
          \"elements\": [
            {
              \"type\": \"button\",
              \"text\": {\"type\": \"plain_text\", \"text\": \"PR 보기\"},
              \"url\": \"$PR_URL\",
              \"style\": \"primary\"
            }
          ]
        }
      ]
    }"
  exit 1
fi
```

---

## Step 3. PR Squash Merge

```bash
MERGE_RESPONSE=$(curl -s -X PUT \
  "https://api.github.com/repos/$FULL_REPO/pulls/$PR_NUMBER/merge" \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"merge_method\": \"squash\",
    \"commit_title\": \"[$ISSUE_IDENTIFIER] $ISSUE_TITLE\",
    \"commit_message\": \"Linear 이슈: $ISSUE_IDENTIFIER\\nPR: $PR_URL\"
  }")

MERGE_SUCCESS=$(echo "$MERGE_RESPONSE" | jq -r '.merged')
MERGE_SHA=$(echo "$MERGE_RESPONSE"     | jq -r '.sha')

if [ "$MERGE_SUCCESS" != "true" ]; then
  echo "❌ Merge 실패: $(echo "$MERGE_RESPONSE" | jq -r '.message')"
  exit 1
fi

echo "✅ Merge 완료: $MERGE_SHA"
```

---

## Step 4. Feature Branch 삭제

```bash
curl -s -X DELETE \
  "https://api.github.com/repos/$FULL_REPO/git/refs/heads/$BRANCH_NAME" \
  -H "Authorization: token $GITHUB_TOKEN"

echo "✅ Branch 삭제: $BRANCH_NAME"
```

---

## Step 5. Dockerfile 생성

최신 main 을 받아온 뒤 프로젝트 유형을 자동 감지해 Dockerfile 을 생성한다.

```bash
cd "$PROJECT_ROOT"
git checkout main
git pull origin main

# 프로젝트 유형 감지
detect_type() {
  if   grep -q '"next"'                package.json 2>/dev/null; then echo "nextjs"
  elif grep -q '"react-scripts"'       package.json 2>/dev/null; then echo "react"
  elif grep -q '"express"\|"fastify"'  package.json 2>/dev/null; then echo "nodejs"
  elif [ -f "requirements.txt" ] || [ -f "pyproject.toml" ];     then echo "python"
  elif [ -f "go.mod" ];                                           then echo "golang"
  elif [ -f "pom.xml" ] || [ -f "build.gradle" ];                then echo "java"
  else echo "unknown"
  fi
}

PROJECT_TYPE=$(detect_type)
echo "감지된 프로젝트 유형: $PROJECT_TYPE"
```

### 유형별 Dockerfile

**Next.js:**

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
```

**Node.js (Express/Fastify):**

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build 2>/dev/null || true

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
USER app
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

**Python:**

```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.12-slim AS builder
WORKDIR /app
RUN pip install --upgrade pip
COPY requirements*.txt ./
RUN pip install --no-cache-dir -r requirements.txt

FROM python:3.12-slim AS runner
WORKDIR /app
RUN useradd -m -u 1000 appuser
COPY --from=builder /usr/local/lib/python3.12/site-packages \
     /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
COPY --chown=appuser:appuser . .
USER appuser
EXPOSE 8000
CMD ["gunicorn", "app:app", "--bind", "0.0.0.0:8000", "--workers", "2"]
```

**Go:**

```dockerfile
# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o app .

FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /app/app /app
EXPOSE 8080
ENTRYPOINT ["/app"]
```

감지된 유형에 맞는 Dockerfile 을 `$PROJECT_ROOT/Dockerfile` 로 저장 후 Commit:

```bash
# .dockerignore 생성
cat > "$PROJECT_ROOT/.dockerignore" << 'EOF'
node_modules
.next
dist
build
.git
.env
.env.*
!.env.example
__pycache__
*.pyc
coverage
*.log
EOF

# 컨테이너 포트 결정 (프로젝트 유형별)
case "$PROJECT_TYPE" in
  nextjs) CONTAINER_PORT=3000 ;;
  python) CONTAINER_PORT=8000 ;;
  *)      CONTAINER_PORT=8080 ;;
esac

# docker-compose.yml 생성 (로컬 빌드 방식)
cat > "$PROJECT_ROOT/docker-compose.yml" << EOF
services:
  app:
    build: .
    restart: always
    ports:
      - "\${HOST_PORT}:${CONTAINER_PORT}"
    env_file:
      - .env
EOF

# .env.example 생성 (호스트 포트 안내)
cat > "$PROJECT_ROOT/.env.example" << 'EOF'
# NAS에서 외부에 노출할 포트 번호를 설정하세요.
HOST_PORT=
EOF

git add Dockerfile .dockerignore docker-compose.yml .env.example
git commit -m "chore: $ISSUE_IDENTIFIER add Dockerfile ($PROJECT_TYPE) & docker-compose"
echo "✅ Dockerfile & docker-compose.yml Commit 완료"

git push origin main
```

---

## Step 6. Linear 이슈에 완료 댓글 + 배포 가이드 등록

```bash
GITHUB_REPO_URL="https://github.com/$FULL_REPO"
DONE_AT=$(date '+%Y-%m-%d %H:%M')

DONE_COMMENT="## ✅ 개발 완료

| 항목 | 내용 |
|------|------|
| Merge | Squash Merge 완료 (\`${MERGE_SHA:0:7}\`) |
| Branch | \`$BRANCH_NAME\` 삭제 완료 |
| Dockerfile | \`$PROJECT_TYPE\` 유형 자동 생성 |
| docker-compose.yml | 자동 생성 (repo에 포함) |
| 완료 일시 | $DONE_AT |

---

## 🚀 NAS 배포 방법

### 1. repo에서 docker-compose.yml 가져오기

NAS에서 아래 디렉토리에 repo를 clone하거나 파일을 직접 복사하세요.

\`\`\`bash
git clone https://github.com/${FULL_REPO}.git
\`\`\`

### 2. .env 파일 생성 (호스트 포트 설정)

\`\`\`bash
# docker-compose.yml 옆에 .env 파일 생성
echo 'HOST_PORT=원하는포트번호' > .env
\`\`\`

### 3. 빌드 & 실행

\`\`\`bash
docker compose up -d --build
\`\`\`

> **Dockerfile 위치:** [${FULL_REPO}/blob/main/Dockerfile](${GITHUB_REPO_URL}/blob/main/Dockerfile)"

curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"mutation {
      commentCreate(input: {
        issueId: \\\"$ISSUE_ID\\\",
        body: $(echo "$DONE_COMMENT" | jq -Rs .)
      }) { success }
    }\"
  }"

echo "✅ Linear 배포 가이드 댓글 등록 완료"
```

---

## Step 7. Linear 이슈 상태를 Done 으로 변경

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"mutation {
      issueUpdate(id: \\\"$ISSUE_ID\\\", input: {
        stateId: \\\"$LINEAR_DONE_STATE_ID\\\"
      }) { success }
    }\"
  }" | jq '.data.issueUpdate.success'

echo "✅ Linear 이슈 상태: Reviewed → Done"
```

---

## Step 8. Slack 완료 알림

```bash
LINEAR_ISSUE_URL="https://linear.app/issue/$ISSUE_IDENTIFIER"
GITHUB_REPO_URL="https://github.com/$FULL_REPO"

curl -s -X POST "$SLACK_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"channel\": \"#claude_dev_automation\",
    \"blocks\": [
      {
        \"type\": \"header\",
        \"text\": {\"type\": \"plain_text\", \"text\": \"🎉 개발 완료 — Done\"}
      },
      {
        \"type\": \"section\",
        \"fields\": [
          {\"type\": \"mrkdwn\", \"text\": \"*이슈*\\n<$LINEAR_ISSUE_URL|[$ISSUE_IDENTIFIER] $ISSUE_TITLE>\"},
          {\"type\": \"mrkdwn\", \"text\": \"*Merge*\\n\`${MERGE_SHA:0:7}\`\"},
          {\"type\": \"mrkdwn\", \"text\": \"*Dockerfile*\\n$PROJECT_TYPE 유형\"},
          {\"type\": \"mrkdwn\", \"text\": \"*docker-compose.yml*\\n생성 완료\"}
        ]
      },
      {
        \"type\": \"context\",
        \"elements\": [{\"type\": \"mrkdwn\", \"text\": \"NAS에서 .env에 HOST_PORT를 설정한 뒤 \`docker compose up -d\`를 실행하세요.\"}]
      },
      {
        \"type\": \"actions\",
        \"elements\": [
          {
            \"type\": \"button\",
            \"text\": {\"type\": \"plain_text\", \"text\": \"이슈 보기\"},
            \"url\": \"$LINEAR_ISSUE_URL\",
            \"style\": \"primary\"
          },
          {
            \"type\": \"button\",
            \"text\": {\"type\": \"plain_text\", \"text\": \"repo 보기\"},
            \"url\": \"$GITHUB_REPO_URL\"
          }
        ]
      }
    ]
  }"

echo "✅ Slack 완료 알림 전송"

# 완료 마커 기록 (중복 실행 방지)
STATE_FILE="/workspace/linear-pipeline/state/${ISSUE_ID}.json"
EXISTING=$(cat "$STATE_FILE" 2>/dev/null || echo '{}')
echo "$EXISTING" | jq --arg s "$CURRENT_STATE" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '. + {lastCompletedState: $s, lastCompletedAt: $t}' > "$STATE_FILE"
echo "✅ 완료"
```

---

## 오류 처리

| 상황 | 처리 |
|------|------|
| PR Merge 충돌 | Slack 에 수동 처리 요청 후 중단 |
| 프로젝트 유형 감지 실패 | 기본 Dockerfile(ubuntu 기반) 생성 + "수동 수정 필요" Slack 알림 |
| Dockerfile Commit 실패 | 로컬 파일 유지 + Slack 알림 |
| Linear Done 업데이트 실패 | Slack 에서 수동 처리 안내 |
