/**
 * 복불복 만두 - 카카오톡 공식 챗봇용 스킬 서버 (카드 UI 버전)
 * 각자 채널 1:1 채팅에서 매칭해서 대결하는 버전
 * 같은 폴더에 game.js(규칙), images.js(그림)가 있어야 해요.
 * Render 환경변수에 DISCORD_TOKEN이 있으면 디스코드 봇도 같이 켜져요.
 */
const http = require('http');
const IMAGES = require('./images.js');
const G = require('./game.js');
const D = require('./mandu-discord.js');
let lastBase = null;
const { ITEM_LIST, ICON, ITEM_IMG, ITEM_DESC, MAX_HP, prio, hearts, bag, cut, resolveItem } = G;

function name(g, p) { return g.nameOf(p); }
const TIMEOUT = 10 * 60 * 1000;  // 10분 동안 차례인 사람이 안 하면 시간 초과 패

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

function startGame(uidA, uidB) {
  const players = [uidA, uidB];
  const id = 'g' + (++gameSeq);
  const g = G.createGame({
    id, players,
    nameOf: p => users[players[p]].name,
    emit: (p, t, img) => {
      const targets = p === null ? players : [players[p]];
      for (const uid of targets) users[uid].inbox.push({ t, img });
    },
    onEnd: () => {
      for (const uid of players) users[uid].gameId = null;
      delete games[id];
    }
  });
  games[g.id] = g;
  for (const uid of g.players) {
    const u = users[uid];
    u.gameId = g.id; u.queued = false; u.code = null;
  }
  return g;
}

function checkTimeout(g) {
  if (Date.now() - g.last <= TIMEOUT) return false;
  G.timeout(g, 10);
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
    G.rulesBasics() + '\n\n' +
    '【상대 차례일 때】\n' +
    '상대가 한 일은 자동으로 오지 않아요. 🔄새로고침을 눌러서 확인하세요!\n' +
    '자기 차례에 10분 동안 아무것도 안 하면 시간 초과로 져요.';
  return [part1].concat(G.rulesCommon());
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
      G.forfeit(g, idx);
      g = null;
      break;
    case '상태': case '새로고침':
      break;
    case '먹기': case '먹이기': {
      if (!needTurn()) break;
      G.doEat(g, idx, cmd === '먹기');
      if (g.over) g = null;
      break;
    }
    case '아이템':
      if (g && g.items[idx].length) special = [itemCarousel(base, g.items[idx], g.turn === idx ? 'use' : 'book')];
      else if (g) say('가방이 비어 있어요.');
      else special = [itemCarousel(base, ITEM_LIST, 'book')];
      break;
    case '사용': {
      if (!needTurn()) break;
      const res = G.useItem(g, idx, resolveItem(parts[1]), resolveItem(parts[2]));
      if (res.err) { say(res.err); break; }
      if (res.needSteal) {
        special = [{ simpleText: { text: '🤲 어떤 아이템을 뺏을까요? 옆으로 넘겨서 골라주세요.' } }, itemCarousel(base, res.needSteal, 'steal')];
        break;
      }
      if (g.over) g = null;
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
    res.end('복불복 만두 서버 작동 중 🥟\n버전: 4 (카카오+디스코드)\n디스코드: ' + (D.enabled() ? '켜짐 ✅' : '꺼짐 ❌ (Render Environment 확인)') + '\n디스코드 명령어: ' + D.status.commands);
    return;
  }
  const chunks = [];
  let size = 0;
  req.on('data', c => { chunks.push(c); size += c.length; if (size > 1e6) req.destroy(); });
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const path = req.url.split('?')[0];
    const base = baseUrl(req);
    lastBase = base;

    // ----- 디스코드 -----
    if (path === '/discord') {
      if (!D.verify(raw, req.headers['x-signature-ed25519'], req.headers['x-signature-timestamp'])) {
        res.writeHead(401); res.end('invalid request signature'); return;
      }
      let result;
      try {
        result = D.handleInteraction(JSON.parse(raw.toString('utf8')), base);
      } catch (e) {
        console.error(e);
        result = { json: { type: 4, data: { content: '⚠️ 오류가 났어요. 잠시 후 다시 해주세요.', flags: 64 } } };
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result.json));
      if (result.after) result.after().catch(e => console.error(e));
      return;
    }

    // ----- 카카오 -----
    let out;
    try {
      const data = JSON.parse(raw.toString('utf8') || '{}');
      const ur = data.userRequest || {};
      const uid = (ur.user && ur.user.id) || 'unknown';
      out = handle(uid, ur.utterance, base);
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
  if (D.enabled()) {
    D.registerCommands().catch(e => console.error('디스코드 명령어 등록 실패', e));
    setInterval(() => D.sweep(), 10 * 60 * 1000);
    console.log('디스코드 봇 켜짐');
  }
}
module.exports = { handle, users, games, server };
