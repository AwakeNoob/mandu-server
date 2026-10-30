/**
 * 복불복 만두 - 카카오톡 공식 챗봇용 스킬 서버
 * 각자 채널 1:1 채팅에서 매칭해서 대결하는 버전
 */
const http = require('http');

const TIMEOUT = 10 * 60 * 1000;  // 10분 동안 차례인 사람이 안 하면 시간 초과 패
const MAX_ITEMS = 8;
const MAX_HP = 5;

// 청양고추 만두로 부메랑 가진 사람을 먹였을 때: 'break' | 'hurt' | 'one'
const CHILI_VS_BOOMERANG = 'break';

const ITEM_LIST = ['투시안경', '젓가락', '청양고추', '우유', '자장가', '마법소스', '복불복젤리', '뺏어먹기', '바꿔치기', '부메랑'];
const ICON = {
  '투시안경': '👓', '젓가락': '🥢', '청양고추': '🌶️', '우유': '🥛', '자장가': '🎵',
  '마법소스': '🪄', '복불복젤리': '🍬', '뺏어먹기': '🤲', '바꿔치기': '🔁', '부메랑': '🪃'
};
const ALIAS = { '안경': '투시안경', '고추': '청양고추', '소스': '마법소스', '젤리': '복불복젤리', '뺏기': '뺏어먹기' };
const ITEM_DESC = {
  '투시안경': '지금 차례 만두가 매운지 확인 (나만 보여요)',
  '젓가락': '지금 차례 만두를 집어서 빼버림',
  '청양고추': '다음 매운 만두가 2배로 매움',
  '우유': '참을성 +1',
  '자장가': '상대가 잠들어서 다음 차례를 건너뜀',
  '마법소스': '지금 만두를 매운↔일반으로 바꿈',
  '복불복젤리': '40% 확률로 참을성 +2, 60% 확률로 -1',
  '뺏어먹기': '상대 아이템 하나를 뺏어서 바로 사용',
  '바꿔치기': '내 아이템 개수만큼 상대 아이템과 무작위로 맞바꿈 (내 가방이 비면 못 씀)',
  '부메랑': '상대가 나에게 먹인 매운 만두 1개를 되돌림. 대신 찜기가 비면 내 참을성 -1'
};

// ---------- 저장소 (서버 메모리) ----------
const users = {};      // 유저ID -> { id, name, inbox, gameId, queued, queuedAt, code }
const games = {};      // 게임ID -> 게임
let randomQueue = null; // 랜덤 매칭 대기 중인 유저ID
const codeRooms = {};  // 방 코드 -> 유저ID
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
function bag(items) { return items.length ? items.map(i => ICON[i] + i).join(', ') : '없음'; }

function name(g, p) { return users[g.players[p]].name; }
function all(g, text) { for (const uid of g.players) users[uid].inbox.push(text); }
function only(g, p, text) { users[g.players[p]].inbox.push(text); }

// ---------- 게임 로직 (메신저봇 버전과 같은 규칙) ----------
function reload(g) {
  const total = rand(2, 8);
  const spicy = rand(1, total - 1);
  const s = [];
  for (let i = 0; i < total; i++) s.push(i < spicy);
  g.shells = shuffle(s);
  all(g, '♨️ 새 찜기 등장! 매운 만두 ' + spicy + '개, 일반 만두 ' + (total - spicy) + '개가 섞여 있다.');
  const n = rand(2, 4);
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
    if (g.boomerangUsed[p]) {
      g.hp[p] -= 1;
      all(g, '🪃 부메랑 던지느라 지쳤다... ' + name(g, p) + ' 참을성 -1');
      if (g.hp[p] <= 0) dead.push(p);
    }
  }
  g.boomerang = [false, false];
  g.boomerangUsed = [false, false];
  if (dead.length === 2) return -2;
  if (dead.length === 1) return 1 - dead[0];
  reload(g);
  return -1;
}

function nextTurn(g) {
  const other = 1 - g.turn;
  if (g.asleep[other]) {
    g.asleep[other] = false;
    all(g, '💤 ' + name(g, other) + '님은 자느라 차례를 건너뜁니다!');
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
  all(g, self ? '🥢 ' + name(g, idx) + '님이 만두를 집어 먹었다!'
              : '🥢 ' + name(g, idx) + '님이 ' + name(g, target) + '님에게 만두를 먹였다!');

  if (spicy) {
    if (!self && g.boomerang[target]) {
      g.boomerang[target] = false;
      if (chili && CHILI_VS_BOOMERANG === 'break') {
        all(g, '🪃💥 청양고추 열기에 부메랑이 부서졌다! 아무 일도 일어나지 않았다.');
      } else if (chili && CHILI_VS_BOOMERANG === 'hurt') {
        g.hp[target] -= dmg;
        all(g, '🪃💥 부메랑이 버티지 못했다! ' + name(g, target) + ' 참을성 -' + dmg);
        if (g.hp[target] <= 0) return idx;
      } else {
        const back = (chili && CHILI_VS_BOOMERANG === 'one') ? 1 : dmg;
        g.hp[idx] -= back;
        all(g, '🪃 부메랑! 매운 만두가 되돌아갔다! ' + name(g, idx) + ' 참을성 -' + back);
        if (g.hp[idx] <= 0) return target;
      }
    } else {
      g.hp[target] -= dmg;
      all(g, '🥵 으아 매워! ' + label(true) + '! ' + name(g, target) + ' 참을성 -' + dmg);
      if (g.hp[target] <= 0) return 1 - target;
    }
    nextTurn(g);
  } else {
    all(g, '😋 냠냠... ' + label(false) + '였다!');
    if (self) all(g, '✨ ' + name(g, idx) + '님 한 번 더!');
    else nextTurn(g);
  }
  if (g.shells.length === 0) return endRound(g);
  return -1;
}

// 실패 {err}, 결과 {result}, 이미 가방에서 뺐으면 {consumed}
function applyEffect(g, idx, it) {
  const me = name(g, idx);
  const opp = 1 - idx;
  switch (it) {
    case '투시안경':
      all(g, '👓 ' + me + '님이 투시안경으로 만두를 살펴봤다...');
      only(g, idx, '👀 (나만 보여요) 지금 만두는 ' + label(g.shells[0]) + '!');
      break;
    case '젓가락': {
      const out = g.shells.shift();
      all(g, '🥢 쏙! 만두 하나를 빼냈다: ' + label(out));
      if (g.shells.length === 0) {
        const r = endRound(g);
        if (r !== -1) return { result: r };
      }
      break;
    }
    case '청양고추':
      if (g.chili) return { err: '이미 청양고추가 들어가 있어요.' };
      g.chili = true;
      all(g, '🌶️ ' + me + '님이 청양고추 투하! 다음 매운 만두는 2배로 맵다');
      break;
    case '우유':
      if (g.hp[idx] >= MAX_HP) all(g, '🥛 ' + me + '님이 우유를 마셨지만 참을성이 이미 가득 찼다.');
      else { g.hp[idx] += 1; all(g, '🥛 ' + me + '님 꿀꺽... 참을성 +1'); }
      break;
    case '자장가':
      if (g.asleep[opp]) return { err: '상대는 이미 자고 있어요.' };
      g.asleep[opp] = true;
      all(g, '🎵 자장자장~ ' + name(g, opp) + '님이 잠들었다! 다음 차례를 건너뜁니다.');
      break;
    case '마법소스':
      g.shells[0] = !g.shells[0];
      all(g, '🪄 ' + me + '님이 마법소스를 뿌렸다! 지금 만두가 뒤바뀌었다 (매운↔일반)');
      break;
    case '복불복젤리':
      if (Math.random() < 0.4) {
        g.hp[idx] = Math.min(MAX_HP, g.hp[idx] + 2);
        all(g, '🍬 ' + me + '님: 달콤하다! 참을성 +2');
      } else {
        g.hp[idx] -= 1;
        all(g, '🍬 ' + me + '님: 으엑... 엄청 신 젤리였다! 참을성 -1');
        if (g.hp[idx] <= 0) return { result: opp };
      }
      break;
    case '부메랑':
      if (g.boomerang[idx]) return { err: '이미 부메랑을 들고 있어요.' };
      g.boomerang[idx] = true;
      g.boomerangUsed[idx] = true;
      all(g, '🪃 ' + me + '님이 부메랑을 들었다! 다음 매운 만두 1개를 되돌린다. (찜기가 비면 대가를 치른다)');
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
      all(g, '🔁 바꿔치기! ' + me + '님과 ' + name(g, opp) + '님이 아이템 ' + k + '개를 무작위로 맞바꿨다.');
      return { consumed: true };
    }
  }
  return {};
}

function endGame(g, result) {
  if (result === -2) {
    all(g, '😵 둘 다 쓰러졌다... 무승부!');
  } else {
    all(g, '😵 ' + name(g, 1 - result) + '님 참을성 바닥! 더는 못 먹겠다...');
    all(g, '🏆 ' + name(g, result) + '님 승리!');
  }
  all(g, '다시 하려면 "대결"을 눌러주세요.');
  for (const uid of g.players) users[uid].gameId = null;
  delete games[g.id];
}

function startGame(uidA, uidB) {
  const g = {
    id: 'g' + (++gameSeq), players: [uidA, uidB],
    hp: [MAX_HP, MAX_HP], items: [[], []], asleep: [false, false],
    boomerang: [false, false], boomerangUsed: [false, false],
    chili: false, shells: [], turn: rand(0, 1), last: Date.now()
  };
  games[g.id] = g;
  for (const uid of g.players) {
    const u = users[uid];
    u.gameId = g.id; u.queued = false; u.code = null;
  }
  all(g, '⚔️ 매칭 성공! ' + name(g, 0) + ' vs ' + name(g, 1) + '\n참을성 ' + MAX_HP + '칸으로 시작합니다!');
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

// ---------- 안내 문구 ----------
function helpText() {
  return '🥟 복불복 만두\n' +
    '찜기 속 매운 만두를 피해서 상대의 참을성을 먼저 0으로 만들면 승리!\n\n' +
    '• 대결 - 아무나랑 매칭\n' +
    '• 대결 1234 - 친구와 같은 숫자로 매칭\n' +
    '• 닉네임 뉴비 - 내 이름 정하기\n' +
    '• 튜토리얼 - 자세한 규칙\n' +
    '• 아이템 - 아이템 설명\n\n' +
    '게임 중에는 아래 버튼을 누르면 돼요.';
}

function itemHelp() {
  return '🎒 아이템 설명\n' + ITEM_LIST.map(i => ICON[i] + ' ' + i + ': ' + ITEM_DESC[i]).join('\n');
}

function ruleText() {
  return ['📖 복불복 만두 튜토리얼\n\n' +
    '【목표】\n찜기 속 만두를 번갈아 먹거나 먹이면서, 상대 참을성을 0으로 만들면 승리!\n\n' +
    '【시작】\n' +
    '1. "대결"을 누르면 아무나와 매칭돼요\n' +
    '2. 친구랑 하려면 둘 다 "대결 1234"처럼 같은 숫자를 치세요\n' +
    '3. 참을성은 둘 다 ' + MAX_HP + '칸, 선공은 랜덤\n\n' +
    '【찜기】\n' +
    '• 매운 만두와 일반 만두가 2~8개 섞여 나와요\n' +
    '• 몇 개씩인지는 알려주지만 순서는 비밀!\n' +
    '• 다 먹으면 새 찜기가 나오고, 둘 다 아이템을 2~4개 받아요 (최대 8개)\n\n' +
    '【내 차례에 할 수 있는 것】\n' +
    '먹이기: 매운 만두면 상대 -1. 어느 쪽이든 차례가 넘어가요\n' +
    '먹기: 매운 만두면 나 -1 + 차례 넘어감 / 일반 만두면 한 번 더! 😋\n' +
    '아이템: 차례 안 넘어가요. 여러 개 쓰고 먹어도 돼요\n\n' +
    '【상대 차례일 때】\n' +
    '상대가 뭘 했는지는 자동으로 안 와요. 🔄새로고침을 눌러서 확인하세요!\n' +
    '10분 동안 자기 차례에 아무것도 안 하면 시간 초과 패배예요.',
    '【아이템】\n' + ITEM_LIST.map(i => ICON[i] + ' ' + i + ': ' + ITEM_DESC[i]).join('\n') + '\n\n' +
    '【부메랑 자세히】\n' +
    '• 되돌리면 부메랑은 사라져요\n' +
    '• 되돌렸든 안 했든 찜기가 비면 내 참을성 -1\n' +
    '• 청양고추 만두에는 부메랑만 부서지고 아무 일 없음\n' +
    '• 되돌아간 만두는 상대 부메랑이 다시 되돌리지 못함\n' +
    '• 둘 다 부메랑 대가로 동시에 쓰러지면 무승부!\n\n' +
    '【꿀팁】\n남은 매운/일반 만두 개수를 세면서 하세요!'];
}

function status(g, me) {
  const opp = 1 - me;
  const flags = p => (g.asleep[p] ? ' 💤' : '') + (g.boomerang[p] ? ' 🪃' : '');
  let s = '━━━━━━━━━━\n';
  s += (g.turn === me ? '👉 ' : '    ') + '나 (' + name(g, me) + ') ' + hearts(g.hp[me]) + flags(me) + '\n';
  s += '    🎒 ' + bag(g.items[me]) + '\n';
  s += (g.turn === opp ? '👉 ' : '    ') + '상대 (' + name(g, opp) + ') ' + hearts(g.hp[opp]) + flags(opp) + '\n';
  s += '    🎒 ' + bag(g.items[opp]) + '\n';
  s += '🥟 남은 만두: ' + g.shells.length + '개' + (g.chili ? ' (🌶️ 청양고추 들어감)' : '') + '\n';
  s += g.turn === me ? '▶ 내 차례! 먹기 / 먹이기 / 아이템' : '▶ 상대 차례예요. 🔄새로고침으로 확인하세요';
  return s;
}

// ---------- 명령 처리 ----------
function handle(uid, utterance) {
  const u = getUser(uid);
  const text = String(utterance || '').trim().replace(/^\//, '');
  const parts = text.split(/\s+/);
  const cmd = parts[0];
  let extraText = null;   // 튜토리얼처럼 상태창 없이 보여줄 긴 글
  let buttons = null;     // 특별한 버튼 (뺏어먹기 고르기)

  let g = u.gameId ? games[u.gameId] : null;
  if (g && checkTimeout(g)) g = null;
  const idx = g ? g.players.indexOf(uid) : -1;
  const say = t => u.inbox.push(t);

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
      if (u.queued && Date.now() - u.queuedAt < TIMEOUT) { say('이미 상대를 찾는 중이에요. 🔄새로고침으로 확인하세요.'); break; }
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
          say('🔑 코드 ' + code + ' 방을 만들었어요!\n친구에게 "대결 ' + code + '"을(를) 치라고 하세요.');
        }
      } else {
        if (randomQueue && randomQueue !== uid && waitingValid(randomQueue)) {
          const other = randomQueue;
          randomQueue = null;
          startGame(other, uid);
        } else {
          randomQueue = uid;
          u.queued = true; u.queuedAt = Date.now();
          say('🔍 상대를 찾는 중이에요...\n조금 뒤에 🔄새로고침을 눌러보세요.');
        }
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
    case '상태':
    case '새로고침':
    case '🔄새로고침':
      if (!g && !u.queued && u.inbox.length === 0) say('진행 중인 게임이 없어요. "대결"을 눌러주세요.');
      break;
    case '먹기':
    case '먹이기': {
      if (!needTurn()) break;
      g.last = Date.now();
      const r = eat(g, idx, cmd === '먹기');
      if (r !== -1) { endGame(g, r); g = null; }
      break;
    }
    case '사용': {
      if (!needTurn()) break;
      const it = resolveItem(parts[1]);
      if (!it) { say('아이템 이름을 확인해 주세요.'); break; }
      if (!g.items[idx].includes(it)) { say('가방에 ' + it + '이(가) 없어요.'); break; }
      let res;
      if (it === '뺏어먹기') {
        const steal = resolveItem(parts[2]);
        const choices = [...new Set(g.items[1 - idx])].filter(x => x !== '뺏어먹기' && x !== '바꿔치기');
        if (!steal) {
          if (!choices.length) { say('상대 가방에 뺏을 수 있는 아이템이 없어요.'); break; }
          say('🤲 어떤 아이템을 뺏을까요?');
          buttons = choices.slice(0, 9).map(c => ({ label: ICON[c] + c, msg: '사용 뺏어먹기 ' + c }));
          buttons.push({ label: '❌ 그만두기', msg: '상태' });
          break;
        }
        if (!choices.includes(steal)) { say(steal + '은(는) 뺏을 수 없어요.'); break; }
        g.last = Date.now();
        all(g, '🤲 ' + u.name + '님의 뺏어먹기! 상대의 ' + steal + '을(를) 뺏어서 바로 사용!');
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
      extraText = ruleText();
      break;
    case '아이템':
      extraText = itemHelp();
      break;
    default:
      if (!g) extraText = helpText();
      else say('아래 버튼으로 진행해 주세요.');
  }

  // 응답 만들기: 쌓인 소식 + 상태창
  let lines = u.inbox.splice(0);
  if (lines.length > 20) lines = ['…(이전 소식 생략)'].concat(lines.slice(-20)); // 상태창이 잘리지 않게
  if (g) lines.push(status(g, g.players.indexOf(uid)));
  else if (u.queued) lines.push(u.code ? '⏳ 코드 ' + u.code + ' 방에서 친구를 기다리는 중...' : '⏳ 상대를 찾는 중...');

  const texts = [];
  if (extraText) texts.push(...(Array.isArray(extraText) ? extraText : [extraText]));
  if (lines.length) texts.push(lines.join('\n'));
  if (!texts.length) texts.push('🥟');

  return { texts, buttons: buttons || makeButtons(u, g) };
}

function makeButtons(u, g) {
  if (!g) {
    if (u.queued) return [{ label: '🔄새로고침', msg: '새로고침' }, { label: '❌ 취소', msg: '취소' }];
    return [{ label: '⚔️ 대결', msg: '대결' }, { label: '📖 튜토리얼', msg: '튜토리얼' }, { label: '🎒 아이템', msg: '아이템' }];
  }
  const idx = g.players.indexOf(u.id);
  if (g.turn !== idx) return [{ label: '🔄새로고침', msg: '새로고침' }, { label: '🏳️ 포기', msg: '포기' }];
  const b = [{ label: '😋 먹기', msg: '먹기' }, { label: '🥢 먹이기', msg: '먹이기' }];
  for (const it of [...new Set(g.items[idx])].slice(0, 7)) b.push({ label: ICON[it] + it, msg: '사용 ' + it });
  b.push({ label: '🔄새로고침', msg: '새로고침' });
  return b.slice(0, 10);
}

// ---------- 카카오 응답 형식 ----------
function splitText(t, max) {
  const out = [];
  let cur = '';
  for (const line of t.split('\n')) {
    if ((cur + '\n' + line).length > max && cur) { out.push(cur); cur = line; }
    else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

function kakaoResponse(res) {
  let chunks = [];
  for (const t of res.texts) chunks.push(...splitText(t, 990));
  chunks = chunks.slice(0, 3); // 카카오는 말풍선 최대 3개
  return {
    version: '2.0',
    template: {
      outputs: chunks.map(t => ({ simpleText: { text: t } })),
      quickReplies: res.buttons.map(b => ({ label: b.label, action: 'message', messageText: b.msg }))
    }
  };
}

// ---------- 서버 ----------
const server = http.createServer((req, res) => {
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
      out = kakaoResponse(handle(uid, ur.utterance));
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
module.exports = { handle, kakaoResponse, users, games };
