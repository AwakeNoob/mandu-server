/**
 * 복불복 만두 - 디스코드 봇 (라이브러리 없이 HTTP 방식)
 * Render 환경변수: DISCORD_APP_ID, DISCORD_PUBLIC_KEY, DISCORD_TOKEN
 * 디스코드 개발자 포털의 "Interactions Endpoint URL"에  https://(서버주소)/discord  를 넣어요.
 *
 * 무료 서버는 디스코드 API가 자주 막혀서(429), 게임 중에는 서버가 디스코드에 먼저 요청하지 않고
 * 버튼을 누를 때 오는 요청에 "대답"하는 것만으로 게임판을 바꿔요.
 * 서버가 먼저 요청하는 건 처음 켜질 때 /만두 명령어 등록 한 번뿐이에요 (막히면 알아서 다시 시도).
 */
const crypto = require('crypto');
const G = require('./game.js');
const { ITEM_LIST, ICON, ITEM_DESC, MAX_HP, hearts, bag, cut, prio } = G;

const API = 'https://discord.com/api/v10';
const APP_ID = (process.env.DISCORD_APP_ID || '').trim();
const PUBLIC_KEY = (process.env.DISCORD_PUBLIC_KEY || '').trim();
const TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const TURN_TIMEOUT = 5 * 60 * 1000; // 디스코드는 실시간이라 5분
const LOBBY_TIMEOUT = 30 * 60 * 1000;
const EPHEMERAL = 64;

const games = {};   // 채널ID -> 게임 (대기실 포함)
const status = { commands: '아직 등록 안 됨', lastError: '' };

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

// ---------- 명령어 등록 (막히면 기다렸다가 다시) ----------
let fetchImpl = (...a) => fetch(...a);
function setFetch(f) { fetchImpl = f; }

const COMMANDS = [{
  name: '만두',
  description: '복불복 만두 게임',
  options: [
    { type: 1, name: '대결', description: '대결 상대를 찾아요',
      options: [{ type: 6, name: '상대', description: '이 사람만 참가할 수 있게 (비우면 아무나)', required: false }] },
    { type: 1, name: '규칙', description: '자세한 규칙을 나만 보이게 보여줘요' },
    { type: 1, name: '아이템', description: '아이템 도감을 나만 보이게 보여줘요' }
  ]
}];

async function registerCommands(attempt) {
  attempt = attempt || 1;
  if (!APP_ID || !TOKEN) { status.commands = '토큰이나 APP ID가 없어서 등록 안 함'; return; }
  let wait = 0;
  try {
    const res = await fetchImpl(API + '/applications/' + APP_ID + '/commands', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bot ' + TOKEN },
      body: JSON.stringify(COMMANDS)
    });
    if (res.ok) { status.commands = '등록 완료 ✅'; status.lastError = ''; console.log('디스코드 명령어 등록 완료'); return; }
    const text = await res.text().catch(() => '');
    status.lastError = res.status + ' ' + text.slice(0, 150);
    console.error('디스코드 명령어 등록 실패', status.lastError);
    if (res.status === 401) { status.commands = '토큰이 틀렸어요 (401) ❌'; return; }
    if (res.status === 403 || res.status === 404) { status.commands = 'APP ID나 토큰이 안 맞아요 (' + res.status + ') ❌'; return; }
    if (res.status === 400) { status.commands = '명령어 형식 오류 (400) ❌'; return; }
    if (res.status === 429) {
      let after = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 0;
      try { after = JSON.parse(text).retry_after || after; } catch (e) { /* 막힘 안내 페이지(HTML)일 수 있음 */ }
      wait = Math.max(after * 1000, 60 * 1000) * Math.min(attempt, 10);
      status.commands = '디스코드가 잠깐 막음 (429), ' + Math.round(wait / 60000) + '분 뒤 다시 시도 ⏳';
    } else {
      wait = 5 * 60 * 1000;
      status.commands = '오류 ' + res.status + ', 5분 뒤 다시 시도 ⏳';
    }
  } catch (e) {
    status.lastError = String(e).slice(0, 150);
    wait = 5 * 60 * 1000;
    status.commands = '연결 오류, 5분 뒤 다시 시도 ⏳';
  }
  if (wait) {
    const t = setTimeout(() => registerCommands(attempt + 1), wait);
    if (t.unref) t.unref();
  }
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

// ---------- 화면 ----------
function rulesEmbeds() {
  const part1 = '【한 줄 요약】\n' +
    '찜기 속에 매운 만두와 일반 만두가 섞여 있어요. 번갈아 가며 만두를 내가 먹거나 상대에게 먹여서, 상대의 참을성(❤️)을 먼저 0으로 만들면 이겨요!\n\n' +
    '【게임 시작】\n' +
    '• /만두 대결 → 아무나 참가 가능한 대결 만들기\n' +
    '• /만두 대결 상대:@친구 → 그 사람만 참가 가능\n' +
    '• 참가하기 버튼을 누르면 바로 시작! 참을성은 둘 다 ' + MAX_HP + '칸, 선공은 랜덤\n' +
    '• 다른 사람들은 같은 채널에서 구경할 수 있어요\n\n' +
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

function lobbyMessage(g, base) {
  return {
    embeds: [{
      title: '🥟 복불복 만두 대결 신청!',
      description: '**' + g.names[0] + '**님이 ' + (g.invite ? '<@' + g.invite + '>님에게 대결을 신청했어요!' : '대결 상대를 찾고 있어요!') +
        '\n\n찜기 속 매운 만두를 피해서 상대 참을성을 먼저 0으로 만들면 승리!\n처음이면 📖규칙을 눌러보세요.',
      color: 0xE8432C,
      image: { url: imgUrl(base, 'ev_match') }
    }],
    components: rowsOf([
      button('🥟 참가하기', 'md:join:' + g.v, 3),
      button('📖 규칙', 'md:rules', 2),
      button('❌ 취소', 'md:cancel:' + g.v, 4)
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
  if (g.over) footer = '게임 끝! 다시 하려면 ⚔️새 대결을 눌러주세요';
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
    rows = rowsOf([button('⚔️ 새 대결', 'md:new', 3), button('📖 규칙', 'md:rules', 2)]);
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

// ---------- 게임 만들기 ----------
function newLobby(channelId, it, inviteId) {
  const g = {
    lobby: true, v: 1, channelId,
    lobbyOwner: userOf(it).id, invite: inviteId || null,
    names: [displayName(it)], created: Date.now()
  };
  games[channelId] = g;
  return g;
}

function startFromLobby(lobby, it) {
  const players = [lobby.lobbyOwner, userOf(it).id];
  const names = [lobby.names[0], displayName(it)];
  const pending = [];
  const log = [];
  let gameRef = null;
  const g = G.createGame({
    players, names, channelId: lobby.channelId, v: lobby.v + 1, log, pending, peek: null, stealing: false,
    nameOf: p => names[p],
    emit: (p, t, img) => {
      if (p === null) { log.push(t); pending.push({ t, img }); }
      else if (gameRef) gameRef.peek = { p, text: t }; // 나만 보이는 소식 (투시안경)
    },
    onEnd: () => {}
  });
  gameRef = g;
  games[lobby.channelId] = g;
  return g;
}

function checkTimeout(g) {
  if (!g || g.lobby || g.over) return false;
  if (Date.now() - g.last <= TURN_TIMEOUT) return false;
  g.stealing = false;
  G.timeout(g, 5);
  g.v++;
  return true;
}

// ---------- 상호작용 처리 ----------
// 결과: { json } — 디스코드 요청에 바로 대답만 해요 (서버가 먼저 요청하지 않음)
function handleInteraction(it, base) {
  if (it.type === 1) return { json: { type: 1 } }; // PING
  const channelId = it.channel_id || (it.channel && it.channel.id);
  const uid = userOf(it).id;
  let g = games[channelId];
  if (g && g.lobby && Date.now() - g.created > LOBBY_TIMEOUT) { delete games[channelId]; g = null; }
  const timedOut = checkTimeout(g);

  const done = json => ({ json });
  const reply = content => done({ type: 4, data: { content, flags: EPHEMERAL } });
  const board = () => done({ type: 7, data: boardMessage(g, base) });

  // ----- 슬래시 명령 -----
  if (it.type === 2) {
    const sub = it.data.options && it.data.options[0];
    const name = sub && sub.name;
    if (name === '규칙') return done({ type: 4, data: { flags: EPHEMERAL, embeds: rulesEmbeds() } });
    if (name === '아이템') return done({ type: 4, data: { flags: EPHEMERAL, embeds: [itemBookEmbed(base)] } });
    if (name === '대결') {
      if (!it.guild_id) return reply('서버 채널에서만 할 수 있어요.');
      if (g && !g.over) return reply(g.lobby ? '이 채널에 이미 대결 신청이 있어요. 위 메시지에서 참가해 보세요!' : '이 채널에서 이미 게임 중이에요!');
      const opt = (sub.options || []).find(o => o.name === '상대');
      const invite = opt ? opt.value : null;
      if (invite === uid) return reply('자기 자신에게는 신청할 수 없어요.');
      const resolved = (it.data.resolved && it.data.resolved.users) || {};
      if (invite && resolved[invite] && resolved[invite].bot) return reply('봇과는 대결할 수 없어요.');
      const lobby = newLobby(channelId, it, invite);
      return done({ type: 4, data: lobbyMessage(lobby, base) });
    }
    return reply('알 수 없는 명령이에요.');
  }

  // ----- 버튼 -----
  if (it.type === 3) {
    const [, action, vStr, extra] = String(it.data.custom_id || '').split(':');
    const v = Number(vStr);

    if (action === 'rules') return done({ type: 4, data: { flags: EPHEMERAL, embeds: rulesEmbeds() } });

    if (action === 'new') {
      if (g && !g.over) return reply('이 채널에서 이미 ' + (g.lobby ? '대결 신청이 있어요.' : '게임 중이에요.'));
      const lobby = newLobby(channelId, it, null);
      return done({ type: 4, data: lobbyMessage(lobby, base) });
    }

    if (!g) return reply('이 게임은 이미 끝났어요. /만두 대결 로 새로 시작해 주세요.');

    // 대기실
    if (g.lobby) {
      if (v !== g.v) return reply('이미 지나간 신청이에요.');
      if (action === 'cancel') {
        if (uid !== g.lobbyOwner) return reply('신청한 사람만 취소할 수 있어요.');
        delete games[channelId];
        return done({ type: 7, data: { embeds: [{ title: '❌ 대결 신청이 취소됐어요', color: 0x95A5A6 }], components: [] } });
      }
      if (action === 'join') {
        if (uid === g.lobbyOwner) return reply('자기 대결에는 참가할 수 없어요. 친구를 기다려 주세요!');
        if (g.invite && uid !== g.invite) return reply('이 대결은 <@' + g.invite + '>님만 참가할 수 있어요.');
        g = startFromLobby(g, it);
        return board();
      }
      return reply('대결이 아직 시작 안 됐어요.');
    }

    // 시간 초과로 방금 끝났으면 누른 게임판에 결과를 보여줘요
    if (timedOut) return board();
    if (v !== g.v) return reply(g.over ? '이 게임은 끝났어요.' : '이미 지나간 화면이에요. 가장 최신 게임판에서 눌러주세요.');
    if (g.over) return reply('이 게임은 끝났어요.');

    const idx = g.players.indexOf(uid);
    if (idx < 0) return reply('구경 중이에요! 직접 하려면 게임이 끝난 뒤 /만두 대결 을 해보세요.');

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

// 오래된 게임 정리 (디스코드에 요청은 안 해요)
function sweep() {
  for (const ch of Object.keys(games)) {
    const g = games[ch];
    if (g.lobby && Date.now() - g.created > LOBBY_TIMEOUT) delete games[ch];
    else if (!g.lobby && g.over && Date.now() - g.last > 6 * 60 * 60 * 1000) delete games[ch];
  }
}

module.exports = {
  verify, handleInteraction, registerCommands, sweep, setFetch, games, status,
  enabled: () => !!(APP_ID && PUBLIC_KEY)
};
