// ============================================================
// Pitinvest Web · 공통 JS
// ============================================================

const REPO   = 'komubal-del/pitinvest-bot';
const BRANCH = 'main';
const REMOTE_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

// ?local 또는 ?mock 파라미터 있으면 로컬 모의 데이터 사용 (배포 전 테스트용)
const IS_LOCAL = new URLSearchParams(location.search).has('local')
              || new URLSearchParams(location.search).has('mock');
const BASE = IS_LOCAL ? './mock_data' : REMOTE_BASE;

const URLS = {
  master:     `${BASE}/master_data.json`,
  exit:       `${BASE}/exit_settings.json`,
  snapshot:   `${BASE}/current_snapshot.json`,
  history:    `${BASE}/pitinvest_history.csv`,
  rs_monitor: `${BASE}/rs_monitor.json`,
};

// --- Utils ---
const $  = (id)  => document.getElementById(id);
const qs = (sel) => document.querySelector(sel);

function fmt(n, d = 0) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: d, maximumFractionDigits: d
  });
}

function fmtPct(n, d = 1) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  return `${n > 0 ? '+' : ''}${Number(n).toFixed(d)}%`;
}

function fmtKrwUnit(n) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(1)}조`;
  if (abs >= 1e8)  return `${sign}${(abs / 1e8).toFixed(1)}억`;
  return `${sign}${fmt(abs)}`;
}

function _bust(url) {
  // raw.githubusercontent.com CDN 캐시 우회 (timestamp 쿼리 파라미터)
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 't=' + Date.now();
}

async function fetchJson(url) {
  const res = await fetch(_bust(url), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(_bust(url), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.text();
}

// RFC 4180 호환: 따옴표 안 콤마 / 이스케이프된 따옴표("") / 빈 셀 처리
function parseCSVRow(line) {
  const cols = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuote = false; }
      else { cur += c; }
    } else {
      if (c === '"') { inQuote = true; }
      else if (c === ',') { cols.push(cur); cur = ''; }
      else { cur += c; }
    }
  }
  cols.push(cur);
  return cols.map(s => s.trim());
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = parseCSVRow(lines[0]);
  return lines.slice(1).map(line => {
    const cols = parseCSVRow(line);
    const row = {};
    header.forEach((h, i) => row[h] = cols[i] != null ? cols[i] : '');
    return row;
  });
}

// --- Navigation ---
const NAV_ITEMS = [
  { id: 'home',     name: '홈',       icon: '🏔️', href: 'index.html' },
  { id: 'strategy', name: '전략',     icon: '📖', href: 'strategy.html' },
  { id: 'journal',  name: '일지',     icon: '📝', href: 'journal.html' },
  { id: 'history',  name: '히스토리', icon: '📈', href: 'history.html' },
  { id: 'rs',       name: '섹터',     icon: '📊', href: 'rs.html' },
  { id: 'chat',     name: '챗봇',     icon: '🤖', href: 'chat.html' },
];

function _href(p) {
  return IS_LOCAL ? `${p.href}?local` : p.href;
}

function renderTopNav(active) {
  const nav = $('top-nav');
  if (!nav) return;
  nav.innerHTML = NAV_ITEMS.map(p => {
    const on = p.id === active;
    return `<a href="${_href(p)}" class="px-3 py-2 text-sm font-semibold rounded-toss transition ${
      on ? 'text-toss-blue bg-toss-blueL' : 'text-toss-text hover:text-toss-dark hover:bg-white'
    }">${p.name}</a>`;
  }).join('');
}

function renderBottomNav(active) {
  const nav = $('bottom-nav');
  if (!nav) return;
  nav.innerHTML = NAV_ITEMS.map(p => {
    const on = p.id === active;
    return `<a href="${_href(p)}" class="flex flex-col items-center gap-0.5 py-2 flex-1 ${
      on ? 'text-toss-blue' : 'text-toss-sub'
    }">
      <span class="text-xl">${p.icon}</span>
      <span class="text-xs font-semibold">${p.name}</span>
    </a>`;
  }).join('');
}

function renderHeader(active) {
  const header = $('app-header');
  if (!header) return;
  header.innerHTML = `
    <div class="max-w-6xl mx-auto px-5 py-4 flex items-center justify-between">
      <a href="index.html${IS_LOCAL ? '?local' : ''}" class="flex items-center gap-2">
        <div class="w-8 h-8 rounded-toss bg-toss-blue flex items-center justify-center">
          <span class="text-white text-lg">🏔️</span>
        </div>
        <span class="font-bold text-lg">구덩이매매법</span>
        <span class="chip bg-toss-blueL text-toss-blue ml-1">v5.0</span>
        ${IS_LOCAL ? '<span class="chip bg-toss-yellowL text-toss-yellow ml-1">LOCAL</span>' : ''}
      </a>
      <nav id="top-nav" class="flex items-center gap-1"></nav>
    </div>
  `;
  renderTopNav(active);
}

function initNav(active) {
  renderHeader(active);
  renderBottomNav(active);
}

// --- 상태 판정 로직 (봇이 계산한 display stage_key 우선 사용) ---
const STAGE_INFO = {
  emergency: { label: '긴급탈출',       color: 'red',    desc: '나스닥/S&P/코스피 −10% 도달 · 위성 전량 청산 (코어 유지)' },
  reset:     { label: '자동 리셋 직후', color: 'blue',   desc: '매도 3조건 모두 충족 · 위성 0% (코어 유지)' },
  sell_near: { label: '매도 임박',      color: 'red',    desc: '매도 2조건 충족 · 위성 −33%p 추가, 마지막 조건 대기' },
  exit:      { label: '구덩이 탈출',    color: 'orange', desc: '매도 1조건 충족 · 위성 −33%p 매도 (1/3 step)' },
  full:      { label: '구덩이 충족',    color: 'red',    desc: '매수 3조건 모두 충족 · 카운터 리셋 (위성 100% cap)' },
  deepening: { label: '구덩이 심화',    color: 'purple', desc: '매수 2조건 충족 · 위성 +33%p 추가 매수' },
  entry:     { label: '구덩이 진입',    color: 'yellow', desc: '매수 1조건 충족 · 위성 +33%p 매수 (1/3 step)' },
  normal:    { label: '평시 운용',      color: 'green',  desc: '다음 구덩이 대기' },
};

function determineStage(snapshot, _positionRatio /* unused, 보존용 */) {
  const sig = snapshot?.signals || {};
  // 봇이 이미 display stage 판정 (전일 동일 시 normal) → 직접 사용
  const key = sig.stage_key || 'normal';
  const info = STAGE_INFO[key] || STAGE_INFO.normal;
  return { key, ...info };
}

const STAGE_STYLE = {
  red:    { dot: 'bg-toss-red',    chipBg: 'bg-toss-redL',    chipTx: 'text-toss-red' },
  yellow: { dot: 'bg-toss-yellow', chipBg: 'bg-toss-yellowL', chipTx: 'text-toss-yellow' },
  green:  { dot: 'bg-toss-green',  chipBg: 'bg-toss-greenL',  chipTx: 'text-toss-green' },
  purple: { dot: 'bg-toss-purple', chipBg: 'bg-toss-purpleL', chipTx: 'text-toss-purple' },
  blue:   { dot: 'bg-toss-blue',   chipBg: 'bg-toss-blueL',   chipTx: 'text-toss-blue'   },
  orange: { dot: 'bg-toss-orange', chipBg: 'bg-toss-orangeL', chipTx: 'text-toss-orange' },
};

// --- 비중 파싱 ---
function parseRatio(raw) {
  if (!raw || typeof raw !== 'string') return [0, 0, 0];
  const parts = raw.split(':').map(s => parseInt(s, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

// Expose
window.PI = {
  URLS, $, qs,
  fmt, fmtPct, fmtKrwUnit,
  fetchJson, fetchText, parseCSV,
  initNav, determineStage, STAGE_STYLE, parseRatio,
};
