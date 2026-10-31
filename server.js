/**
 * 복불복 만두 - 카카오톡 공식 챗봇용 스킬 서버 (카드 UI 버전)
 * 각자 채널 1:1 채팅에서 매칭해서 대결하는 버전
 * 같은 폴더에 images.js(그림 파일)가 있어야 해요.
 */
const http = require('http');
const IMAGES = require('./images.js');

const TIMEOUT = 10 * 60 * 1000;  // 10분 동안 차례인 사람이 안 하면 시간 초과 패
const MAX_ITEMS = 8;
const MAX_HP = 5;
const FIRST_ROUND_MAX = 4;   // 첫 찜기 만두 최대 개수
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

// ---------- 저장소 (서버 메모리) ----------
const users = {};      // 유저ID -> { id, name, inbox, gameId, queued, queuedAt, code }
const games = {};
let randomQueue = null;
const codeRooms = {};
let gameSeq = 0;

function getUser(id) {
  if (!users[id]) {
    users[id] = { id: id, name: '만두' + String(id).slice(-4), inbox: [], gameId: null, queued: false, queuedAt: 0, code: null };
  }
  return users[id];
}

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

function name(g, p) { return users[g.players[p]].name; }
function all(g, t, img) { for (const uid of g.players) users[uid].inbox.push({ t, img }); }
function only(g, p, t, img) { users[g.players[p]].inbox.push({ t, img }); }

// ---------- 게임 로직 ----------
function reload(g) {
  g.round = (g.round || 0) + 1;
  const first = g.round === 1;
  // 첫 찜기는 2~4개, 그다음부터 2~8개. 매운/일반 개수 차이는 최대 MAX_GAP개
  let total, spicy;
  do {
    total = rand(2, first ? FIRST_ROUND_MAX : 8);
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
  if (result === -2) {
    all(g, '😵 둘 다 쓰러졌다... 무승부!', 'ev_draw');
  } else {
    all(g, '🏆 ' + name(g, result) + '님 승리!', 'ev_win');
    all(g, '😵 ' + name(g, 1 - result) + '님은 더는 못 먹겠다...');
  }
  for (const uid of g.players) users[uid].gameId = null;
  delete games[g.id];
}

function startGame(uidA, uidB) {
  const g = {
    id: 'g' + (++gameSeq), players: [uidA, uidB],
    hp: [MAX_HP, MAX_HP], items: [[], []], asleep: [false, false], boomerang: [false, false],
    chili: false, shells: [], turn: rand(0, 1), last: Date.now()
  };
  games[g.id] = g;
  for (const uid of g.players) {
    const u = users[uid];
    u.gameId = g.id; u.queued = false; u.code = null;
  }
  all(g, '⚔️ 매칭 성공! ' + name(g, 0) + ' vs ' + name(g, 1), 'ev_match');
  reload(g);
  all(g, '🎲 선공은 ' + name(g, g.turn) + '님!');
  return g;
}

function checkTimeout(g) {
  if (Date.now() - g.last <= TIMEOUT) return false;
  all(g, '⏰ ' + name(g, g.turn) + '님이 10분 동안 응답이 없어서 시간 초과!');
  endGame(g, 1 - g.turn);
  return true;
}

function leaveQueue(u) {
  if (randomQueue === u.id) randomQueue = null;
  if (u.code && codeRooms[u.code] === u.id) delete codeRooms[u.code];
  u.queued = false; u.code = null;
}

function waitingValid(uid) {
  const w = users[uid];
  return w && w.queued && !w.gameId && Date.now() - w.queuedAt < TIMEOUT;
}

// ---------- 화면(카드) 만들기 ----------
const BTN = (label, msg) => ({ label, action: 'message', messageText: msg });
const QR = (label, msg) => ({ label, action: 'message', messageText: msg });

function ruleText() {
  const part1 = '📖 복불복 만두 튜토리얼 (1/3) 기본 규칙\n\n' +
    '【한 줄 요약】\n' +
    '찜기 속에 매운 만두와 일반 만두가 섞여 있어요. 번갈아 가며 만두를 내가 먹거나 상대에게 먹여서, 상대의 참을성(❤️)을 먼저 0으로 만들면 이겨요!\n\n' +
    '【게임 시작】\n' +
    '• "대결" → 아무나와 매칭\n' +
    '• 친구랑 하려면 둘 다 "대결 1234"처럼 같은 숫자를 입력\n' +
    '• "닉네임 뉴비" → 상대에게 보일 이름 정하기\n' +
    '• 참을성은 둘 다 ' + MAX_HP + '칸, 누가 먼저 할지는 랜덤\n\n' +
    '【찜기와 라운드】\n' +
    '• 찜기 하나를 다 먹을 때까지가 1라운드예요\n' +
    '• 찜기가 나올 때 매운 만두와 일반 만두가 각각 몇 개인지 알려줘요. 하지만 어떤 순서로 나올지는 아무도 몰라요\n' +
    '• 첫 찜기는 만두 2~4개, 다음 찜기부터는 2~8개\n' +
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
    ' - 차례가 안 넘어가요. 여러 개를 쓴 다음 먹거나 먹여도 돼요\n\n' +
    '【상대 차례일 때】\n' +
    '상대가 한 일은 자동으로 오지 않아요. 🔄새로고침을 눌러서 확인하세요!\n' +
    '자기 차례에 10분 동안 아무것도 안 하면 시간 초과로 져요.';
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
  return [part1, part2, part3];
}

function helpCard(base) {
  return {
    basicCard: {
      title: '🥟 복불복 만두',
      description: '찜기 속 매운 만두를 피해서 상대 참을성을 먼저 0으로 만들면 승리!\n친구랑: 대결 1234 (같은 숫자)\n이름 정하기: 닉네임 뉴비',
      thumbnail: { imageUrl: base + 'ev_match.png', altText: '복불복 만두' },
      buttons: [BTN('⚔️ 대결 시작', '대결'), BTN('📖 튜토리얼', '튜토리얼'), BTN('🎒 아이템 도감', '아이템')]
    }
  };
}

function itemCarousel(base, list, mode) {
  // mode: 'book' 도감 / 'use' 내 아이템 / 'steal' 뺏을 아이템
  const uniq = [...new Set(list)].slice(0, 10);
  const count = {};
  for (const i of list) count[i] = (count[i] || 0) + 1;
  return {
    carousel: {
      type: 'basicCard',
      items: uniq.map(it => {
        const card = {
          title: ICON[it] + ' ' + it + (count[it] > 1 ? ' ×' + count[it] : ''),
          description: cut(ITEM_DESC[it], 60),
          thumbnail: { imageUrl: base + ITEM_IMG[it] + '.png', altText: it }
        };
        if (mode === 'use') card.buttons = [BTN('사용하기', '사용 ' + it)];
        if (mode === 'steal') card.buttons = [BTN('이거 뺏기', '사용 뺏어먹기 ' + it)];
        return card;
      })
    }
  };
}

function statusCard(g, me) {
  const opp = 1 - me;
  const flags = p => (g.asleep[p] ? ' 💤' : '') + (g.boomerang[p] ? ' 🪃' : '');
  const myTurn = g.turn === me;
  const desc =
    (myTurn ? '👉 ' : '') + '나 (' + name(g, me) + ')' + flags(me) + '\n' + hearts(g.hp[me]) + '\n🎒 ' + bag(g.items[me]) + '\n\n' +
    (!myTurn ? '👉 ' : '') + '상대 (' + name(g, opp) + ')' + flags(opp) + '\n' + hearts(g.hp[opp]) + '\n🎒 ' + bag(g.items[opp]);
  const title = (myTurn ? '▶ 내 차례!' : '⏳ 상대 차례') + ' · 남은 만두 ' + g.shells.length + '개' + (g.chili ? ' 🌶️×2' : '');
  const buttons = myTurn
    ? [BTN('😋 먹기', '먹기'), BTN('🥢 먹이기', '먹이기'), BTN('🎒 아이템 쓰기', '아이템')]
    : [BTN('🔄 새로고침', '새로고침'), BTN('🏳️ 포기', '포기')];
  return { textCard: { title: cut(title, 50), description: cut(desc, 400), buttons } };
}

// 쌓인 소식들을 그림 카드 한 장으로
function newsOutputs(entries, base) {
  if (!entries.length) return [];
  if (entries.length > 14) entries = [{ t: '…(이전 소식 생략)' }].concat(entries.slice(-14));
  let main = -1;
  entries.forEach((e, i) => { if (e.img && (main < 0 || prio(e.img) >= prio(entries[main].img))) main = i; });
  const lines = entries.map(e => e.t);
  if (main < 0) return [{ simpleText: { text: cut(lines.join('\n'), 1000) } }];
  const title = entries[main].t;
  const rest = lines.filter((_, i) => i !== main).join('\n');
  const card = { title: cut(title, 50), thumbnail: { imageUrl: base + entries[main].img + '.png', altText: cut(title, 50) } };
  if (rest.length <= 230) {
    if (rest) card.description = rest;
    return [{ basicCard: card }];
  }
  return [{ simpleText: { text: cut(rest, 1000) } }, { basicCard: card }];
}

function quickReplies(u, g) {
  if (!g) {
    if (u.queued) return [QR('🔄새로고침', '새로고침'), QR('❌취소', '취소')];
    return [QR('⚔️대결', '대결'), QR('📖튜토리얼', '튜토리얼'), QR('🎒아이템 도감', '아이템')];
  }
  const idx = g.players.indexOf(u.id);
  if (g.turn !== idx) return [QR('🔄새로고침', '새로고침'), QR('🏳️포기', '포기')];
  const b = [QR('😋먹기', '먹기'), QR('🥢먹이기', '먹이기')];
  for (const it of [...new Set(g.items[idx])].slice(0, 7)) b.push(QR(ICON[it] + it, '사용 ' + it));
  b.push(QR('🔄새로고침', '새로고침'));
  return b.slice(0, 10);
}

// ---------- 명령 처리 ----------
function handle(uid, utterance, base) {
  base = base || '/img/';
  const u = getUser(uid);
  let text = String(utterance || '').trim().replace(/^\//, '');
  text = text.replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)); // 전각 숫자 → 일반 숫자
  text = text.replace(/^(대결|닉네임)(?=\S)/, '$1 ');                                  // "대결1234"처럼 붙여 써도 인식
  const parts = text.split(/\s+/);
  const cmd = parts[0];
  let special = null; // 소식/상태창 대신 보여줄 화면

  let g = u.gameId ? games[u.gameId] : null;
  if (g && checkTimeout(g)) g = null;
  const idx = g ? g.players.indexOf(uid) : -1;
  const say = t => u.inbox.push({ t });

  const needTurn = () => {
    if (!g) { say('진행 중인 게임이 없어요. "대결"을 눌러주세요.'); return false; }
    if (g.turn !== idx) { say('지금은 상대 차례예요. 🔄새로고침으로 확인하세요.'); return false; }
    return true;
  };

  switch (cmd) {
    case '닉네임': {
      const nn = parts.slice(1).join(' ').slice(0, 10);
      if (!nn) say('예) 닉네임 뉴비');
      else { u.name = nn; say('이름을 "' + nn + '"(으)로 바꿨어요.'); }
      break;
    }
    case '대결': {
      if (g) { say('이미 게임 중이에요!'); break; }
      if (u.queued && Date.now() - u.queuedAt < TIMEOUT) { say('이미 상대를 찾는 중이에요.'); break; }
      leaveQueue(u);
      const code = parts[1];
      if (code) {
        const other = codeRooms[code];
        if (other && other !== uid && waitingValid(other)) {
          delete codeRooms[code];
          startGame(other, uid);
        } else {
          codeRooms[code] = uid;
          u.queued = true; u.queuedAt = Date.now(); u.code = code;
        }
      } else if (randomQueue && randomQueue !== uid && waitingValid(randomQueue)) {
        const other = randomQueue;
        randomQueue = null;
        startGame(other, uid);
      } else {
        randomQueue = uid;
        u.queued = true; u.queuedAt = Date.now();
      }
      g = u.gameId ? games[u.gameId] : null;
      break;
    }
    case '취소':
      if (u.queued) { leaveQueue(u); say('매칭을 취소했어요.'); }
      else say('취소할 매칭이 없어요.');
      break;
    case '포기':
      if (!g) { say('진행 중인 게임이 없어요.'); break; }
      all(g, '🏳️ ' + u.name + '님이 항복했어요.');
      endGame(g, 1 - idx);
      g = null;
      break;
    case '상태': case '새로고침':
      break;
    case '먹기': case '먹이기': {
      if (!needTurn()) break;
      g.last = Date.now();
      const r = eat(g, idx, cmd === '먹기');
      if (r !== -1) { endGame(g, r); g = null; }
      break;
    }
    case '아이템':
      if (g && g.items[idx].length) special = [itemCarousel(base, g.items[idx], g.turn === idx ? 'use' : 'book')];
      else if (g) say('가방이 비어 있어요.');
      else special = [itemCarousel(base, ITEM_LIST, 'book')];
      break;
    case '사용': {
      if (!needTurn()) break;
      const it = resolveItem(parts[1]);
      if (!it) { say('아이템 이름을 확인해 주세요.'); break; }
      if (!g.items[idx].includes(it)) { say('가방에 ' + it + '이(가) 없어요.'); break; }
      let res;
      if (it === '뺏어먹기') {
        const choices = g.items[1 - idx].filter(x => x !== '뺏어먹기' && x !== '바꿔치기');
        const steal = resolveItem(parts[2]);
        if (!steal) {
          if (!choices.length) { say('상대 가방에 뺏을 수 있는 아이템이 없어요.'); break; }
          special = [{ simpleText: { text: '🤲 어떤 아이템을 뺏을까요? 옆으로 넘겨서 골라주세요.' } }, itemCarousel(base, choices, 'steal')];
          break;
        }
        if (!choices.includes(steal)) { say(steal + '은(는) 뺏을 수 없어요.'); break; }
        g.last = Date.now();
        all(g, '🤲 ' + u.name + '님이 상대의 ' + steal + '을(를) 뺏어 먹었다!', 'it_grab');
        res = applyEffect(g, idx, steal);
        if (res.err) { say(res.err); break; }
        removeOne(g.items[idx], '뺏어먹기');
        removeOne(g.items[1 - idx], steal);
      } else {
        g.last = Date.now();
        res = applyEffect(g, idx, it);
        if (res.err) { say(res.err); break; }
        if (!res.consumed) removeOne(g.items[idx], it);
      }
      if (res.result !== undefined) { endGame(g, res.result); g = null; }
      break;
    }
    case '튜토리얼': case '룰': case '규칙':
      special = ruleText().map(t => ({ simpleText: { text: t } }));
      break;
    default:
      if (!g && !u.queued) special = [helpCard(base)];
      else say('아래 버튼으로 진행해 주세요.');
  }

  let outputs;
  if (special) {
    outputs = special;
  } else {
    outputs = newsOutputs(u.inbox.splice(0), base);
    if (g) {
      outputs.push(statusCard(g, g.players.indexOf(uid)));
    } else if (u.queued) {
      outputs.push({ textCard: {
        title: u.code ? '🔑 코드 ' + u.code + ' 방에서 친구를 기다리는 중' : '🔍 상대를 찾는 중...',
        description: u.code ? '친구에게 "대결 ' + u.code + '"을(를) 치라고 하세요.\n들어오면 새로고침을 눌러보세요.' : '조금 뒤에 새로고침을 눌러보세요.',
        buttons: [BTN('🔄 새로고침', '새로고침'), BTN('❌ 취소', '취소')]
      } });
    } else if (!outputs.length) {
      outputs.push(helpCard(base));
    }
  }
  // 카카오는 말풍선 최대 3개: 상태창은 꼭 남기기
  if (outputs.length > 3) outputs = outputs.slice(-3);

  return { version: '2.0', template: { outputs, quickReplies: quickReplies(u, g) } };
}

// ---------- 서버 ----------
function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  return proto + '://' + req.headers.host + '/img/';
}

const server = http.createServer((req, res) => {
  const m = req.method === 'GET' && /^\/img\/([a-z_]+)\.png$/.exec(req.url.split('?')[0]);
  if (m) {
    const data = IMAGES[m[1]];
    if (!data) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.end(Buffer.from(data, 'base64'));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('복불복 만두 서버 작동 중 🥟');
    return;
  }
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    let out;
    try {
      const data = JSON.parse(body || '{}');
      const ur = data.userRequest || {};
      const uid = (ur.user && ur.user.id) || 'unknown';
      out = handle(uid, ur.utterance, baseUrl(req));
    } catch (e) {
      console.error(e);
      out = { version: '2.0', template: { outputs: [{ simpleText: { text: '⚠️ 오류가 났어요. 잠시 후 다시 해주세요.' } }] } };
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out));
  });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => console.log('복불복 만두 서버 시작: 포트 ' + PORT));
}
module.exports = { handle, users, games, server };
