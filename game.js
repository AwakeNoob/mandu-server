/**
 * 복불복 만두 - 게임 규칙 (카카오, 디스코드 공용)
 * 규칙을 바꾸려면 이 파일만 고치면 둘 다 바뀌어요.
 */
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
const ICON = {
  '투시안경': '👓', '젓가락': '🥢', '청양고추': '🌶️', '우유': '🥛', '자장가': '🎵',
  '마법소스': '🪄', '복불복젤리': '🍬', '뺏어먹기': '🤲', '바꿔치기': '🔁', '부메랑': '🪃'
};
const ITEM_IMG = {
  '투시안경': 'it_glasses', '젓가락': 'it_chopsticks', '청양고추': 'it_chili', '우유': 'it_milk', '자장가': 'it_lullaby',
  '마법소스': 'it_sauce', '복불복젤리': 'it_jelly', '뺏어먹기': 'it_grab', '바꿔치기': 'it_swap', '부메랑': 'it_boomerang'
};
const ALIAS = { '안경': '투시안경', '고추': '청양고추', '소스': '마법소스', '젤리': '복불복젤리', '뺏기': '뺏어먹기' };
const ITEM_DESC = {
  '투시안경': '지금 만두가 매운지 확인 (나만 보여요)',
  '젓가락': '지금 만두를 집어서 빼버림',
  '청양고추': '다음 매운 만두가 2배로 매움',
  '우유': '참을성 +1',
  '자장가': '상대가 잠들어서 다음 차례를 건너뜀',
  '마법소스': '지금 만두를 매운↔일반으로 바꿈',
  '복불복젤리': '40% 참을성 +2 / 60% 참을성 -1',
  '뺏어먹기': '상대 아이템 하나를 뺏어서 바로 사용',
  '바꿔치기': '내 아이템 수만큼 상대 것과 무작위 교환',
  '부메랑': '나에게 먹인 매운 만두 1개를 되돌림. 못 쓰고 찜기가 비면 -1'
};

// 한 번에 여러 일이 일어나면 가장 중요한 장면의 그림을 보여줘요 (숫자가 클수록 중요)
const PRIORITY = {
  ev_win: 100, ev_draw: 95, ev_reflect: 85, ev_chili_break: 80, ev_spicy: 70, ev_match: 65,
  ev_sleep: 55, ev_normal: 45, ev_steamer: 40
};
function prio(img) { return PRIORITY[img] || (img ? 50 : 0); }

// ---------- 도구 ----------
function rand(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function label(spicy) { return spicy ? '🌶️매운 만두' : '🥟일반 만두'; }
function hearts(hp) { const h = Math.max(0, hp); return '❤️'.repeat(h) + '🤍'.repeat(MAX_HP - h); }
function resolveItem(n) { if (!n) return null; if (ALIAS[n]) return ALIAS[n]; return ITEM_LIST.includes(n) ? n : null; }
function removeOne(arr, v) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); }
function bag(items) {
  if (!items.length) return '없음';
  const count = {};
  for (const i of items) count[i] = (count[i] || 0) + 1;
  return Object.keys(count).map(i => ICON[i] + i + (count[i] > 1 ? '×' + count[i] : '')).join(' ');
}
function cut(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// 게임마다 화면 쪽에서 넣어주는 함수: g.nameOf(p), g.emit(p, text, img)  (p가 null이면 둘 다에게)
function name(g, p) { return g.nameOf(p); }
function all(g, t, img) { g.emit(null, t, img); }
function only(g, p, t, img) { g.emit(p, t, img); }

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
  all(g, '♨️ ' + g.round + '번째 찜기 등장! 매운 만두 ' + spicy + '개, 일반 만두 ' + (total - spicy) + '개', 'ev_steamer');
  const n = first ? ITEMS_FIRST_ROUND : ITEMS_PER_ROUND;
  for (let p = 0; p < 2; p++) {
    const got = [];
    for (let k = 0; k < n; k++) {
      if (g.items[p].length >= MAX_ITEMS) break;
      const it = ITEM_LIST[rand(0, ITEM_LIST.length - 1)];
      g.items[p].push(it);
      got.push(it);
    }
    all(g, '🎁 ' + name(g, p) + ': ' + (got.length ? bag(got) : '가방이 가득 참'));
  }
}

// 결과: -1 계속, 0/1 승자 번호, -2 무승부
function endRound(g) {
  const dead = [];
  for (let p = 0; p < 2; p++) {
    if (g.boomerang[p]) {
      g.hp[p] -= 1;
      all(g, '🪃 ' + name(g, p) + '님은 부메랑을 못 써먹었다... 참을성 -1', 'it_boomerang');
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
    all(g, '💤 ' + name(g, other) + '님은 자느라 차례를 건너뜀!', 'ev_sleep');
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
  all(g, self ? '🥢 ' + name(g, idx) + '님이 만두를 먹었다'
              : '🥢 ' + name(g, idx) + '님이 ' + name(g, target) + '님에게 만두를 먹였다');

  if (spicy) {
    if (!self && g.boomerang[target]) {
      g.boomerang[target] = false;
      if (chili && CHILI_VS_BOOMERANG === 'break') {
        all(g, '🪃💥 청양고추 열기에 부메랑이 부서졌다! 아무 일도 없었다', 'ev_chili_break');
      } else if (chili && CHILI_VS_BOOMERANG === 'hurt') {
        g.hp[target] -= dmg;
        all(g, '🪃💥 부메랑이 버티지 못했다! ' + name(g, target) + ' 참을성 -' + dmg, 'ev_spicy');
        if (g.hp[target] <= 0) return idx;
      } else {
        const back = (chili && CHILI_VS_BOOMERANG === 'one') ? 1 : dmg;
        g.hp[idx] -= back;
        all(g, '🪃 부메랑! 매운 만두가 되돌아갔다! ' + name(g, idx) + ' 참을성 -' + back, 'ev_reflect');
        if (g.hp[idx] <= 0) return target;
      }
    } else {
      g.hp[target] -= dmg;
      all(g, '🥵 으아 매워! ' + name(g, target) + ' 참을성 -' + dmg, 'ev_spicy');
      if (g.hp[target] <= 0) return 1 - target;
    }
    nextTurn(g);
  } else {
    all(g, self ? '😋 냠냠, 일반 만두! ' + name(g, idx) + '님 한 번 더!' : '😋 냠냠, 일반 만두였다!', 'ev_normal');
    if (!self) nextTurn(g);
  }
  if (g.shells.length === 0) return endRound(g);
  return -1;
}

// 실패 {err}, 결과 {result}, 이미 가방에서 뺐으면 {consumed}
function applyEffect(g, idx, it) {
  const me = name(g, idx);
  const opp = 1 - idx;
  const img = ITEM_IMG[it];
  switch (it) {
    case '투시안경':
      all(g, '👓 ' + me + '님이 투시안경으로 만두를 살펴봤다', img);
      only(g, idx, '👀 나만 보여요: 지금 만두는 ' + label(g.shells[0]) + '!', img);
      break;
    case '젓가락': {
      const out = g.shells.shift();
      all(g, '🥢 쏙! 만두를 빼냈다: ' + label(out), img);
      if (g.shells.length === 0) {
        const r = endRound(g);
        if (r !== -1) return { result: r };
      }
      break;
    }
    case '청양고추':
      if (g.chili) return { err: '이미 청양고추가 들어가 있어요.' };
      g.chili = true;
      all(g, '🌶️ ' + me + '님이 청양고추 투하! 다음 매운 만두는 2배', img);
      break;
    case '우유':
      if (g.hp[idx] >= MAX_HP) all(g, '🥛 ' + me + '님이 우유를 마셨지만 이미 가득 참', img);
      else { g.hp[idx] += 1; all(g, '🥛 ' + me + '님 꿀꺽! 참을성 +1', img); }
      break;
    case '자장가':
      if (g.asleep[opp]) return { err: '상대는 이미 자고 있어요.' };
      g.asleep[opp] = true;
      all(g, '🎵 자장자장~ ' + name(g, opp) + '님이 잠들었다!', img);
      break;
    case '마법소스':
      g.shells[0] = !g.shells[0];
      all(g, '🪄 ' + me + '님의 마법소스! 지금 만두가 뒤바뀌었다', img);
      break;
    case '복불복젤리':
      if (Math.random() < 0.4) {
        g.hp[idx] = Math.min(MAX_HP, g.hp[idx] + 2);
        all(g, '🍬 ' + me + '님: 달콤하다! 참을성 +2', img);
      } else {
        g.hp[idx] -= 1;
        all(g, '🍬 ' + me + '님: 으엑, 엄청 신 젤리! 참을성 -1', img);
        if (g.hp[idx] <= 0) return { result: opp };
      }
      break;
    case '부메랑':
      if (g.boomerang[idx]) return { err: '이미 부메랑을 들고 있어요.' };
      g.boomerang[idx] = true;
      all(g, '🪃 ' + me + '님이 부메랑을 들었다! 다음 매운 만두를 되돌린다', img);
      break;
    case '바꿔치기': {
      const mine = g.items[idx], theirs = g.items[opp];
      removeOne(mine, '바꿔치기');
      const k = Math.min(mine.length, theirs.length);
      if (mine.length === 0) { mine.push('바꿔치기'); return { err: '줄 아이템이 없어서 바꿔치기를 쓸 수 없어요.' }; }
      if (k === 0) { mine.push('바꿔치기'); return { err: '상대 가방이 비어 있어요.' }; }
      shuffle(mine); shuffle(theirs);
      const give = mine.splice(0, k), take = theirs.splice(0, k);
      mine.push(...take); theirs.push(...give);
      all(g, '🔁 바꿔치기! 아이템 ' + k + '개를 무작위로 맞바꿨다', img);
      return { consumed: true };
    }
  }
  return {};
}


function endGame(g, result) {
  if (g.over) return;
  g.over = true;
  if (result === -2) {
    all(g, '😵 둘 다 쓰러졌다... 무승부!', 'ev_draw');
  } else {
    all(g, '🏆 ' + name(g, result) + '님 승리!', 'ev_win');
    all(g, '😵 ' + name(g, 1 - result) + '님은 더는 못 먹겠다...');
  }
  if (g.onEnd) g.onEnd(result);
}

// 새 게임 만들기. opts: { players: [id, id], nameOf, emit, onEnd }
function createGame(opts) {
  const g = Object.assign({
    hp: [MAX_HP, MAX_HP], items: [[], []], asleep: [false, false], boomerang: [false, false],
    chili: false, shells: [], round: 0, turn: rand(0, 1), last: Date.now(), over: false
  }, opts);
  all(g, '⚔️ 매칭 성공! ' + name(g, 0) + ' vs ' + name(g, 1), 'ev_match');
  reload(g);
  all(g, '🎲 선공은 ' + name(g, g.turn) + '님!');
  return g;
}

// 먹기/먹이기. 끝나면 endGame까지 처리
function doEat(g, idx, self) {
  g.last = Date.now();
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
  if (!g.items[idx].includes(it)) return { err: '가방에 ' + it + '이(가) 없어요.' };
  let res;
  if (it === '뺏어먹기') {
    const choices = stealChoices(g, idx);
    if (!steal) {
      if (!choices.length) return { err: '상대 가방에 뺏을 수 있는 아이템이 없어요.' };
      return { needSteal: choices };
    }
    if (!choices.includes(steal)) return { err: steal + '은(는) 뺏을 수 없어요.' };
    g.last = Date.now();
    all(g, '🤲 ' + name(g, idx) + '님이 상대의 ' + steal + '을(를) 뺏어 먹었다!', 'it_grab');
    res = applyEffect(g, idx, steal);
    if (res.err) return res;
    removeOne(g.items[idx], '뺏어먹기');
    removeOne(g.items[1 - idx], steal);
  } else {
    g.last = Date.now();
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

function timeout(g, minutes) {
  all(g, '⏰ ' + name(g, g.turn) + '님이 ' + minutes + '분 동안 응답이 없어서 시간 초과!');
  endGame(g, 1 - g.turn);
}

// 튜토리얼 2, 3장 (공용). 1장은 화면마다 조작법이 달라서 각자 만들어요
function rulesCommon() {
  const part2 = '📖 튜토리얼 (2/3) 아이템\n\n' +
    '• 첫 찜기 때 아이템 2개, 다음 찜기부터 3개씩 받아요\n' +
    '• 가방에는 최대 ' + MAX_ITEMS + '개까지 들어가요. 가득 차면 더 못 받아요\n' +
    '• 아이템은 내 차례에만 쓸 수 있어요\n' +
    '• 서로의 가방은 다 보여요\n\n' +
    '👓 투시안경: 지금 나올 만두가 매운지 확인. 결과는 나만 보여요\n' +
    '🥢 젓가락: 지금 만두를 빼서 버려요. 뭐였는지는 둘 다 봐요\n' +
    '🌶️ 청양고추: 다음 만두가 매운 만두면 참을성 -2. 일반 만두면 그냥 사라져요\n' +
    '🥛 우유: 참을성 +1 (최대 ' + MAX_HP + '칸을 넘지 않아요)\n' +
    '🎵 자장가: 상대가 잠들어서 다음 차례를 1번 건너뛰어요\n' +
    '🪄 마법소스: 지금 만두를 매운↔일반으로 바꿔요\n' +
    '🍬 복불복젤리: 40% 확률로 참을성 +2, 60% 확률로 -1\n' +
    '🤲 뺏어먹기: 상대 아이템 하나를 뺏어서 바로 써요 (뺏어먹기·바꿔치기는 못 뺏음)\n' +
    '🔁 바꿔치기: 내 아이템 개수만큼 상대 아이템과 무작위로 맞바꿔요. 내 가방이 비어 있으면 못 써요\n' +
    '🪃 부메랑: 들고 있으면 상대가 나에게 먹인 매운 만두 1개를 먹인 사람에게 되돌려요\n' +
    ' - 되돌리기에 성공하면 부메랑은 사라지고 대가 없음\n' +
    ' - 끝까지 못 쓰고 찜기가 비면 내 참을성 -1\n' +
    ' - 청양고추 만두를 맞으면 부메랑만 부서지고 아무 일 없음\n' +
    ' - 되돌아간 만두는 상대 부메랑이 다시 되돌리지 못해요\n' +
    ' - 둘 다 부메랑 대가로 동시에 쓰러지면 무승부';
  const part3 = '📖 튜토리얼 (3/3) 꿀팁\n\n' +
    '💡 남은 만두를 세세요\n' +
    '찜기마다 매운/일반 개수를 알려주니까, 지금까지 나온 만두를 빼면 남은 게 뭔지 알 수 있어요. 남은 게 전부 일반 만두면 계속 먹어서 차례를 이어가세요!\n\n' +
    '💡 확률로 판단하세요\n' +
    '남은 만두 중 매운 만두가 많으면 먹이기, 일반 만두가 많으면 먹기가 유리해요\n\n' +
    '💡 마지막 만두로 다음 라운드 선공 잡기\n' +
    '찜기가 비어도 차례는 그대로 이어져요. 그래서 마지막 만두를\n' +
    ' - 상대에게 먹이면 → 다음 찜기는 상대가 먼저 시작\n' +
    ' - 내가 일반 만두를 먹으면 → 다음 찜기는 내가 먼저 시작\n' +
    ' - 젓가락으로 빼면 → 차례가 안 넘어가니까 내가 먼저 시작\n' +
    '새 찜기를 먼저 시작하면 아이템을 먼저 쓸 수 있어서 유리해요!\n\n' +
    '💡 아이템 조합\n' +
    ' - 투시안경으로 보고 매운 만두면 먹이기, 일반 만두면 먹기\n' +
    ' - 투시안경 + 마법소스: 일반 만두를 매운 만두로 바꿔서 먹이기\n' +
    ' - 청양고추는 매운 만두인 걸 확인하고 쓰면 낭비가 없어요\n' +
    ' - 자장가를 쓰면 상대 차례를 건너뛰고 연달아 할 수 있어요\n\n' +
    '💡 부메랑 심리전\n' +
    '상대가 부메랑을 들고 있으면 먹이기가 위험해요. 투시안경, 마법소스, 청양고추로 피하거나, 내가 먹어서 버티면 상대가 찜기 끝에 -1을 받아요';
  return [part2, part3];
}

// 튜토리얼 1장에 공통으로 들어가는 찜기/먹기 설명
function rulesBasics() {
  return '【찜기와 라운드】\n' +
    '• 찜기 하나를 다 먹을 때까지가 1라운드예요\n' +
    '• 찜기가 나올 때 매운 만두와 일반 만두가 각각 몇 개인지 알려줘요. 하지만 어떤 순서로 나올지는 아무도 몰라요\n' +
    '• 첫 찜기는 만두 ' + FIRST_ROUND_MIN + '~' + FIRST_ROUND_MAX + '개, 다음 찜기부터는 ' + ROUND_MIN + '~' + ROUND_MAX + '개\n' +
    '• 만두는 항상 맨 앞에서부터 하나씩 나와요\n' +
    '• 찜기가 비면 새 찜기가 나오고, 하던 차례가 그대로 이어져요\n\n' +
    '【내 차례에 할 수 있는 것】\n' +
    '😋 먹기 (내가 먹음)\n' +
    ' - 매운 만두: 내 참을성 -1, 차례가 상대에게\n' +
    ' - 일반 만두: 아무 일 없고 한 번 더 내 차례!\n' +
    '🥢 먹이기 (상대에게 먹임)\n' +
    ' - 매운 만두: 상대 참을성 -1\n' +
    ' - 일반 만두: 아무 일 없음\n' +
    ' - 어느 쪽이든 차례가 상대에게\n' +
    '🎒 아이템 쓰기\n' +
    ' - 차례가 안 넘어가요. 여러 개를 쓴 다음 먹거나 먹여도 돼요';
}

module.exports = {
  MAX_HP, MAX_ITEMS, ITEM_LIST, ICON, ITEM_IMG, ITEM_DESC, ALIAS, PRIORITY,
  prio, label, hearts, bag, cut, resolveItem,
  createGame, doEat, useItem, stealChoices, forfeit, timeout, endGame,
  rulesCommon, rulesBasics
};
