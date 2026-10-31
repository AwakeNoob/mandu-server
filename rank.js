/**
 * ☠️ 독배 게임 랭크 (디스코드 전용)
 * 기록은 Upstash Redis(무료)에 저장해요. Render 환경변수:
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 * 랭킹은 디스코드 서버마다 따로예요.
 */

const DB_URL = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/$/, '');
const DB_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();

// ---------- 설정 ----------
const START = 1000;          // 처음 점수
const PLACEMENT = 3;         // 처음 3판은 배치 게임 (점수가 크게 움직여요)
const K_PLACEMENT = 48;
const K_NORMAL = 32;
const MIN_CHANGE = 5;        // 이기거나 지면 최소 5점은 움직여요
const STREAK_FROM = 3;       // 3연승부터
const STREAK_BONUS = 3;      // 이길 때마다 +3 보너스
const PAIR_LIMIT = 5;        // 같은 상대와 하루에 점수 반영되는 랭크전 수
const DB_WAIT = 1200;        // DB 대답 기다리는 최대 시간 (ms)

// 연회 신분 티어 (낮은 순)
const TIERS = [
  { min: -Infinity, name: '하인', icon: '🧹' },
  { min: 950, name: '시종', icon: '🍷' },
  { min: 1150, name: '기사', icon: '🛡️' },
  { min: 1300, name: '귀족', icon: '🎩' },
  { min: 1450, name: '영주', icon: '🏰' },
  { min: 1600, name: '국왕', icon: '👑' },
  { min: 1800, name: '독배의 군주', icon: '☠️' }
];

const status = { db: DB_URL && DB_TOKEN ? '연결 준비됨' : '꺼짐 (Upstash 연결 필요)', lastError: '' };

// ---------- DB (Upstash REST) ----------
let fetchImpl = (...a) => fetch(...a);
function setFetch(f) { fetchImpl = f; }
function enabled() { return !!(DB_URL && DB_TOKEN); }

async function pipeline(cmds, waitMs) {
  if (!enabled()) throw new Error('DB 꺼짐');
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = waitMs && ctrl ? setTimeout(() => ctrl.abort(), waitMs) : null;
  try {
    const res = await fetchImpl(DB_URL + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds.map(c => c.map(String))),
      signal: ctrl ? ctrl.signal : undefined
    });
    const text = await res.text();
    if (!res.ok) throw new Error('DB 오류 ' + res.status + ' ' + text.slice(0, 80));
    const data = JSON.parse(text);
    for (const d of data) if (d && d.error) throw new Error('DB 명령 오류 ' + d.error);
    status.db = '잘 작동 중 ✅';
    return data.map(d => d.result);
  } catch (e) {
    status.lastError = String(e.name === 'AbortError' ? 'DB 시간 초과' : e.message || e).slice(0, 120);
    status.db = '연결 오류 ❌ (' + status.lastError + ')';
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const pKey = (g, u) => 'p:' + g + ':' + u;
const lbKey = g => 'lb:' + g;
function today() { // 한국 날짜
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function parsePlayer(uid, name, arr) {
  // arr: HGETALL 결과 ['r','1000','w','3',...]
  const o = {};
  if (Array.isArray(arr)) for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1];
  const num = k => (o[k] === undefined ? 0 : Number(o[k]) || 0);
  return {
    uid, name: name || o.n || '손님',
    r: o.r === undefined ? START : num('r'),
    w: num('w'), l: num('l'), d: num('d'), s: num('s'),
    best: o.best === undefined ? START : num('best')
  };
}

async function loadPlayers(guild, list) {
  // list: [{uid, name}]
  const res = await pipeline(list.map(p => ['HGETALL', pKey(guild, p.uid)]), DB_WAIT);
  return list.map((p, i) => parsePlayer(p.uid, p.name, res[i]));
}

// 같은 두 사람이 오늘 몇 번째 랭크전인지 (1부터)
async function pairCount(guild, a, b) {
  const [x, y] = [a, b].sort();
  const key = 'pair:' + guild + ':' + x + ':' + y + ':' + today();
  const res = await pipeline([['INCR', key], ['EXPIRE', key, 172800]], DB_WAIT);
  return Number(res[0]) || 1;
}

// ---------- 점수 계산 ----------
function tierOf(r) {
  let t = TIERS[0], idx = 0;
  TIERS.forEach((x, i) => { if (r >= x.min) { t = x; idx = i; } });
  const next = TIERS[idx + 1] || null;
  return Object.assign({ idx, next }, t);
}
function tierText(r) { const t = tierOf(r); return t.icon + ' ' + t.name; }
function games(p) { return p.w + p.l + p.d; }

// result: 'A' A승, 'B' B승, 'D' 무승부. counted=false면 점수는 안 바뀌고 전적만
function compute(pa, pb, result, counted) {
  const out = { a: { old: pa.r, delta: 0, bonus: 0 }, b: { old: pb.r, delta: 0, bonus: 0 }, counted };
  if (counted) {
    const ea = 1 / (1 + Math.pow(10, (pb.r - pa.r) / 400));
    const sa = result === 'A' ? 1 : result === 'B' ? 0 : 0.5;
    const ka = games(pa) < PLACEMENT ? K_PLACEMENT : K_NORMAL;
    const kb = games(pb) < PLACEMENT ? K_PLACEMENT : K_NORMAL;
    let da = Math.round(ka * (sa - ea));
    let db = Math.round(kb * ((1 - sa) - (1 - ea)));
    if (sa === 1) { da = Math.max(MIN_CHANGE, da); db = Math.min(-MIN_CHANGE, db); }
    if (sa === 0) { da = Math.min(-MIN_CHANGE, da); db = Math.max(MIN_CHANGE, db); }
    out.a.delta = da; out.b.delta = db;
  }
  // 전적, 연승
  const apply = (p, o, won, lost) => {
    if (won) { p.w++; p.s = p.s > 0 ? p.s + 1 : 1; } else if (lost) { p.l++; p.s = p.s < 0 ? p.s - 1 : -1; } else { p.d++; p.s = 0; }
    if (counted && won && p.s >= STREAK_FROM) { o.bonus = STREAK_BONUS; o.delta += STREAK_BONUS; }
    p.r = Math.max(0, p.r + o.delta);
    if (p.r > p.best) p.best = p.r;
    o.now = p.r;
    o.tierUp = tierOf(p.r).idx > tierOf(o.old).idx;
    o.tierDown = tierOf(p.r).idx < tierOf(o.old).idx;
  };
  apply(pa, out.a, result === 'A', result === 'B');
  apply(pb, out.b, result === 'B', result === 'A');
  return out;
}

// ---------- 저장 (실패하면 잠시 뒤 다시) ----------
const retryQueue = [];
function saveCmds(guild, p) {
  return [
    ['HSET', pKey(guild, p.uid), 'r', p.r, 'w', p.w, 'l', p.l, 'd', p.d, 's', p.s, 'best', p.best, 'n', p.name],
    ['ZADD', lbKey(guild), p.r, p.uid]
  ];
}
async function save(guild, players) {
  const cmds = [].concat(...players.map(p => saveCmds(guild, p)));
  try { await pipeline(cmds, 5000); } catch (e) { retryQueue.push(cmds); }
}
async function flushRetries() {
  while (retryQueue.length) {
    const cmds = retryQueue[0];
    try { await pipeline(cmds, 5000); retryQueue.shift(); } catch (e) { return; }
  }
}

// ---------- 랭킹 / 내정보 ----------
async function top(guild, n) {
  const ids = await pipeline([['ZREVRANGE', lbKey(guild), 0, (n || 10) - 1, 'WITHSCORES'], ['ZCARD', lbKey(guild)]], 2000);
  const flat = ids[0] || [];
  const list = [];
  for (let i = 0; i < flat.length; i += 2) list.push({ uid: flat[i], r: Number(flat[i + 1]) });
  if (!list.length) return { list, total: Number(ids[1]) || 0 };
  const info = await pipeline(list.map(x => ['HMGET', pKey(guild, x.uid), 'n', 'w', 'l', 'd']), 2000);
  list.forEach((x, i) => {
    const v = info[i] || [];
    x.name = v[0] || '손님'; x.w = Number(v[1]) || 0; x.l = Number(v[2]) || 0; x.d = Number(v[3]) || 0;
  });
  return { list, total: Number(ids[1]) || 0 };
}

async function profile(guild, uid, name) {
  const res = await pipeline([
    ['HGETALL', pKey(guild, uid)],
    ['ZREVRANK', lbKey(guild), uid],
    ['ZCARD', lbKey(guild)]
  ], 2000);
  const p = parsePlayer(uid, name, res[0]);
  return { p, rank: res[1] === null || res[1] === undefined ? null : Number(res[1]) + 1, total: Number(res[2]) || 0, played: Array.isArray(res[0]) && res[0].length > 0 };
}

function progressBar(r) {
  const t = tierOf(r);
  if (!t.next) return '최고 티어! 👑';
  const lo = t.min === -Infinity ? t.next.min - 150 : t.min;
  const ratio = Math.max(0, Math.min(1, (r - lo) / (t.next.min - lo)));
  const filled = Math.round(ratio * 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled) + '  다음 ' + t.next.icon + ' ' + t.next.name + '까지 ' + (t.next.min - r) + '점';
}

function tierListText() {
  return TIERS.map((t, i) => t.icon + ' ' + t.name + ' — ' + (i === 0 ? TIERS[1].min - 1 + '점 이하' : t.min + '점' + (TIERS[i + 1] ? ' ~ ' + (TIERS[i + 1].min - 1) : ' 이상'))).join('\n');
}

module.exports = {
  enabled, status, setFetch, loadPlayers, pairCount, compute, save, flushRetries, top, profile,
  tierOf, tierText, progressBar, tierListText, games,
  START, PLACEMENT, PAIR_LIMIT, STREAK_FROM, STREAK_BONUS, TIERS
};
