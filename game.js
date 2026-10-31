/**
 * 게임 규칙 (카카오 복불복 만두, 디스코드 독배 게임 공용)
 * 규칙을 바꾸려면 이 파일만 고치면 둘 다 바뀌어요. 겉모습(문구, 그림)은 themes.js
 */
const THEMES = require('./themes.js');
const DEFAULT_THEME = THEMES.MANDU;
const MAX_ITEMS = 8;
const MAX_HP = 5;
const FIRST_ROUND_MIN = 3;   // 첫 찜기 만두 최소 개수
const FIRST_ROUND_MAX = 4;   // 첫 찜기 만두 최대 개수
const ROUND_MIN = 4;         // 그다음 찜기 만두 최소 개수
const ROUND_MAX = 8;         // 그다음 찜기 만두 최대 개수
const MAX_GAP = 3;           // 매운 만두와 일반 만두 개수 차이 최대
const ITEMS_FIRST_ROUND = 2; // 첫 찜기 때 받는 아이템 수
const ITEMS_PER_ROUND = 3;   // 그다음 찜기부터 받는 아이템 수

// 청양고추 만두로 부메랑 가진 사람을 먹였을 때: 'break' | 'hurt' | 'one'
const CHILI_VS_BOOMERANG = 'break';

const ITEM_LIST = ['투시안경', '젓가락', '청양고추', '우유', '자장가', '마법소스', '복불복젤리', '뺏어먹기', '바꿔치기', '부메랑'];
const ICON = {}, ITEM_IMG = {}, ITEM_DESC = {};
for (const k of ITEM_LIST) { const it = DEFAULT_THEME.items[k]; ICON[k] = it.icon; ITEM_IMG[k] = it.img; ITEM_DESC[k] = it.desc; }
const ALIAS = { '안경': '투시안경', '고추': '청양고추', '소스': '마법소스', '젤리': '복불복젤리', '뺏기': '뺏어먹기' };

// 한 번에 여러 일이 일어나면 가장 중요한 장면의 그림을 보여줘요 (숫자가 클수록 중요)
const PRIORITY = {
  ev_win: 100, ev_draw: 95, ev_reflect: 85, ev_chili_break: 80, ev_spicy: 70, ev_match: 65,
  ev_sleep: 55, ev_normal: 45, ev_steamer: 40
};
function prio(img) { return (img && PRIORITY[img.replace(/^p_/, '')]) || (img ? 50 : 0); }

// ---------- 도구 ----------
function rand(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function label(spicy, T) { return (T || DEFAULT_THEME).shell(spicy); }
function hearts(hp, T) { T = T || DEFAULT_THEME; const h = Math.max(0, hp); return T.hpFull.repeat(h) + T.hpEmpty.repeat(MAX_HP - h); }
function resolveItem(n) { if (!n) return null; if (ALIAS[n]) return ALIAS[n]; return ITEM_LIST.includes(n) ? n : null; }
function removeOne(arr, v) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); }
function bag(items, T) {
  T = T || DEFAULT_THEME;
  if (!items.length) return '없음';
  const count = {};
  for (const i of items) count[i] = (count[i] || 0) + 1;
  return Object.keys(count).map(i => T.items[i].icon + T.items[i].name + (count[i] > 1 ? '×' + count[i] : '')).join(' ');
}
function itemName(it, T) { return (T || DEFAULT_THEME).items[it].name; }
function cut(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// 게임마다 화면 쪽에서 넣어주는 함수: g.nameOf(p), g.emit(p, text, img)  (p가 null이면 둘 다에게)
function name(g, p) { return g.nameOf(p); }
function all(g, t, img) { g.emit(null, t, img); }
function only(g, p, t, img) { g.emit(p, t, img); }
function M(g) { return g.T.m; }
function EV(g, key) { return g.T.img(key); }

// ---------- 게임 로직 ----------
function reload(g) {
  g.round = (g.round || 0) + 1;
  const first = g.round === 1;
  // 첫 찜기는 3~4개, 그다음부터 4~8개. 매운/일반 개수 차이는 최대 MAX_GAP개
  let total, spicy;
  do {
    total = first ? rand(FIRST_ROUND_MIN, FIRST_ROUND_MAX) : rand(ROUND_MIN, ROUND_MAX);
    spicy = rand(1, total - 1);
  } while (Math.abs(spicy - (total - spicy)) > MAX_GAP);
  const s = [];
  for (let i = 0; i < total; i++) s.push(i < spicy);
  g.shells = shuffle(s);
  all(g, M(g).steamer(g.round, spicy, total - spicy), EV(g, 'ev_steamer'));
  const n = first ? ITEMS_FIRST_ROUND : ITEMS_PER_ROUND;
  for (let p = 0; p < 2; p++) {
    const got = [];
    for (let k = 0; k < n; k++) {
      if (g.items[p].length >= MAX_ITEMS) break;
      const it = ITEM_LIST[rand(0, ITEM_LIST.length - 1)];
      g.items[p].push(it);
      got.push(it);
    }
    all(g, M(g).gift(name(g, p), got.length ? bag(got, g.T) : M(g).bagFull));
  }
}

// 결과: -1 계속, 0/1 승자 번호, -2 무승부
function endRound(g) {
  const dead = [];
  for (let p = 0; p < 2; p++) {
    if (g.boomerang[p]) {
      g.hp[p] -= 1;
      all(g, M(g).boomerangCost(name(g, p)), g.T.items['부메랑'].img);
      if (g.hp[p] <= 0) dead.push(p);
    }
  }
  g.boomerang = [false, false];
  if (dead.length === 2) return -2;
  if (dead.length === 1) return 1 - dead[0];
  reload(g);
  return -1;
}

function nextTurn(g) {
  const other = 1 - g.turn;
  if (g.asleep[other]) {
    g.asleep[other] = false;
    all(g, M(g).sleepSkip(name(g, other)), EV(g, 'ev_sleep'));
  } else {
    g.turn = other;
  }
}

function eat(g, idx, self) {
  const spicy = g.shells.shift();
  const chili = g.chili;
  const dmg = chili ? 2 : 1;
  g.chili = false;
  const target = self ? idx : 1 - idx;
  all(g, self ? M(g).eatSelf(name(g, idx)) : M(g).eatFeed(name(g, idx), name(g, target)));

  if (spicy) {
    if (!self && g.boomerang[target]) {
      g.boomerang[target] = false;
      if (chili && CHILI_VS_BOOMERANG === 'break') {
        all(g, M(g).chiliBreak, EV(g, 'ev_chili_break'));
      } else if (chili && CHILI_VS_BOOMERANG === 'hurt') {
        g.hp[target] -= dmg;
        all(g, M(g).boomerangHurt(name(g, target), dmg), EV(g, 'ev_spicy'));
        if (g.hp[target] <= 0) return idx;
      } else {
        const back = (chili && CHILI_VS_BOOMERANG === 'one') ? 1 : dmg;
        g.hp[idx] -= back;
        all(g, M(g).reflect(name(g, idx), back), EV(g, 'ev_reflect'));
        if (g.hp[idx] <= 0) return target;
      }
    } else {
      g.hp[target] -= dmg;
      all(g, M(g).hit(name(g, target), dmg), EV(g, 'ev_spicy'));
      if (g.hp[target] <= 0) return 1 - target;
    }
    nextTurn(g);
  } else {
    all(g, self ? M(g).safeSelf(name(g, idx)) : M(g).safeFeed, EV(g, 'ev_normal'));
    if (!self) nextTurn(g);
  }
  if (g.shells.length === 0) return endRound(g);
  return -1;
}

// 실패 {err}, 결과 {result}, 이미 가방에서 뺐으면 {consumed}
function applyEffect(g, idx, it) {
  const me = name(g, idx);
  const opp = 1 - idx;
  const img = g.T.items[it].img;
  const m = M(g);
  switch (it) {
    case '투시안경':
      all(g, m.glassesAll(me), img);
      only(g, idx, m.glassesMe(label(g.shells[0], g.T)), img);
      break;
    case '젓가락': {
      const out = g.shells.shift();
      all(g, m.chopsticks(label(out, g.T)), img);
      if (g.shells.length === 0) {
        const r = endRound(g);
        if (r !== -1) return { result: r };
      }
      break;
    }
    case '청양고추':
      if (g.chili) return { err: m.chiliErr };
      g.chili = true;
      all(g, m.chili(me), img);
      break;
    case '우유':
      if (g.hp[idx] >= MAX_HP) all(g, m.milkFull(me), img);
      else { g.hp[idx] += 1; all(g, m.milk(me), img); }
      break;
    case '자장가':
      if (g.asleep[opp]) return { err: m.sleepErr };
      g.asleep[opp] = true;
      all(g, m.sleep(me, name(g, opp)), img);
      break;
    case '마법소스':
      g.shells[0] = !g.shells[0];
      all(g, m.sauce(me), img);
      break;
    case '복불복젤리':
      if (Math.random() < 0.4) {
        g.hp[idx] = Math.min(MAX_HP, g.hp[idx] + 2);
        all(g, m.jellyGood(me), img);
      } else {
        g.hp[idx] -= 1;
        all(g, m.jellyBad(me), img);
        if (g.hp[idx] <= 0) return { result: opp };
      }
      break;
    case '부메랑':
      if (g.boomerang[idx]) return { err: m.boomErr };
      g.boomerang[idx] = true;
      all(g, m.boom(me), img);
      break;
    case '바꿔치기': {
      const mine = g.items[idx], theirs = g.items[opp];
      removeOne(mine, '바꿔치기');
      const k = Math.min(mine.length, theirs.length);
      if (mine.length === 0) { mine.push('바꿔치기'); return { err: m.swapNoMine }; }
      if (k === 0) { mine.push('바꿔치기'); return { err: m.swapNoTheirs }; }
      shuffle(mine); shuffle(theirs);
      const give = mine.splice(0, k), take = theirs.splice(0, k);
      mine.push(...take); theirs.push(...give);
      all(g, m.swap(k), img);
      return { consumed: true };
    }
  }
  return {};
}


function endGame(g, result) {
  if (g.over) return;
  g.over = true;
  if (result === -2) {
    all(g, M(g).draw, EV(g, 'ev_draw'));
  } else {
    all(g, M(g).win(name(g, result)), EV(g, 'ev_win'));
    all(g, M(g).lose(name(g, 1 - result)));
  }
  if (g.onEnd) g.onEnd(result);
}

// 새 게임 만들기. opts: { players: [id, id], nameOf, emit, onEnd, T(테마, 없으면 만두) }
function createGame(opts) {
  const g = Object.assign({
    hp: [MAX_HP, MAX_HP], items: [[], []], asleep: [false, false], boomerang: [false, false],
    chili: false, shells: [], round: 0, turn: rand(0, 1), last: Date.now(), over: false, idle: [0, 0]
  }, opts);
  if (!g.T) g.T = DEFAULT_THEME;
  all(g, M(g).match(name(g, 0), name(g, 1)), EV(g, 'ev_match'));
  reload(g);
  all(g, M(g).first(name(g, g.turn)));
  return g;
}

// 먹기/먹이기. 끝나면 endGame까지 처리
function doEat(g, idx, self) {
  g.last = Date.now();
  g.idle[idx] = 0;
  const r = eat(g, idx, self);
  if (r !== -1) endGame(g, r);
  return r;
}

// 뺏어먹기로 뺏을 수 있는 상대 아이템
function stealChoices(g, idx) {
  return g.items[1 - idx].filter(x => x !== '뺏어먹기' && x !== '바꿔치기');
}

// 아이템 사용. 결과: {err} 실패 / {needSteal: [...]} 뺏을 아이템 고르기 필요 / {} 성공
function useItem(g, idx, it, steal) {
  if (!it) return { err: '아이템 이름을 확인해 주세요.' };
  if (!g.items[idx].includes(it)) return { err: M(g).noItem(itemName(it, g.T)) };
  let res;
  if (it === '뺏어먹기') {
    const choices = stealChoices(g, idx);
    if (!steal) {
      if (!choices.length) return { err: M(g).stealNone };
      return { needSteal: choices };
    }
    if (!choices.includes(steal)) return { err: M(g).stealBad(itemName(steal, g.T)) };
    g.last = Date.now();
    g.idle[idx] = 0;
    all(g, M(g).stealDone(name(g, idx), itemName(steal, g.T)), g.T.items['뺏어먹기'].img);
    res = applyEffect(g, idx, steal);
    if (res.err) return res;
    removeOne(g.items[idx], '뺏어먹기');
    removeOne(g.items[1 - idx], steal);
  } else {
    g.last = Date.now();
    g.idle[idx] = 0;
    res = applyEffect(g, idx, it);
    if (res.err) return res;
    if (!res.consumed) removeOne(g.items[idx], it);
  }
  if (res.result !== undefined) endGame(g, res.result);
  return {};
}

function forfeit(g, idx) {
  all(g, '🏳️ ' + name(g, idx) + '님이 항복했어요.');
  endGame(g, 1 - idx);
}

const AFK_LOSE = 2; // 연속으로 이만큼 시간 초과하면 패배

function timeText(ms) {
  const sec = Math.round(ms / 1000), m = Math.floor(sec / 60), s = sec % 60;
  return (m ? m + '분' : '') + (m && s ? ' ' : '') + (s ? s + '초' : '');
}

// 차례인 사람이 시간 안에 안 했을 때: 차례 건너뛰기, 연속 AFK_LOSE번이면 패배
// limitMs: 제한 시간, now: 지금 시각. 결과: 'none' | 'skip' | 'lose'
function checkAfk(g, limitMs, now) {
  now = now || Date.now();
  let happened = 'none';
  while (!g.over && now - g.last > limitMs) {
    const p = g.turn;
    g.idle[p] = (g.idle[p] || 0) + 1;
    g.stealing = false;
    if (g.idle[p] >= AFK_LOSE) {
      all(g, '⏰ ' + name(g, p) + '님이 ' + AFK_LOSE + '번 연속으로 시간 초과! 자리를 비운 걸로 보고 패배');
      endGame(g, 1 - p);
      return 'lose';
    }
    all(g, '⏰ ' + name(g, p) + '님이 ' + timeText(limitMs) + ' 동안 안 해서 차례를 건너뜀 (한 번 더 놓치면 패배!)');
    g.last += limitMs;
    nextTurn(g);
    happened = 'skip';
  }
  return happened;
}

function timeout(g, minutes) {
  all(g, '⏰ ' + name(g, g.turn) + '님이 ' + minutes + '분 동안 응답이 없어서 시간 초과!');
  endGame(g, 1 - g.turn);
}

// 튜토리얼 2, 3장 (테마별). 1장은 화면마다 조작법이 달라서 각자 만들어요
const RULE_CONST = { MAX_ITEMS, MAX_HP, FIRST_ROUND_MIN, FIRST_ROUND_MAX, ROUND_MIN, ROUND_MAX };
function rulesCommon(T) { return (T || DEFAULT_THEME).rulesCommon(RULE_CONST); }
function rulesBasics(T) { return (T || DEFAULT_THEME).rulesBasics(RULE_CONST); }

module.exports = {
  MAX_HP, MAX_ITEMS, ITEM_LIST, ICON, ITEM_IMG, ITEM_DESC, ALIAS, PRIORITY, THEMES,
  prio, label, hearts, bag, cut, resolveItem, itemName,
  createGame, doEat, useItem, stealChoices, forfeit, timeout, checkAfk, timeText, AFK_LOSE, endGame,
  rulesCommon, rulesBasics
};
