/**
 * 복불복 만두 - 디스코드 봇 (라이브러리 없이 HTTP 방식)
 * Render 환경변수: DISCORD_APP_ID, DISCORD_PUBLIC_KEY, DISCORD_TOKEN
 * 디스코드 개발자 포털의 "Interactions Endpoint URL"에  https://(서버주소)/discord  를 넣어요.
 *
 * 진행 방식
 *  1) 채널에서 /만두 대결 → 모집 카드
 *  2) 누가 참가하면 그 판 전용 "스레드(게임 방)"가 생기고, 거기서 게임 + 채팅
 *  3) 게임이 끝나면 결과를 원래 채널에 남기고, 게임 방은 잠시 뒤 자동 삭제
 *  스레드를 못 만들면(권한 없음, 디스코드가 잠깐 막음 등) 예전처럼 채널에서 바로 게임해요.
 */
const crypto = require('crypto');
const G = require('./game.js');
const { ITEM_LIST, ICON, ITEM_DESC, MAX_HP, hearts, bag, cut, prio } = G;

const API = 'https://discord.com/api/v10';
const APP_ID = (process.env.DISCORD_APP_ID || '').trim();
const PUBLIC_KEY = (process.env.DISCORD_PUBLIC_KEY || '').trim();
const TOKEN = (process.env.DISCORD_TOKEN || '').trim();

// ---------- 설정 (여기만 바꾸면 돼요) ----------
const config = {
  THREAD_MODE: 'public',          // 'public': 누구나 들어와서 구경·채팅 / 'private': 두 사람만 / 'off': 채널에서 바로
  DELETE_AFTER: 60 * 1000,        // 게임이 끝나고 게임 방이 사라질 때까지 (1분)
  TURN_TIMEOUT: 5 * 60 * 1000,    // 자기 차례에 5분 동안 안 하면 시간 초과 패
  LOBBY_TIMEOUT: 30 * 60 * 1000,  // 아무도 참가 안 한 모집은 30분 뒤 사라짐
  API_WAIT: 1100                  // 스레드 만들 때 디스코드 대답을 기다리는 최대 시간 (ms)
};
const EPHEMERAL = 64;

const lobbies = {};  // 모집ID -> 모집
const games = {};    // 채널ID(게임 방 스레드 또는 채널) -> 게임
const status = { commands: '아직 등록 안 됨', thread: '아직 안 써봄', lastError: '' };

// ---------- 서명 확인 (디스코드가 보낸 요청인지) ----------
let pubKeyObj = null;
function verify(rawBody, sig, ts) {
  try {
    if (!PUBLIC_KEY || !sig || !ts) return false;
    if (!pubKeyObj) {
      const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(PUBLIC_KEY, 'hex')]);
      pubKeyObj = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    }
    return crypto.verify(null, Buffer.concat([Buffer.from(ts), rawBody]), pubKeyObj, Buffer.from(sig, 'hex'));
  } catch (e) {
    return false;
  }
}

// ---------- 디스코드 API ----------
let fetchImpl = (...a) => fetch(...a);
function setFetch(f) { fetchImpl = f; }

// 결과: { ok, status, data }  — 실패해도 절대 에러를 던지지 않아요
async function api(method, path, body, waitMs) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = waitMs && ctrl ? setTimeout(() => ctrl.abort(), waitMs) : null;
  try {
    const res = await fetchImpl(API + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bot ' + TOKEN },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl ? ctrl.signal : undefined
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok) {
      status.lastError = method + ' ' + path.split('/').slice(0, 3).join('/') + ' → ' + res.status + ' ' + text.slice(0, 100);
      console.error('디스코드 API 오류', status.lastError);
    }
    return { ok: res.ok, status: res.status, data, headers: res.headers };
  } catch (e) {
    status.lastError = method + ' ' + path + ' → ' + (e.name === 'AbortError' ? '시간 초과' : String(e).slice(0, 80));
    return { ok: false, status: 0, data: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------- 명령어 등록 (막히면 기다렸다가 다시) ----------
const COMMANDS = [{
  name: '만두',
  description: '복불복 만두 게임',
  options: [
    { type: 1, name: '대결', description: '대결 상대를 모집해요',
      options: [{ type: 6, name: '상대', description: '이 사람만 참가할 수 있게 (비우면 아무나)', required: false }] },
    { type: 1, name: '규칙', description: '자세한 규칙을 나만 보이게 보여줘요' },
    { type: 1, name: '아이템', description: '아이템 도감을 나만 보이게 보여줘요' }
  ]
}];

async function registerCommands(attempt) {
  attempt = attempt || 1;
  if (!APP_ID || !TOKEN) { status.commands = '토큰이나 APP ID가 없어서 등록 안 함'; return; }
  const r = await api('PUT', '/applications/' + APP_ID + '/commands', COMMANDS);
  let wait = 0;
  if (r.ok) { status.commands = '등록 완료 ✅'; console.log('디스코드 명령어 등록 완료'); return; }
  if (r.status === 401) { status.commands = '토큰이 틀렸어요 (401) ❌'; return; }
  if (r.status === 403 || r.status === 404) { status.commands = 'APP ID나 토큰이 안 맞아요 (' + r.status + ') ❌'; return; }
  if (r.status === 400) { status.commands = '명령어 형식 오류 (400) ❌'; return; }
  if (r.status === 429) {
    const after = (r.data && r.data.retry_after) || 0;
    wait = Math.max(after * 1000, 60 * 1000) * Math.min(attempt, 10);
    status.commands = '디스코드가 잠깐 막음 (429), ' + Math.round(wait / 60000) + '분 뒤 다시 시도 ⏳';
  } else {
    wait = 5 * 60 * 1000;
    status.commands = '오류 ' + r.status + ', 5분 뒤 다시 시도 ⏳';
  }
  const t = setTimeout(() => registerCommands(attempt + 1), wait);
  if (t.unref) t.unref();
}

// ---------- 도구 ----------
function userOf(it) { return (it.member && it.member.user) || it.user || {}; }
function displayName(it) {
  const u = userOf(it);
  return cut((it.member && it.member.nick) || u.global_name || u.username || '만두', 20);
}
function imgUrl(base, key) { return base + key + '.png'; }
const COLOR = { ev_spicy: 0xE74C3C, ev_normal: 0xF5B041, ev_reflect: 0x1ABC9C, ev_chili_break: 0x8E44AD,
  ev_sleep: 0x34495E, ev_steamer: 0xE67E22, ev_match: 0xE8432C, ev_win: 0xF1C40F, ev_draw: 0x95A5A6 };

function button(label, id, style, disabled) {
  return { type: 2, style: style || 2, label: cut(label, 80), custom_id: id, disabled: !!disabled };
}
function rowsOf(buttons) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  return rows;
}
function isThreadChannel(it) {
  const t = it.channel && it.channel.type;
  return t === 10 || t === 11 || t === 12;
}

// ---------- 화면 ----------
function rulesEmbeds() {
  const part1 = '【한 줄 요약】\n' +
    '찜기 속에 매운 만두와 일반 만두가 섞여 있어요. 번갈아 가며 만두를 내가 먹거나 상대에게 먹여서, 상대의 참을성(❤️)을 먼저 0으로 만들면 이겨요!\n\n' +
    '【게임 시작】\n' +
    '• /만두 대결 → 아무나 참가할 수 있는 모집 만들기\n' +
    '• /만두 대결 상대:@친구 → 그 사람만 참가 가능\n' +
    '• 누가 참가하기를 누르면 그 판 전용 게임 방(스레드)이 생겨요. 게임 방 안에서 게임하면서 채팅도 할 수 있어요!\n' +
    '• 게임이 끝나면 결과가 원래 채널에 남고, 게임 방은 1분 뒤에 사라져요\n' +
    '• 참을성은 둘 다 ' + MAX_HP + '칸, 선공은 랜덤\n\n' +
    G.rulesBasics() + '\n\n' +
    '【버튼】\n' +
    '게임판 아래 버튼은 자기 차례인 사람만 누를 수 있어요. 아이템 버튼을 누르면 바로 써져요.\n' +
    '👓투시안경을 쓰면 👀결과 보기 버튼이 생기고, 쓴 사람만 눌러서 결과를 볼 수 있어요.\n' +
    '자기 차례에 5분 동안 아무것도 안 하면 시간 초과로 져요.';
  const [part2, part3] = G.rulesCommon();
  return [
    { title: '📖 튜토리얼 (1/3) 기본 규칙', description: part1, color: 0xE67E22 },
    { title: part2.split('\n')[0], description: part2.split('\n').slice(2).join('\n'), color: 0x1ABC9C },
    { title: part3.split('\n')[0], description: part3.split('\n').slice(2).join('\n'), color: 0xF1C40F }
  ];
}

function itemBookEmbed(base) {
  return {
    title: '🎒 아이템 도감',
    description: ITEM_LIST.map(i => ICON[i] + ' **' + i + '**: ' + ITEM_DESC[i]).join('\n'),
    color: 0x5DADE2,
    thumbnail: { url: imgUrl(base, 'it_jelly') }
  };
}

function lobbyMessage(lb, base) {
  return {
    embeds: [{
      title: '🥟 복불복 만두 대결 모집!',
      description: '**' + lb.ownerName + '**님이 ' + (lb.invite ? '<@' + lb.invite + '>님에게 대결을 신청했어요!' : '대결 상대를 찾고 있어요!') +
        '\n\n찜기 속 매운 만두를 피해서 상대 참을성을 먼저 0으로 만들면 승리!\n참가하면 둘만의 게임 방이 열려요. 처음이면 📖규칙을 눌러보세요.',
      color: 0xE8432C,
      image: { url: imgUrl(base, 'ev_match') }
    }],
    components: rowsOf([
      button('🥟 참가하기', 'md:join:' + lb.id, 3),
      button('📖 규칙', 'md:rules', 2),
      button('❌ 취소', 'md:cancel:' + lb.id, 4)
    ])
  };
}

function boardMessage(g, base) {
  const fresh = g.pending.splice(0);
  let main = -1;
  fresh.forEach((e, i) => { if (e.img && (main < 0 || prio(e.img) >= prio(fresh[main].img))) main = i; });
  if (main >= 0) { g.lastImg = fresh[main].img; g.lastTitle = fresh[main].t; }
  const freshSet = new Set(fresh.map(f => f.t));

  const log = g.log.slice(-12).map(l => (freshSet.has(l) ? '**' + l + '**' : l)).join('\n');
  const flags = p => (g.asleep[p] ? ' 💤' : '') + (g.boomerang[p] ? ' 🪃' : '');
  const fields = [0, 1].map(p => ({
    name: (!g.over && g.turn === p ? '👉 ' : '') + g.names[p] + flags(p),
    value: hearts(g.hp[p]) + '\n🎒 ' + bag(g.items[p]),
    inline: true
  }));
  let footer;
  if (g.over) footer = g.threadId ? '게임 끝! 🧹 이 게임 방은 ' + Math.round(config.DELETE_AFTER / 1000) + '초 뒤에 사라져요' : '게임 끝! 다시 하려면 ⚔️새 대결을 눌러주세요';
  else if (g.stealing) footer = '🤲 ' + g.names[g.turn] + '님이 뺏을 아이템을 고르는 중...';
  else footer = '♨️ ' + g.round + '번째 찜기 · 남은 만두 ' + g.shells.length + '개' + (g.chili ? ' · 🌶️ 청양고추 들어감' : '') +
    '  ▶ ' + g.names[g.turn] + '님 차례';

  const embed = {
    title: cut(g.lastTitle || '🥟 복불복 만두', 256),
    description: cut(log || '🥟', 4000),
    color: COLOR[g.lastImg] || 0xE67E22,
    fields,
    footer: { text: footer }
  };
  if (g.lastImg) embed.image = { url: imgUrl(base, g.lastImg) };

  let rows;
  if (g.over) {
    rows = g.threadId ? [] : rowsOf([button('⚔️ 새 대결', 'md:new', 3), button('📖 규칙', 'md:rules', 2)]);
  } else if (g.stealing) {
    const choices = [...new Set(G.stealChoices(g, g.turn))].slice(0, 9);
    const b = choices.map(it => button(ICON[it] + ' ' + it + ' 뺏기', 'md:steal:' + g.v + ':' + ITEM_LIST.indexOf(it), 1));
    b.push(button('↩️ 그만두기', 'md:nosteal:' + g.v, 2));
    rows = rowsOf(b);
  } else {
    const main1 = [
      button('😋 먹기', 'md:eat:' + g.v, 1),
      button('🥢 먹이기', 'md:feed:' + g.v, 4),
      button('📖 규칙', 'md:rules', 2),
      button('🏳️ 포기', 'md:quit:' + g.v, 2)
    ];
    if (g.peek) main1.push(button('👀 투시안경 결과', 'md:peek:' + g.v, 3));
    const count = {};
    for (const i of g.items[g.turn]) count[i] = (count[i] || 0) + 1;
    const itemBtns = Object.keys(count).slice(0, 10).map(i =>
      button(ICON[i] + ' ' + i + (count[i] > 1 ? ' ×' + count[i] : ''), 'md:use:' + g.v + ':' + ITEM_LIST.indexOf(i), 2));
    rows = rowsOf(main1).concat(rowsOf(itemBtns));
  }
  return { embeds: [embed], components: rows.slice(0, 5) };
}

function resultEmbed(g, base) {
  let text;
  if (g.result === -2) text = '😵 ' + g.names[0] + ' vs ' + g.names[1] + ' 무승부!';
  else text = '🏆 **' + g.names[g.result] + '**님이 ' + g.names[1 - g.result] + '님을 이겼어요!';
  return {
    embeds: [{
      title: '🥟 복불복 만두 대결 결과',
      description: text + '\n' + g.round + '번째 찜기에서 끝났어요. 다음 판은 /만두 대결!',
      color: g.result === -2 ? 0x95A5A6 : 0xF1C40F,
      thumbnail: { url: imgUrl(base, g.result === -2 ? 'ev_draw' : 'ev_win') }
    }],
    components: rowsOf([button('⚔️ 새 대결', 'md:new', 3)]),
    allowed_mentions: { parse: [] }
  };
}

// ---------- 게임 만들기 ----------
function makeGame(channelId, players, names, extra) {
  const pending = [];
  const log = [];
  let gameRef = null;
  const g = G.createGame(Object.assign({
    players, names, channelId, v: 1, log, pending, peek: null, stealing: false, result: null, cleanup: false,
    nameOf: p => names[p],
    emit: (p, t, img) => {
      if (p === null) { log.push(t); pending.push({ t, img }); }
      else if (gameRef) gameRef.peek = { p, text: t }; // 나만 보이는 소식 (투시안경)
    },
    onEnd: r => { if (gameRef) gameRef.result = r; }
  }, extra || {}));
  gameRef = g;
  games[channelId] = g;
  return g;
}

// 그 판 전용 게임 방(스레드) 만들기. 성공하면 스레드 ID, 실패하면 null
async function openGameRoom(lb, players, names) {
  if (config.THREAD_MODE === 'off' || !TOKEN) return null;
  const priv = config.THREAD_MODE === 'private';
  const r = await api('POST', '/channels/' + lb.channelId + '/threads', {
    name: cut('🥟 ' + names[0] + ' vs ' + names[1], 100),
    type: priv ? 12 : 11,
    auto_archive_duration: 60,
    invitable: false
  }, config.API_WAIT);
  if (!r.ok || !r.data || !r.data.id) {
    status.thread = r.status === 403 ? '스레드 권한이 없어요 ❌ (공개 스레드 만들기 권한 확인)'
      : r.status === 429 ? '디스코드가 잠깐 막아서 채널에서 진행 ⏳' : '스레드를 못 만들어서 채널에서 진행 (' + r.status + ')';
    return null;
  }
  status.thread = '잘 작동 중 ✅';
  return r.data.id;
}

async function deleteRoom(threadId) {
  const r = await api('DELETE', '/channels/' + threadId);
  if (!r.ok && r.status !== 404) {
    // 지울 권한이 없으면 잠가서 보관이라도
    await api('PATCH', '/channels/' + threadId, { archived: true, locked: true });
    status.thread = '게임 방을 못 지웠어요 (스레드 관리 권한 확인)';
  }
}

// 게임 방에서 게임이 끝났을 때: 원래 채널에 결과 남기고 잠시 뒤 방 삭제
function scheduleCleanup(g, base) {
  if (!g.threadId || g.cleanup) return;
  g.cleanup = true;
  const t = setTimeout(async () => {
    const res = resultEmbed(g, base);
    let posted = false;
    if (g.lobbyToken && Date.now() - g.lobbyAt < 14 * 60 * 1000) {
      posted = (await api('PATCH', '/webhooks/' + APP_ID + '/' + g.lobbyToken + '/messages/@original', res)).ok;
    }
    if (!posted) await api('POST', '/channels/' + g.parentId + '/messages', res);
    await deleteRoom(g.threadId);
    if (games[g.threadId] === g) delete games[g.threadId];
  }, config.DELETE_AFTER);
  if (t.unref) t.unref();
}

function checkTimeout(g) {
  if (!g || g.over) return false;
  if (Date.now() - g.last <= config.TURN_TIMEOUT) return false;
  g.stealing = false;
  G.timeout(g, Math.round(config.TURN_TIMEOUT / 60000));
  g.v++;
  return true;
}

// ---------- 상호작용 처리 ----------
// 결과(Promise): { json } — 디스코드 요청에 대답하는 내용
async function handleInteraction(it, base) {
  if (it.type === 1) return { json: { type: 1 } }; // PING
  const channelId = it.channel_id || (it.channel && it.channel.id);
  const uid = userOf(it).id;
  let g = games[channelId];
  const timedOut = checkTimeout(g);

  const done = json => ({ json });
  const reply = content => done({ type: 4, data: { content, flags: EPHEMERAL } });
  const board = () => {
    const data = boardMessage(g, base);
    if (g.over) scheduleCleanup(g, base);
    return done({ type: 7, data });
  };

  // ----- 슬래시 명령 -----
  if (it.type === 2) {
    const sub = it.data.options && it.data.options[0];
    const name = sub && sub.name;
    if (name === '규칙') return done({ type: 4, data: { flags: EPHEMERAL, embeds: rulesEmbeds() } });
    if (name === '아이템') return done({ type: 4, data: { flags: EPHEMERAL, embeds: [itemBookEmbed(base)] } });
    if (name === '대결') {
      if (!it.guild_id) return reply('서버 채널에서만 할 수 있어요.');
      if (isThreadChannel(it) || (g && g.threadId)) return reply('게임 방 안에서는 새 대결을 못 만들어요. 원래 채널에서 해주세요!');
      const opt = (sub.options || []).find(o => o.name === '상대');
      const invite = opt ? opt.value : null;
      if (invite === uid) return reply('자기 자신에게는 신청할 수 없어요.');
      const resolved = (it.data.resolved && it.data.resolved.users) || {};
      if (invite && resolved[invite] && resolved[invite].bot) return reply('봇과는 대결할 수 없어요.');
      return newLobbyReply(it, channelId, uid, invite, base);
    }
    return reply('알 수 없는 명령이에요.');
  }

  // ----- 버튼 -----
  if (it.type === 3) {
    const [, action, idStr, extra] = String(it.data.custom_id || '').split(':');

    if (action === 'rules') return done({ type: 4, data: { flags: EPHEMERAL, embeds: rulesEmbeds() } });

    if (action === 'new') {
      if (isThreadChannel(it)) return reply('원래 채널에서 /만두 대결 을 해주세요!');
      return newLobbyReply(it, channelId, uid, null, base);
    }

    // ----- 모집 카드 -----
    if (action === 'join' || action === 'cancel') {
      const lb = lobbies[idStr];
      if (!lb || Date.now() - lb.created > config.LOBBY_TIMEOUT) {
        delete lobbies[idStr];
        return reply('이미 끝났거나 사라진 모집이에요. /만두 대결 로 새로 만들어 주세요.');
      }
      if (action === 'cancel') {
        if (uid !== lb.owner) return reply('모집한 사람만 취소할 수 있어요.');
        delete lobbies[idStr];
        return done({ type: 7, data: { embeds: [{ title: '❌ 대결 모집이 취소됐어요', color: 0x95A5A6 }], components: [] } });
      }
      if (uid === lb.owner) return reply('자기 대결에는 참가할 수 없어요. 친구를 기다려 주세요!');
      if (lb.invite && uid !== lb.invite) return reply('이 대결은 <@' + lb.invite + '>님만 참가할 수 있어요.');
      if (lb.starting) return reply('다른 사람이 먼저 참가했어요!');
      lb.starting = true;

      const players = [lb.owner, uid];
      const names = [lb.ownerName, displayName(it)];

      // 1) 게임 방(스레드) 열기
      const threadId = await openGameRoom(lb, players, names);
      if (threadId) {
        const game = makeGame(threadId, players, names, {
          threadId, parentId: lb.channelId, lobbyToken: lb.token, lobbyAt: lb.created
        });
        const first = boardMessage(game, base);
        first.content = '<@' + players[0] + '> vs <@' + players[1] + '> 게임 방이 열렸어요! 여기서 게임하면서 채팅도 할 수 있어요 🥟';
        first.allowed_mentions = { users: players };
        const posted = await api('POST', '/channels/' + threadId + '/messages', first, config.API_WAIT);
        if (posted.ok) {
          delete lobbies[idStr];
          game.boardMsgId = posted.data && posted.data.id;
          if (config.THREAD_MODE === 'private') {
            for (const p of players) api('PUT', '/channels/' + threadId + '/thread-members/' + p).catch(() => {});
          }
          return done({ type: 7, data: {
            embeds: [{
              title: '⚔️ ' + names[0] + ' vs ' + names[1] + ' 대결 중!',
              description: '게임 방 → <#' + threadId + '>\n' + (config.THREAD_MODE === 'private' ? '두 사람만 들어갈 수 있는 방이에요.' : '들어가서 구경하고 응원해 주세요!'),
              color: 0xE8432C,
              thumbnail: { url: imgUrl(base, 'ev_match') }
            }],
            components: []
          } });
        }
        // 방은 열렸는데 게임판을 못 올렸으면 방을 치우고 채널에서 진행
        delete games[threadId];
        deleteRoom(threadId).catch(() => {});
      }

      // 2) 게임 방을 못 열면 채널에서 바로 진행
      const here = games[channelId];
      if (here && !here.over) {
        lb.starting = false;
        return reply('게임 방을 못 열었고, 이 채널에선 이미 게임 중이에요. 잠시 뒤에 다시 눌러주세요.');
      }
      delete lobbies[idStr];
      g = makeGame(channelId, players, names, {});
      return board();
    }

    // ----- 게임판 -----
    if (!g) return reply('이 게임은 이미 끝났어요. /만두 대결 로 새로 시작해 주세요.');
    const v = Number(idStr);

    if (timedOut) return board();
    if (v !== g.v) return reply(g.over ? '이 게임은 끝났어요.' : '이미 지나간 화면이에요. 가장 최신 게임판에서 눌러주세요.');
    if (g.over) return reply('이 게임은 끝났어요.');

    const idx = g.players.indexOf(uid);
    if (idx < 0) return reply('구경 중이에요! 채팅으로 응원해 주세요 📣');

    if (action === 'peek') {
      if (!g.peek || g.peek.p !== idx) return reply('투시안경을 쓴 사람만 볼 수 있어요. 👀');
      return reply(g.peek.text);
    }

    if (action === 'quit') {
      g.stealing = false;
      G.forfeit(g, idx);
      g.v++;
      return board();
    }

    if (g.turn !== idx) return reply('지금은 ' + g.names[g.turn] + '님 차례예요.');

    if (action === 'eat' || action === 'feed') {
      g.peek = null;
      G.doEat(g, idx, action === 'eat');
      g.v++;
      return board();
    }

    if (action === 'use') {
      const item = ITEM_LIST[Number(extra)];
      const res = G.useItem(g, idx, item, null);
      if (res.err) return reply('⚠️ ' + res.err);
      if (res.needSteal) { g.stealing = true; g.v++; return board(); }
      if (item !== '투시안경') g.peek = null;
      g.v++;
      return board();
    }

    if (action === 'nosteal') {
      g.stealing = false;
      g.v++;
      return board();
    }

    if (action === 'steal') {
      if (!g.stealing) return reply('지금은 뺏을 아이템을 고르는 중이 아니에요.');
      const pick = ITEM_LIST[Number(extra)];
      const res = G.useItem(g, idx, '뺏어먹기', pick);
      if (res.err) return reply('⚠️ ' + res.err);
      g.stealing = false;
      if (pick !== '투시안경') g.peek = null;
      g.v++;
      return board();
    }

    return reply('알 수 없는 버튼이에요.');
  }

  return { json: { type: 1 } };
}

function newLobbyReply(it, channelId, uid, invite, base) {
  for (const id of Object.keys(lobbies)) {
    const lb = lobbies[id];
    if (lb.owner === uid && Date.now() - lb.created < config.LOBBY_TIMEOUT) {
      return { json: { type: 4, data: { content: '이미 모집 중인 대결이 있어요! 그 카드에서 취소하고 다시 해주세요.', flags: EPHEMERAL } } };
    }
  }
  const lb = {
    id: String(it.id || Date.now()), channelId, owner: uid, ownerName: displayName(it),
    invite: invite || null, created: Date.now(), token: it.token, starting: false
  };
  lobbies[lb.id] = lb;
  return { json: { type: 4, data: lobbyMessage(lb, base) } };
}

// 주기적으로: 시간 초과된 게임 끝내기, 끝난 게임 방 치우기, 오래된 모집 지우기
function sweep(base) {
  for (const id of Object.keys(lobbies)) {
    if (Date.now() - lobbies[id].created > config.LOBBY_TIMEOUT) delete lobbies[id];
  }
  for (const ch of Object.keys(games)) {
    const g = games[ch];
    if (g.threadId) {
      if (checkTimeout(g) && g.boardMsgId) {
        // 아무도 안 눌러서 시간 초과로 끝났으면 게임판에도 결과를 보여줘요
        api('PATCH', '/channels/' + g.threadId + '/messages/' + g.boardMsgId, boardMessage(g, base)).catch(() => {});
      }
      if (g.over) scheduleCleanup(g, base);
    } else if (g.over && Date.now() - g.last > 6 * 60 * 60 * 1000) {
      delete games[ch];
    }
  }
}

module.exports = {
  verify, handleInteraction, registerCommands, sweep, setFetch, games, lobbies, status, config,
  enabled: () => !!(APP_ID && PUBLIC_KEY)
};
