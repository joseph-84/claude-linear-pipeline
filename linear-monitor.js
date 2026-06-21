// linear-monitor.js
// Linear 이슈 상태를 폴링하여 변경 감지 시 Claude Code 스킬을 실행한다.

'use strict';

const https   = require('https');
const { spawn } = require('child_process');
const fs      = require('fs');
const path    = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const SKILLS_DIR  = path.join(__dirname, 'skills');
const STATE_DIR   = path.join(__dirname, 'state');
const LOG_DIR     = path.join(__dirname, 'logs');
const PORT_MAP_FILE = path.join(STATE_DIR, '_port_map.json'); // 프로젝트별 포트 고정

[STATE_DIR, LOG_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const ROUTE = {
  'Todo'     : 'skill-02-todo-detect.md',
  'Develop'  : 'skill-05-develop.md',
  'Reviewed' : 'skill-11-reviewed-merge.md',
};

const TRIGGER_TIMEOUT_MS = 90 * 60 * 1000; // 90분 — Develop 스킬은 테스트·보안점검 포함으로 최대 80분 소요

// 포트-도메인 매핑 테이블
const PORT_DOMAIN = {
  3001: 'test1.joseph84.freeddns.org',
  3002: 'test2.joseph84.freeddns.org',
  3003: 'test3.joseph84.freeddns.org',
  3004: 'test4.joseph84.freeddns.org',
  3005: 'test5.joseph84.freeddns.org',
  3006: 'test6.joseph84.freeddns.org',
  3007: 'test7.joseph84.freeddns.org',
  3008: 'test8.joseph84.freeddns.org',
  3009: 'test9.joseph84.freeddns.org',
  3010: 'test10.joseph84.freeddns.org',
};

function log(level, msg) {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(LOG_DIR, 'monitor.log'), line + '\n');
}

// ─── 프로젝트별 포트 고정 관리 ───────────────────────────
// 프로젝트명 → 포트 번호를 _port_map.json 에 영구 저장
// 한 번 할당된 포트는 프로젝트가 삭제되기 전까지 유지된다.
function loadPortMap() {
  try { return JSON.parse(fs.readFileSync(PORT_MAP_FILE, 'utf8')); } catch { return {}; }
}

function savePortMap(map) {
  fs.writeFileSync(PORT_MAP_FILE, JSON.stringify(map, null, 2));
}

function assignPort(projectSlug) {
  const portMap = loadPortMap();

  // 이미 할당된 포트가 있으면 그대로 반환
  if (portMap[projectSlug]) {
    log('INFO', `포트 재사용: ${projectSlug} → ${portMap[projectSlug]}`);
    return portMap[projectSlug];
  }

  // 새 포트 할당 — 이미 다른 프로젝트에 할당된 포트 제외
  const usedPorts = new Set(Object.values(portMap));
  let newPort = null;
  for (const port of Object.keys(PORT_DOMAIN).map(Number)) {
    if (!usedPorts.has(port)) {
      newPort = port;
      break;
    }
  }

  if (!newPort) {
    log('ERROR', '사용 가능한 포트 없음 (3001~3010 모두 할당됨)');
    return null;
  }

  portMap[projectSlug] = newPort;
  savePortMap(portMap);
  log('INFO', `신규 포트 할당: ${projectSlug} → ${newPort}`);
  return newPort;
}

// ─── 상태 파일 ────────────────────────────────────────────
function loadState(issueId) {
  const f = path.join(STATE_DIR, `${issueId}.json`);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
}

function saveState(issueId, data) {
  const f = path.join(STATE_DIR, `${issueId}.json`);
  const existing = loadState(issueId);
  fs.writeFileSync(f, JSON.stringify({ ...existing, ...data }, null, 2));
}

// ─── Linear GraphQL 요청 ──────────────────────────────────
function linearQuery(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const options = {
      hostname: 'api.linear.app',
      path    : '/graphql',
      method  : 'POST',
      headers : {
        'Authorization' : process.env.LINEAR_API_KEY,
        'Content-Type'  : 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
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

  log('INFO', `Claude Code 실행: ${skillFile} / ${envVars.ISSUE_IDENTIFIER} "${envVars.ISSUE_TITLE}"`);

  const child = spawn('/usr/bin/claude', [
    '--print',
    '--dangerously-skip-permissions',
    prompt,
  ], {
    env     : { ...process.env, ...envVars },
    cwd     : process.env.PROJECT_ROOT || '/workspace',
    stdio   : ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  child.stdout.on('data', d => { process.stdout.write(d); logStream.write(d); });
  child.stderr.on('data', d => { process.stderr.write(d); logStream.write(d); });
  child.on('close', code => {
    log('INFO', `스킬 완료 (exit ${code}): ${skillFile} / ${envVars.ISSUE_IDENTIFIER}`);
    logStream.end();
  });
  child.on('error', err => {
    log('ERROR', `Claude Code 실행 실패: ${err.message}`);
  });

  child.unref();
}

// ─── 메인 폴링 로직 ───────────────────────────────────────
async function poll() {
  log('INFO', '=== 폴링 시작 ===');

  const targetStates = Object.keys(ROUTE);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const stateFilter = targetStates.map(s => `{ name: { eq: "${s}" } }`).join(', ');

  const query = `{
    issues(
      filter: {
        state: { or: [${stateFilter}] }
        updatedAt: { gt: "${since}" }
      }
      orderBy: updatedAt
    ) {
      nodes {
        id
        identifier
        title
        updatedAt
        state { name }
        labels { nodes { name } }
        project { id name }
        comments(last: 1, orderBy: createdAt) {
          nodes {
            body
            createdAt
            user { name }
          }
        }
      }
    }
  }`;

  let result;
  try {
    result = await linearQuery(query);
  } catch (e) {
    log('ERROR', `Linear API 요청 실패: ${e.message}`);
    return;
  }

  if (result.errors) {
    log('ERROR', `Linear API 오류: ${JSON.stringify(result.errors[0].message)}`);
    return;
  }

  const issues = result.data?.issues?.nodes || [];
  log('INFO', `조회된 이슈 수: ${issues.length}`);

  for (const issue of issues) {
    const stateName = issue.state.name;
    const skillFile = ROUTE[stateName];

    if (!skillFile) continue;

    log('INFO', `처리 대상: ${issue.identifier} "${issue.title}" / 상태: ${stateName}`);

    // 중복 실행 방지
    const existing = loadState(issue.id);

    // 완료 후 새 활동(댓글 등)이 없으면 스킵, 있으면 재실행
    if (existing.lastCompletedState === stateName && existing.lastCompletedAt) {
      const completedAt = new Date(existing.lastCompletedAt).getTime();
      const updatedAt   = new Date(issue.updatedAt).getTime();
      if (!isNaN(completedAt) && updatedAt <= completedAt) {
        log('INFO', `완료 후 변경 없음, 스킵: ${issue.identifier} (${stateName})`);
        continue;
      }
      log('INFO', `완료 후 새 활동 감지 — 재실행: ${issue.identifier} (${stateName})`);
    }

    // 실행 중 (30분 미만) → 스킵, 초과 → 재실행
    if (existing.lastTriggeredState === stateName && existing.lastTriggeredAt) {
      const triggered = new Date(existing.lastTriggeredAt).getTime();
      if (!isNaN(triggered)) {
        const elapsed = Date.now() - triggered;
        if (elapsed < TRIGGER_TIMEOUT_MS) {
          log('INFO', `실행 중 (${Math.round(elapsed / 60000)}분 경과), 스킵: ${issue.identifier} (${stateName})`);
          continue;
        }
        log('INFO', `타임아웃 초과 (${Math.round(elapsed / 60000)}분) — 재실행: ${issue.identifier} (${stateName})`);
      }
    }

    // 프로젝트명 → slug/repo명 변환
    const projectName = issue.project?.name || 'default';
    const projectSlug = projectName.replace(/[^a-zA-Z0-9가-힣 _-]/g, '').trim();
    const repoName    = projectName.replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/ /g, '-');

    // 프로젝트별 포트 고정 할당
    const port = assignPort(projectSlug);
    if (!port) {
      log('ERROR', `포트 할당 실패: ${issue.identifier}`);
      continue;
    }

    const devDomain = PORT_DOMAIN[port];
    const devUrl    = `http://${devDomain}`;

    log('INFO', `포트: ${port} / URL: ${devUrl}`);

    saveState(issue.id, {
      issueId           : issue.id,
      identifier        : issue.identifier,
      title             : issue.title,
      label             : issue.labels?.nodes?.[0]?.name || 'feature',
      currentState      : stateName,
      projectName,
      projectSlug,
      repoName,
      projectDir        : `/workspace/${projectSlug}`,
      port,
      devUrl,
      lastTriggeredState: stateName,
      lastTriggeredAt   : new Date().toISOString(),
      lastCompletedState: null,
      lastCompletedAt   : null,
    });

    const state = loadState(issue.id);
    const latestComment = issue.comments?.nodes?.[0];

    const envVars = {
      ISSUE_ID              : issue.id,
      ISSUE_IDENTIFIER      : issue.identifier,
      ISSUE_TITLE           : issue.title,
      CURRENT_STATE         : stateName,
      PROJECT_NAME          : projectName,
      PROJECT_SLUG          : projectSlug,
      REPO_NAME             : repoName,
      PROJECT_DIR           : `/workspace/${projectSlug}`,
      PORT_INTERNAL         : String(port),
      DEV_URL               : devUrl,
      BRANCH_NAME           : state.branchName      || '',
      PR_NUMBER             : String(state.prNumber  || ''),
      PR_URL                : state.prUrl            || '',
      TEST_COMMENT_URL      : state.testCommentUrl   || '',
      REPORT_URL            : state.reportCommentUrl || '',
      LATEST_COMMENT        : latestComment?.body        || '',
      LATEST_COMMENT_AUTHOR : latestComment?.user?.name  || '',
      LATEST_COMMENT_AT     : latestComment?.createdAt   || '',
    };

    runSkill(skillFile, envVars);

    await new Promise(r => setTimeout(r, 2000));
  }

  log('INFO', '=== 폴링 완료 ===');
}

poll().catch(e => {
  log('ERROR', `예상치 못한 오류: ${e.message}`);
  process.exit(1);
});