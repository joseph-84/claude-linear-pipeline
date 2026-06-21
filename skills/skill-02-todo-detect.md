---
name: linear-todo-detect
description: >
  Linear 이슈가 Todo 상태로 변경되면 이슈를 분석해 개발 플랜을 작성하고
  Linear 댓글로 등록한 뒤 Slack으로 알린다. (파이프라인 Step 2-3)
  "todo 감지", "플랜 작성", "plan review" 키워드에 반드시 사용하라.
---

# Skill: Todo Detect & Plan Writer (Step 2-3)

## 역할
Linear 이슈가 **Todo** 상태가 되면 자동으로 실행된다.
이슈 내용을 분석해 개발 플랜을 작성하고, Linear 댓글로 등록한 뒤
댓글 URL을 Slack으로 전송한다.

---

## 필수 환경변수
```
LINEAR_API_KEY
LINEAR_PLAN_REVIEW_STATE_ID
SLACK_WEBHOOK_URL
ISSUE_ID            (webhook-server.js 가 주입)
ISSUE_IDENTIFIER    (webhook-server.js 가 주입)
ISSUE_TITLE         (webhook-server.js 가 주입)
```

---

## Step 1. Linear 이슈 상세 조회

아래 curl 로 이슈 정보를 가져와서 `/tmp/issue_data.json` 에 저장한다.

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"{ issue(id: \\\"$ISSUE_ID\\\") {
      id identifier title description priority
      labels { nodes { name } }
    } }\"
  }" > /tmp/issue_data.json

ISSUE_IDENTIFIER=$(jq -r '.data.issue.identifier'       /tmp/issue_data.json)
ISSUE_TITLE=$(jq -r '.data.issue.title'                 /tmp/issue_data.json)
ISSUE_DESC=$(jq -r '.data.issue.description // "없음"'  /tmp/issue_data.json)
ISSUE_LABEL=$(jq -r '.data.issue.labels.nodes[0].name // "feature"' /tmp/issue_data.json)
ISSUE_PRIORITY=$(jq -r '.data.issue.priority'           /tmp/issue_data.json)

echo "이슈: $ISSUE_IDENTIFIER / $ISSUE_TITLE"
```

---

## Step 2. 개발 플랜 작성

이슈 정보를 바탕으로 아래 형식의 플랜을 작성해 `/tmp/plan_content.txt` 에 저장한다.

- `description` 이 비어 있으면 title 만으로 최소 플랜을 작성하고
  맨 아래에 `⚠️ 이슈 설명을 보완해주세요` 를 추가한다.
- Branch 명은 `feature/{ISSUE_IDENTIFIER}-{kebab-case-title}` 규칙을 따른다.

플랜 형식:

```
## 📋 개발 플랜 — {ISSUE_IDENTIFIER}: {ISSUE_TITLE}

### 이슈 분석
- 유형: {bug | feature | refactor | hotfix}
- 우선순위: {urgent | high | medium | low}
- 예상 복잡도: {Low | Medium | High}

### 구현 전략
1. {핵심 접근 방식}
2. {변경 대상 파일 및 모듈}
3. {엣지 케이스 처리 방안}

### Feature Branch 명
feature/{ISSUE_IDENTIFIER}-{kebab-case-title}

### 테스트 계획
- 단위 테스트: {대상 함수/모듈}
- 수동 테스트 URL: ${DEV_URL}/{path}

### 완료 기준 (Definition of Done)
- [ ] 기능 구현 완료
- [ ] 테스트 통과
- [ ] PR 생성 및 리뷰 요청
- [ ] 개발 서버 동작 확인
```

플랜 작성 후 파일 저장:

```bash
# Claude Code 가 위 형식으로 플랜을 작성한 뒤 아래 경로에 저장한다.
PLAN_FILE=/tmp/plan_content.txt
```

---

## Step 3. Linear 이슈에 플랜 댓글 등록

```bash
COMMENT_BODY=$(jq -Rs . < /tmp/plan_content.txt)

RESPONSE=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"mutation {
      commentCreate(input: {
        issueId: \\\"$ISSUE_ID\\\",
        body: $COMMENT_BODY
      }) { success comment { id url } }
    }\"
  }")

COMMENT_URL=$(echo "$RESPONSE" | jq -r '.data.commentCreate.comment.url')
echo "댓글 등록 완료: $COMMENT_URL"
echo "$COMMENT_URL" > /tmp/plan_comment_url.txt
```

---

## Step 4. Linear 이슈 상태를 Plan Review 로 변경

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"mutation {
      issueUpdate(id: \\\"$ISSUE_ID\\\", input: {
        stateId: \\\"$LINEAR_PLAN_REVIEW_STATE_ID\\\"
      }) { success }
    }\"
  }" | jq '.data.issueUpdate.success'
```

---

## Step 5. Slack 알림 전송

```bash
COMMENT_URL=$(cat /tmp/plan_comment_url.txt)
LINEAR_ISSUE_URL="https://linear.app/issue/$ISSUE_IDENTIFIER"

curl -s -X POST "$SLACK_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"channel\": \"#claude_dev_automation\",
    \"blocks\": [
      {
        \"type\": \"header\",
        \"text\": {\"type\": \"plain_text\", \"text\": \"📋 플랜 리뷰 요청\"}
      },
      {
        \"type\": \"section\",
        \"fields\": [
          {\"type\": \"mrkdwn\", \"text\": \"*이슈*\\n<$LINEAR_ISSUE_URL|[$ISSUE_IDENTIFIER] $ISSUE_TITLE>\"},
          {\"type\": \"mrkdwn\", \"text\": \"*상태*\\nTodo → Plan Review\"}
        ]
      },
      {
        \"type\": \"context\",
        \"elements\": [{\"type\": \"mrkdwn\", \"text\": \"플랜을 검토한 뒤 이슈를 Develop으로 이동해주세요.\"}]
      },
      {
        \"type\": \"actions\",
        \"elements\": [
          {
            \"type\": \"button\",
            \"text\": {\"type\": \"plain_text\", \"text\": \"플랜 보기\"},
            \"url\": \"$COMMENT_URL\",
            \"style\": \"primary\"
          }
        ]
      }
    ]
  }"
```

---

## Step 6. 컨텍스트 저장

다음 단계(Step 5 Develop)에서 참조할 수 있도록 상태 파일에 저장한다.

```bash
STATE_FILE="/workspace/linear-pipeline/state/${ISSUE_ID}.json"

cat > "$STATE_FILE" << EOF
{
  "issueId": "$ISSUE_ID",
  "identifier": "$ISSUE_IDENTIFIER",
  "title": "$ISSUE_TITLE",
  "label": "$ISSUE_LABEL",
  "planCommentUrl": "$COMMENT_URL"
}
EOF

echo "컨텍스트 저장 완료: $STATE_FILE"

# 완료 마커 기록 (중복 실행 방지)
EXISTING=$(cat "$STATE_FILE" 2>/dev/null || echo '{}')
echo "$EXISTING" | jq --arg s "$CURRENT_STATE" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '. + {lastCompletedState: $s, lastCompletedAt: $t}' > "$STATE_FILE"
echo "✅ 완료"
```

---

## 오류 처리

| 상황 | 처리 |
|------|------|
| 이슈 description 없음 | 최소 플랜 작성 후 보완 요청 메모 추가 |
| Linear API 오류 | 3회 재시도 후 Slack 에러 알림 |
| 상태 변경 실패 | 댓글은 유지, Slack 으로 수동 처리 요청 |
