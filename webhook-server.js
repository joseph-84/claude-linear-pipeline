// webhook-server.js
// Linear 파이프라인 자동화 — Webhook 수신 및 Claude Code 스킬 라우터
// 위치: /workspace/linear-pipeline/webhook-server.js

'use strict';

const http    = require('http');
const crypto  = require('crypto');
const { spawn } = require('child_process');
const fs      = require('fs');
const path    = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });

// ─── 설정 ────────────────────────────────────────────────
const PORT                  = process.env.WEBHOOK_PORT || 3001;
const LINEAR_WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET || '';
const SKILLS_DIR            = path.join(__dirname, 'skills');
const STATE_DIR             = path.join(__dirname, 'state');
const LOG_DIR               = path.join(__dirname, 'logs');

// 디렉토리 초기화
[STATE_DIR, LOG_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── 상태 → 스킬 라우팅 테이블 ──────────────────────────
const ROUTE = {
  'Todo'     : 'skill-02-todo-detect.md',
  'Develop'  : 'skill-05-develop.md',
  'Reviewed' : 'skill-11-reviewed-merge.md',
};

// ─── 로그 ────────────────────────────────────────────────
function log(level, msg) {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(LOG_DIR, 'pipeline.log'), line + '\n');
}

// ─── Webhook 서명 검증 ───────────────────────────────────
function verifySignature(body, sig) {
  if (!LINEAR_WEBHOOK_SECRET) return true;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', LINEAR_WEBHOOK_SECRET)
    .update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig || ''));
  } catch {
    return false;
  }
}

// ─── 상태 파일 읽기/쓰기 ─────────────────────────────────
function loadState(issueId) {
  const f = path.join(STATE_DIR, `${issueId}.json`);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
}

function saveState(issueId, data) {
  const f = path.join(STATE_DIR, `${issueId}.json`);
  const existing = loadState(issueId);
  fs.writeFileSync(f, JSON.stringify({ ...existing, ...data }, null, 2));
}

// ─── Claude Code 실행 ─────────────────────────────────────
function runSkill(skillFile, envVars) {
  const skillPath = path.join(SKILLS_DIR, skillFile);

  if (!fs.existsSync(skillPath)) {
    log('ERROR', `스킬 파일 없음: ${skillPath}`);
    return;
  }

  const skillContent = fs.readFileSync(skillPath, 'utf8');

  const prompt = `다음 스킬 파일의 지시사항을 처음부터 끝까지 모두 실행하라.
단계를 건너뛰지 말고 순서대로 실행하라.
각 Step 완료 후 결과를 간략히 출력하라.

---
${skillContent}`;

  const logFile = path.join(LOG_DIR, `${envVars.ISSUE_IDENTIFIER}-${Date.now()}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  log('INFO', `Claude Code 실행 시작: ${skillFile} / 이슈: ${envVars.ISSUE_IDENTIFIER}`);

  const child = spawn('claude', [
    '--print',
    '--dangerously-skip-permissions',
    prompt
  ], {
    env    : { ...process.env, ...envVars },
    cwd    : process.env.PROJECT_ROOT || '/workspace',
    stdio  : ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  child.stdout.on('data', d => {
    process.stdout.write(d);
    logStream.write(d);
  });
  child.stderr.on('data', d => {
    process.stderr.write(d);
    logStream.write(d);
  });
  child.on('close', code => {
    log('INFO', `스킬 완료 (exit ${code}): ${skillFile}`);
    logStream.end();
  });
  child.on('error', err => {
    log('ERROR', `Claude Code 실행 실패: ${err.message}`);
  });

  child.unref();
}

// ─── Webhook 이벤트 처리 ──────────────────────────────────
function handleWebhook(payload) {
  const { type, action, data } = payload;

  // 댓글 생성 이벤트: 자동화 대상 상태의 이슈면 재처리
  if (type === 'Comment' && action === 'create') {
    handleCommentEvent(data);
    return;
  }

  // Issue update 이벤트만 처리
  if (type !== 'Issue' || action !== 'update') return;
  if (!data?.state?.name) return;

  const currentState  = data.state.name;
  const previousState = data.previousState?.name || '';
  const skillFile     = ROUTE[currentState];

  if (!skillFile) {
    log('INFO', `라우팅 없음: "${previousState}" → "${currentState}" (이슈: ${data.identifier})`);
    return;
  }

  log('INFO', `상태 변경 감지: "${previousState}" → "${currentState}" / 이슈: ${data.identifier} (${data.id})`);

  // 이전 단계 컨텍스트 로드
  const state = loadState(data.id);

  // 이슈 기본 정보 저장
  saveState(data.id, {
    issueId     : data.id,
    identifier  : data.identifier,
    title       : data.title,
    currentState: currentState,
  });

  // 환경변수로 컨텍스트 주입
  const envVars = {
    ISSUE_ID         : data.id,
    ISSUE_IDENTIFIER : data.identifier,
    ISSUE_TITLE      : data.title || '',
    CURRENT_STATE    : currentState,
    PREVIOUS_STATE   : previousState,
    TRIGGER          : 'state_change',
    LATEST_COMMENT   : '',
    LATEST_COMMENT_AUTHOR: '',
    // 이전 단계에서 저장된 값
    BRANCH_NAME      : state.branchName      || '',
    PR_NUMBER        : String(state.prNumber  || ''),
    PR_URL           : state.prUrl            || '',
    TEST_COMMENT_URL : state.testCommentUrl   || '',
    REPORT_URL       : state.reportCommentUrl || '',
    PROJECT_ROOT     : process.env.PROJECT_ROOT || '/workspace',
  };

  runSkill(skillFile, envVars);
}

// ─── 댓글 이벤트 처리 ────────────────────────────────────
function handleCommentEvent(data) {
  // Linear Comment 페이로드에 issue 필드가 없으면 무시
  const issue = data.issue;
  if (!issue?.state?.name) return;

  const currentState = issue.state.name;
  const skillFile    = ROUTE[currentState];

  if (!skillFile) {
    log('INFO', `댓글 이벤트 무시: 이슈 ${issue.identifier} — 상태 "${currentState}" 라우팅 없음`);
    return;
  }

  log('INFO', `댓글로 재처리 트리거: 이슈 ${issue.identifier} "${issue.title}" (상태: ${currentState})`);

  const state = loadState(issue.id);

  saveState(issue.id, {
    issueId     : issue.id,
    identifier  : issue.identifier,
    title       : issue.title,
    currentState: currentState,
  });

  const envVars = {
    ISSUE_ID              : issue.id,
    ISSUE_IDENTIFIER      : issue.identifier,
    ISSUE_TITLE           : issue.title || '',
    CURRENT_STATE         : currentState,
    PREVIOUS_STATE        : '',
    TRIGGER               : 'comment',
    LATEST_COMMENT        : data.body || '',
    LATEST_COMMENT_AUTHOR : data.user?.name || '',
    // 이전 단계에서 저장된 값
    BRANCH_NAME           : state.branchName      || '',
    PR_NUMBER             : String(state.prNumber  || ''),
    PR_URL                : state.prUrl            || '',
    TEST_COMMENT_URL      : state.testCommentUrl   || '',
    REPORT_URL            : state.reportCommentUrl || '',
    PROJECT_ROOT          : process.env.PROJECT_ROOT || '/workspace',
  };

  runSkill(skillFile, envVars);
}

// ─── HTTP 서버 ────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // 헬스체크
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/webhook/linear') {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    // 서명 검증
    const sig = req.headers['linear-signature'];
    if (!verifySignature(body, sig)) {
      log('WARN', 'Webhook 서명 검증 실패');
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }

    // Linear 는 빠른 200 응답을 기대함 — 처리는 비동기
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

    try {
      const payload = JSON.parse(body);
      handleWebhook(payload);
    } catch (e) {
      log('ERROR', `Webhook 파싱 실패: ${e.message}`);
    }
  });
});

server.listen(PORT, () => {
  log('INFO', `Linear Pipeline Webhook Server 시작 — port ${PORT}`);
  log('INFO', '라우팅 테이블:');
  Object.entries(ROUTE).forEach(([state, skill]) => {
    log('INFO', `  "${state}" → ${skill}`);
  });
});

server.on('error', err => {
  log('ERROR', `서버 오류: ${err.message}`);
  process.exit(1);
});
