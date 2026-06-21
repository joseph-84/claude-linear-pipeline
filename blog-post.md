# Linear + Claude Code 자동 개발 파이프라인 구축기

> **이슈 하나를 Linear에 등록하면 — 기획, 개발, 보안 점검, 배포까지 AI가 자동으로 처리한다**

---

## 들어가며

개발 팀이 아니어도 서비스를 만들 수 있을까? 이 질문에서 이 프로젝트가 시작됐습니다.

아이디어를 Linear 이슈로 작성하면, Claude Code가 자동으로 개발 플랜을 세우고, GitHub 레포를 만들고, 코드를 짜고, 보안 점검까지 마친 뒤, Synology NAS에 배포할 수 있는 Dockerfile까지 생성해줍니다. 사람이 하는 일은 이슈 작성과 중간 중간 단계 승인(Linear 상태 변경)뿐입니다.

이 글에서는 그 전체 구조와 구현 과정을 최대한 상세하게 정리합니다.

---

## 전체 아키텍처

파이프라인은 **Linear 이슈 상태**를 트리거로 삼습니다. 상태가 바뀌는 순간 Node.js 폴링 모니터가 감지하고, 해당 상태에 맞는 Claude Code 스킬을 실행합니다.

```
[ Linear 이슈 생성 ]
        ↓ 상태: Todo
  📋 플랜 작성 & Plan Review 이동
        ↓ (사람이 검토 후) 상태: Develop
  💻 코드 개발 & PR 생성 & Test 이동
        ↓ (사람이 테스트 후) 상태: Security Audit
  🔒 보안 점검 (SAST + DAST) & Security Review 이동
        ↓ (사람이 보안 검토 후) 상태: Reviewed
  🎉 PR Merge + Dockerfile 생성 + Done 이동
```

각 단계마다 Slack 알림이 오고, Linear 이슈에 상세 댓글이 달립니다.

---

## 프로젝트 구조

```
/workspace/linear-pipeline/
├── linear-monitor.js      # Linear API 폴링 + 스킬 실행 (핵심)
├── skills/
│   ├── skill-02-todo-detect.md      # 플랜 작성
│   ├── skill-05-develop.md          # 코드 개발
│   ├── skill-08-security-audit.md   # 보안 점검
│   └── skill-11-reviewed-merge.md   # Merge & Dockerfile
├── state/                 # 이슈별 컨텍스트 JSON 파일
├── logs/                  # 스킬 실행 로그
└── .env                   # API 키 및 상태 ID 설정
```

의존 패키지는 `dotenv` 하나뿐입니다. 나머지는 모두 Node.js 내장 모듈(`https`, `child_process`, `fs`)로만 구현했습니다.

---

## 트리거 방식: 폴링 모니터 (linear-monitor.js)

`linear-monitor.js`는 Linear GraphQL API를 주기적으로 쿼리해 처리 대상 이슈를 감지합니다. Cron으로 5분마다 실행됩니다.

```javascript
const ROUTE = {
  'Todo'           : 'skill-02-todo-detect.md',
  'Develop'        : 'skill-05-develop.md',
  'Security Audit' : 'skill-08-security-audit.md',
  'Reviewed'       : 'skill-11-reviewed-merge.md',
};
```

최근 24시간 이내에 업데이트된 이슈 중 위 4개 상태에 해당하는 것만 조회합니다.

```javascript
// 최근 24시간 이내 업데이트된 이슈만 조회
const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
```

**중복 실행 방지 로직:**

- `lastTriggeredAt` 기록 → 30분 이내면 스킵
- `lastCompletedAt` 기록 → 완료 후 새 변경(댓글 등)이 없으면 스킵
- 30분 초과 시 타임아웃으로 간주하고 재실행

댓글로 새 활동이 감지되면 해당 이슈의 현재 상태 스킬을 재실행합니다. 이를 통해 "댓글로 수정 요청 → 자동 재개발"이 가능합니다.

---

## 이슈별 상태 저장: JSON 파일

각 이슈의 컨텍스트는 `state/{issueId}.json`에 저장됩니다. 파이프라인의 각 단계가 다음 단계에 필요한 정보를 이 파일을 통해 전달합니다.

```json
{
  "issueId": "abc-123",
  "identifier": "JOS-15",
  "title": "개인정보 처리방침 페이지",
  "branchName": "feature/JOS-15-privacy-policy",
  "prNumber": 3,
  "prUrl": "https://github.com/...",
  "testCommentUrl": "https://linear.app/...",
  "stack": "nextjs",
  "port": 3001,
  "devUrl": "http://test1.joseph84.freeddns.org",
  "lastCompletedState": "Develop",
  "lastCompletedAt": "2026-06-04T12:00:00Z"
}
```

---

## 프로젝트별 고정 포트 관리

개발 서버는 10개의 포트(3001~3010)를 사용합니다. 한 프로젝트는 항상 같은 포트를 씁니다. `_port_map.json`에 영구 저장됩니다.

```json
{
  "Privacy Policy": 3001,
  "SearchMissa": 3004
}
```

각 포트는 역방향 프록시로 외부 도메인에 연결되어 있어, 어느 프로젝트든 개발 완료 즉시 URL로 확인할 수 있습니다.

---

## Claude Code 스킬 실행 방식

스킬은 마크다운 파일입니다. 모니터가 스킬 파일 내용을 읽어 Claude Code의 프롬프트로 전달합니다.

```javascript
const prompt = `다음 스킬 파일의 지시사항을 처음부터 끝까지 모두 실행하라.
단계를 건너뛰지 말고 순서대로 실행하라.

---
${skillContent}`;

const child = spawn('/usr/bin/claude', [
  '--print',
  '--dangerously-skip-permissions',
  prompt,
], {
  env: { ...process.env, ...envVars },
  detached: true,
});
```

이슈 ID, 제목, 브랜치명, PR URL 등 컨텍스트는 환경변수로 주입됩니다. Claude Code는 이 환경변수들을 쉘 명령어(`$ISSUE_ID`, `$BRANCH_NAME` 등)로 바로 사용합니다.

---

## Step 1: Todo → 플랜 작성 (skill-02-todo-detect.md)

이슈가 **Todo** 상태가 되면 실행됩니다.

**동작 순서:**

1. Linear GraphQL API로 이슈 상세 조회 (제목, 설명, 레이블, 우선순위)
2. 이슈 분석 후 개발 플랜 작성
3. Linear 이슈에 플랜 댓글 등록
4. Linear 상태를 **Plan Review**로 변경
5. Slack으로 "플랜 리뷰 요청" 알림 전송

작성되는 플랜 형식 예시:

```markdown
## 📋 개발 플랜 — JOS-15: 개인정보 처리방침 페이지

### 이슈 분석
- 유형: feature
- 우선순위: medium
- 예상 복잡도: Low

### 구현 전략
1. Next.js App Router 기반 정적 페이지 구현
2. /privacy-policy 라우트 추가
3. 마크다운 렌더링 또는 정적 HTML

### Feature Branch 명
feature/JOS-15-privacy-policy

### 완료 기준 (Definition of Done)
- [ ] 기능 구현 완료
- [ ] 개발 서버 동작 확인
```

> 💡 설명이 없는 이슈는 제목만으로 최소 플랜을 작성하고 "⚠️ 이슈 설명을 보완해주세요"를 추가합니다.

---

## Step 2: Develop → 전체 개발 워크플로우 (skill-05-develop.md)

이슈가 **Develop** 상태가 되면 실행됩니다. 가장 복잡한 스킬입니다.

### 이슈 전체 맥락 로드

이슈 본문뿐 아니라 **모든 댓글**을 시간순으로 읽습니다. 플랜 댓글, 피드백, 수정 요청이 모두 포함됩니다.

```bash
ALL_COMMENTS=$(jq -r '
  .data.issue.comments.nodes[] |
  "---\n작성자: \(.user.name)\n시간: \(.createdAt)\n\n\(.body)\n"
' /tmp/issue_full.json)
```

상충되는 댓글이 있으면 가장 최근 댓글을 우선합니다.

### GitHub Repo 자동 생성

프로젝트 폴더가 없으면 GitHub API로 private 레포를 만들고 clone합니다. 이미 있으면 최신 상태로 pull합니다.

### 기술 스택 자동 판단

이슈 키워드로 스택을 결정합니다:

| 키워드 | 선택 스택 |
|--------|-----------|
| "웹사이트", "페이지", "UI", "화면" | Next.js |
| "API", "백엔드", "서버", "REST" | Express |
| "크롤링", "스크래핑", "자동화" | Python |
| 판단 불가 | Next.js (기본값) |

### 개발 서버 자동 오류 수정 루프

서버가 정상 응답할 때까지 오류를 분석하고 수정합니다. 시도 횟수에 제한이 없습니다.

```
while true; do
  서버 시작 시도
  90초 대기 (HTTP 응답 확인)

  응답 성공 → break
  응답 실패 → 로그 분석 후 자동 수정
done
```

| 오류 패턴 | 자동 수정 방법 |
|-----------|---------------|
| `Cannot find module` | npm install 실행 |
| `EADDRINUSE` (포트 충돌) | fuser -k 포트/tcp 후 재시도 |
| TypeScript / ESLint 빌드 오류 | 코드 파일 직접 수정 |
| `ModuleNotFoundError` (Python) | pip install 실행 |
| .env 없거나 값 오류 | .env 파일 생성 또는 수정 |
| 동일 오류 반복 | 다른 접근 방법 시도 |

> 🚨 **즉시 중단 & 사람 알림 조건**
> API 키·DB 비밀번호 없음 / 외부 서비스 미응답 / 시스템 패키지 설치 필요 / 동일 오류 5회 이상 반복
> → Linear 댓글 + Slack 알림 후 중단. **문제 해결 후 댓글을 남기면 자동 재시작.**

### PR 생성 및 이후 처리

1. Feature Branch commit & push
2. GitHub PR 생성 (본문에 이슈 링크, 개발 서버 URL, 반영된 댓글 수 포함)
3. 수동 테스트 체크리스트 Linear 댓글 등록
4. Linear 상태를 **Test**로 변경
5. Slack에 "개발 완료 — 테스트 요청" 알림

---

## Step 3: Security Audit → 보안 점검 (skill-08-security-audit.md)

이슈가 **Security Audit** 상태가 되면 SAST → SCA → DAST 순으로 자동 보안 점검이 실행됩니다.

### SAST: Semgrep 정적 분석

```bash
semgrep scan \
  --config "p/owasp-top-ten" \
  --config "p/cwe-top-25" \
  --config "p/secrets" \
  --json \
  --output /tmp/semgrep_result.json \
  $PROJECT_ROOT
```

OWASP Top 10, CWE Top 25, 시크릿 탐지 룰셋을 적용합니다.

### SCA: 의존성 취약점 분석

```bash
# Node.js 프로젝트
npm audit --json > /tmp/sca_result.json

# Python 프로젝트
pip-audit -r requirements.txt --format json
```

### DAST: OWASP ZAP 동적 분석

Docker가 설치된 환경이면 ZAP 컨테이너로 자동 스캔합니다. 없으면 curl로 수동 점검을 수행합니다:

```bash
# 보안 헤더 확인
curl -sI "$TARGET" | grep -iE \
  "x-frame-options|content-security-policy|strict-transport|x-xss-protection"

# 민감 경로 탐색
for path in /.env /.git/config /admin /swagger; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$TARGET$path")
  echo "$path → $STATUS"
done

# SQL Injection / XSS 기초 탐지
curl -s "$TARGET/?id=1'" ...
curl -s "$TARGET/?q=<script>alert(1)</script>" ...
```

### 통합 진단보고서

| 구분 | 상(High) | 중(Medium) | 하(Low) |
|------|----------|------------|---------|
| SAST (소스코드) | 0 | 2 | 5 |
| DAST (모의해킹) | 0 | 1 | 3 |
| SCA (의존성) | 0 | 0 | — |
| **합계** | **0** | **3** | **8** |

취약점 수에 따라 종합 위험도를 판정합니다: 🔴 상(HIGH) / 🟠 중(MEDIUM) / 🟢 양호

보고서 등록 후 상태를 **Security Review**로 변경하고 Slack 알림을 전송합니다.

---

## Step 4: Reviewed → Merge & Dockerfile & Done (skill-11-reviewed-merge.md)

이슈가 **Reviewed** 상태가 되면 마지막 단계가 실행됩니다.

**동작 순서:**

1. **PR Merge 가능 여부 확인**: Mergeable 상태를 GitHub API로 확인
2. **Squash Merge**: 깔끔한 커밋 히스토리 유지
3. **Feature Branch 삭제**: 자동 정리
4. **Dockerfile 자동 생성**: 프로젝트 유형을 자동 감지해 멀티스테이지 빌드 Dockerfile 생성
5. **배포 가이드 Linear 댓글 등록**: Synology NAS Container Manager + DSM 역방향 프록시 설정 방법 상세 안내
6. **Linear 상태 Done으로 변경**
7. **Slack 완료 알림** 🎉

### Dockerfile 자동 감지 기준

| 감지 조건 | 생성되는 Dockerfile |
|-----------|---------------------|
| package.json에 `"next"` | Next.js 멀티스테이지 |
| package.json에 `"express"` | Node.js 멀티스테이지 |
| requirements.txt 존재 | Python (gunicorn) |
| go.mod 존재 | Go (scratch 베이스) |

---

## 배포 환경: Synology NAS

이 파이프라인 자체는 Synology NAS의 Container Manager 위에서 돌아갑니다.

```
외부 HTTPS 요청
    ↓
DSM 역방향 프록시 (SSL 종단, Let's Encrypt)
    ↓
Docker 컨테이너 (linear-pipeline)
    ↓
Claude Code 프로세스 (스킬 실행)
    ↓
개발 서버 컨테이너 (포트 3001~3010)
```

NAS에서 제공하는 Let's Encrypt 인증서로 HTTPS를 처리하기 때문에, 내부는 HTTP로 통신하지만 외부에는 HTTPS로 노출됩니다.

---

## 실제 동작: Slack 알림 흐름

**① Todo → Plan Review**
```
📋 플랜 리뷰 요청
이슈: [JOS-15] 개인정보 처리방침 페이지
상태: Todo → Plan Review
[📝 플랜 보기] 버튼
```

**② Develop → Test**
```
✅ 개발 완료 — 테스트 요청
프로젝트: Privacy Policy
이슈: [JOS-15] 개인정보 처리방침 페이지
개발 서버: http://test1.joseph84.freeddns.org
스택: nextjs (포트: 3001)
[🧪 테스트 가이드] [🌐 개발 서버] [🔀 PR 보기]
```

**③ Security Audit → Security Review**
```
🟢 보안 점검 완료 — 리뷰 요청
종합 판정: 🟢 양호
SAST: 상 0 / 중 1 / 하 3
DAST: 상 0 / 중 0 / 하 2
[📋 진단보고서] [🔀 PR 보기]
```

**④ Reviewed → Done**
```
🎉 개발 완료 — Done
이슈: [JOS-15] 개인정보 처리방침 페이지
Merge: a1b2c3d (Squash)
Dockerfile: nextjs 유형 생성 완료
```

---

## 구현하면서 마주친 문제들

### 문제 1: 스킬 실행 중에 다음 폴링 사이클이 중복 실행된다

스킬 하나가 수십 분씩 걸립니다. `lastTriggeredAt` 타임스탬프를 상태 파일에 기록하고, 30분 이내면 스킵하는 방식으로 해결했습니다.

### 문제 2: 개발 서버가 빌드 오류로 시작을 못 한다

무제한 재시도 루프를 설계했습니다. Claude Code가 로그를 읽고 패키지 설치, 코드 수정, 포트 변경 등을 자율적으로 수행합니다. 정말 해결 불가능한 경우(외부 API 키 없음 등)만 사람에게 알립니다.

### 문제 3: 댓글로 수정 요청이 오면 처음부터 다시 해야 한다

`TRIGGER` 환경변수와 `BRANCH_NAME` 환경변수를 체크해서, 이미 브랜치가 있으면 코드 개발 단계를 건너뛰고 서버 구동 단계부터 재실행합니다.

### 문제 4: 프로젝트가 여러 개면 포트가 겹친다

`_port_map.json`에 프로젝트명 → 포트 번호를 영구 저장해 한 프로젝트는 항상 같은 포트를 사용하도록 했습니다.

---

## Linear 상태 흐름 전체 정리

사람이 개입하는 지점은 단 **4곳**입니다:

| # | 사람이 하는 일 | 그 이후 자동 처리 |
|---|---------------|-----------------|
| 1 | Linear에 이슈 작성 | 플랜 자동 작성 → Plan Review |
| 2 | 플랜 검토 후 Develop으로 이동 | 코드 개발 → PR 생성 → Test |
| 3 | 기능 테스트 후 Security Audit으로 이동 | SAST + DAST 보안 점검 → Security Review |
| 4 | 보안 검토 후 Reviewed로 이동 | PR Merge + Dockerfile + Done |

---

## 마치며

이 파이프라인을 만들면서 가장 놀랐던 점은, 스킬 파일(마크다운)이 단순히 프롬프트가 아니라 **실행 가능한 워크플로우 정의**처럼 동작한다는 것입니다. Claude Code가 bash 명령어를 직접 실행하고, API를 호출하고, 오류를 만나면 코드를 고치고 다시 시도합니다.

물론 아직 한계도 있습니다. 복잡한 비즈니스 로직이나 외부 서비스 연동이 많은 프로젝트는 여전히 사람의 손이 많이 필요합니다. 하지만 랜딩 페이지, 정책 페이지, 간단한 API 서버 같은 프로젝트는 이슈 작성 후 거의 손대지 않고 배포 직전까지 도달할 수 있었습니다.

이 글이 유용하셨다면 공감 부탁드립니다. 궁금한 점은 댓글로 남겨주세요.

---

`#Claude` `#ClaudeCode` `#AI자동화` `#Linear` `#개발자동화` `#CICD` `#SynologyNAS` `#GitHub` `#Slack` `#보안자동화`
