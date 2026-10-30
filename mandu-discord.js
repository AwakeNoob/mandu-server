/**
 * 복불복 만두 - 디스코드 봇 (라이브러리 없이 HTTP 방식)
 * Render 환경변수: DISCORD_APP_ID, DISCORD_PUBLIC_KEY, DISCORD_TOKEN
 * 디스코드 개발자 포털의 "Interactions Endpoint URL"에  https://(서버주소)/discord  를 넣어요.
 */
const crypto = require('crypto');
const G = require('./game.js');
const { ITEM_LIST, ICON, ITEM_IMG, ITEM_DESC, MAX_HP, hearts, bag, cut, prio } = G;

const API = 'https://discord.com/api/v10';
const APP_ID = process.env.DISCORD_APP_ID || '';
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY || '';
const TOKEN = process.env.DISCORD_TOKEN || '';
const TURN_TIMEOUT = 5 * 60 * 1000; // 디스코드는 실시간이라 5분
const EPHEMERAL = 64;

const games = {};   // 채널ID -> 게임 (대기실 포함)

// ---------- 서명 확인 (디스코드가 보낸 요청인지) ----------
let pubKeyObj = null;
function verify(rawBody, sig, ts, publicKeyHex) {
  try {
    const hex = publicKeyHex || PUBLIC_KEY;
    if (!hex || !sig || !ts) return false;
    if (!pubKeyObj || publicKeyHex) {
      const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]);
      const k = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
      if (publicKeyHex) return crypto.verify(null, Buffer.concat([Buffer.from(ts), rawBody]), k, Buffer.from(sig, 'hex'));
      pubKeyObj = k;
    }
    return crypto.verify(null, Buffer.concat([Buffer.from(ts), rawBody]), pubKeyObj, Buffer.from(sig, 'hex'));
  } catch (e) {
    return false;
  }
}

// ---------- 디스코드 API 호출 ----------
let fetchImpl = (...a) => fetch(...a);
function setFetch(f) { fetchImpl = f; }

async function api(method, path, body, useBot) {
  const headers = { 'Content-Type': 'application/json' };
  if (useBot) headers.Authorization = 'Bot ' + TOKEN;
  const res = await fetchImpl(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) console.error('디스코드 API 오류', method, path, res.status, await res.text().catch(() => ''));
  return res;
}

async function registerCommands() {
  if (!APP_ID || !TOKEN) return;
  const cmd = {
    name: '만두',
    description: '복불복 만두 게임',
    options: [
      { type: 1, name: '대결', description: '대결 상대를 찾아요',
        options: [{ type: 6, name: '상대', description: '이 사람만 참가할 수 있게 (비우면 아무나)', required: false }] },
      { type: 1, name: '규칙', description: '자세한 규칙을 나만 보이게 보여줘요' },
      { type: 1, name: '아이템', description: '아이템 도감을 나만 보이게 보여줘요' }
    ]
  };
  await api('PUT', '/applications/' + APP_ID + '/commands', [cmd], true);
  console.log('디스코드 명령어 등록 완료');
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
  return { type: 2, style: style || 2, label, custom_id: id, disabled: !!disabled };
}
function row(...components) { return { type: 1, components }; }
function msg(content, ephemeral, extra) {
  return Object.assign({ content, flags: ephemeral ? EPHEMERAL : 0 }, extra || {});
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
    '게임판 아래 버튼은 자기 차례인 사람만 누를 수 있어요. 🎒아이템을 누르면 나만 보이는 아이템 메뉴가 떠요. 👓투시안경 결과도 나만 보여요.\n' +
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
    components: [row(
      button('🥟 참가하기', 'md:join:' + g.v, 3),
      button('📖 규칙', 'md:rules', 2),
      button('❌ 취소', 'md:cancel:' + g.v, 4)
    )]
  };
}

function boardMessage(g, base, fresh) {
  // fresh: 이번 행동으로 새로 생긴 소식들
  let main = -1;
  fresh.forEach((e, i) => { if (e.img && (main < 0 || prio(e.img) >= prio(fresh[main].img))) main = i; });
  if (main >= 0) { g.lastImg = fresh[main].img; g.lastTitle = fresh[main].t; }

  const log = g.log.slice(-12).map(l => (fresh.some(f => f.t === l) ? '**' + l + '**' : l)).join('\n');
  const flags = p => (g.asleep[p] ? ' 💤' : '') + (g.boomerang[p] ? ' 🪃' : '');
  const fields = [0, 1].map(p => ({
    name: (g.over ? '' : (g.turn === p ? '👉 ' : '')) + g.names[p] + flags(p),
    value: hearts(g.hp[p]) + '\n🎒 ' + bag(g.items[p]),
    inline: true
  }));
  const footer = g.over ? '게임 끝! 다시 하려면 새 대결을 눌러주세요'
    : '♨️ ' + g.round + '번째 찜기 · 남은 만두 ' + g.shells.length + '개' + (g.chili ? ' · 🌶️ 청양고추 들어감' : '') +
      '  ▶ ' + g.names[g.turn] + '님 차례';

  const embed = {
    title: cut(g.lastTitle || '🥟 복불복 만두', 256),
    description: cut(log, 4000),
    color: COLOR[g.lastImg] || 0xE67E22,
    fields,
    footer: { text: footer }
  };
  if (g.lastImg) embed.image = { url: imgUrl(base, g.lastImg) };

  const components = g.over
    ? [row(button('⚔️ 새 대결', 'md:new', 3), button('📖 규칙', 'md:rules', 2))]
    : [row(
        button('😋 먹기', 'md:eat:' + g.v, 1),
        button('🥢 먹이기', 'md:feed:' + g.v, 4),
        button('🎒 아이템', 'md:items:' + g.v, 2, g.items[g.turn].length === 0),
        button('📖 규칙', 'md:rules', 2),
        button('🏳️ 포기', 'md:quit:' + g.v, 2)
      )];
  return { embeds: [embed], components };
}

function itemMenu(g, idx, mode) {
  const list = mode === 'steal' ? G.stealChoices(g, idx) : g.items[idx];
  const count = {};
  for (const i of list) count[i] = (count[i] || 0) + 1;
  const options = Object.keys(count).slice(0, 25).map(i => ({
    label: ICON[i] + ' ' + i + (count[i] > 1 ? ' ×' + count[i] : ''),
    value: i,
    description: cut(ITEM_DESC[i], 100)
  }));
  return {
    content: mode === 'steal' ? '🤲 상대의 어떤 아이템을 뺏을까요?' : '🎒 쓸 아이템을 골라주세요. (나만 보여요)',
    flags: EPHEMERAL,
    components: [row({
      type: 3,
      custom_id: (mode === 'steal' ? 'md:steal:' : 'md:use:') + g.v,
      placeholder: mode === 'steal' ? '뺏을 아이템 고르기' : '아이템 고르기',
      options
    })]
  };
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
  const g = G.createGame({
    players, names, channelId: lobby.channelId, v: lobby.v + 1, log, pending, privateFor: {},
    nameOf: p => names[p],
    emit: (p, t, img) => {
      if (p === null) { log.push(t); pending.push({ t, img }); }
      else (g.privateFor[p] = g.privateFor[p] || []).push(t);
    },
    onEnd: () => {}
  });
  games[lobby.channelId] = g;
  return g;
}

function takeFresh(g) { return g.pending.splice(0); }
function takePrivate(g, p) { const out = (g.privateFor[p] || []); g.privateFor[p] = []; return out; }

// 게임판 메시지를 고치기 (아이템을 나만 보이는 메뉴로 썼을 때)
function updateBoardLater(g, base) {
  const token = g.boardToken;
  const body = boardMessage(g, base, takeFresh(g));
  return async () => {
    if (!token) return;
    await api('PATCH', '/webhooks/' + APP_ID + '/' + token + '/messages/@original', body, false);
  };
}

// 시간 초과 검사
function checkTimeout(g, base) {
  if (!g || g.lobby || g.over) return null;
  if (Date.now() - g.last <= TURN_TIMEOUT) return null;
  G.timeout(g, 5);
  g.v++;
  return updateBoardLater(g, base);
}

// ---------- 상호작용 처리 ----------
// 결과: { json, after } — json을 바로 응답하고, after()는 응답 뒤에 실행
function handleInteraction(it, base) {
  if (it.type === 1) return { json: { type: 1 } }; // PING
  const channelId = it.channel_id || (it.channel && it.channel.id);
  const uid = userOf(it).id;
  let g = games[channelId];
  const after = [];
  const tm = checkTimeout(g, base);
  if (tm) after.push(tm);
  if (g && g.lobby && Date.now() - g.created > 30 * 60 * 1000) { delete games[channelId]; g = null; }
  const done = json => ({ json, after: after.length ? async () => { for (const f of after) await f(); } : null });
  const reply = (content, extra) => done({ type: 4, data: msg(content, true, extra) });

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
      const bots = (it.data.resolved && it.data.resolved.users) || {};
      if (invite && bots[invite] && bots[invite].bot) return reply('봇과는 대결할 수 없어요.');
      const lobby = newLobby(channelId, it, invite);
      lobby.boardToken = it.token;
      return done({ type: 4, data: lobbyMessage(lobby, base) });
    }
    return reply('알 수 없는 명령이에요.');
  }

  // ----- 버튼 / 선택 메뉴 -----
  if (it.type === 3) {
    const [, action, vStr] = String(it.data.custom_id || '').split(':');
    const v = Number(vStr);

    if (action === 'rules') return done({ type: 4, data: { flags: EPHEMERAL, embeds: rulesEmbeds() } });

    if (action === 'new') {
      if (g && !g.over) return reply('이 채널에서 이미 ' + (g.lobby ? '대결 신청이 있어요.' : '게임 중이에요.'));
      const lobby = newLobby(channelId, it, null);
      lobby.boardToken = it.token;
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
        const game = startFromLobby(g, it);
        game.boardToken = it.token;
        return done({ type: 7, data: boardMessage(game, base, takeFresh(game)) });
      }
      return reply('대결이 아직 시작 안 됐어요.');
    }

    // 게임 중
    const idx = g.players.indexOf(uid);
    if (g.over) return reply('이 게임은 끝났어요.');
    if (idx < 0) return reply('구경 중이에요! 직접 하려면 게임이 끝난 뒤 /만두 대결 을 해보세요.');

    if (action === 'quit') {
      if (v !== g.v) return reply('이미 지나간 화면이에요. 가장 아래 게임판에서 눌러주세요.');
      G.forfeit(g, idx);
      g.v++;
      g.boardToken = it.token;
      return done({ type: 7, data: boardMessage(g, base, takeFresh(g)) });
    }

    if (g.turn !== idx) return reply('지금은 ' + g.names[g.turn] + '님 차례예요.');

    if (action === 'eat' || action === 'feed') {
      if (v !== g.v) return reply('이미 지나간 화면이에요. 최신 게임판에서 눌러주세요.');
      G.doEat(g, idx, action === 'eat');
      g.v++;
      g.boardToken = it.token;
      return done({ type: 7, data: boardMessage(g, base, takeFresh(g)) });
    }

    if (action === 'items') {
      if (v !== g.v) return reply('이미 지나간 화면이에요. 최신 게임판에서 눌러주세요.');
      if (!g.items[idx].length) return reply('가방이 비어 있어요.');
      return done({ type: 4, data: itemMenu(g, idx, 'use') });
    }

    if (action === 'use' || action === 'steal') {
      const picked = it.data.values && it.data.values[0];
      if (v !== g.v) return done({ type: 7, data: { content: '상황이 바뀌었어요. 게임판에서 🎒아이템을 다시 눌러주세요.', components: [] } });
      const res = action === 'steal' ? G.useItem(g, idx, '뺏어먹기', picked) : G.useItem(g, idx, picked, null);
      if (res.err) return done({ type: 7, data: { content: '⚠️ ' + res.err, components: [] } });
      if (res.needSteal) return done({ type: 7, data: itemMenu(g, idx, 'steal') });
      g.v++;
      const secret = takePrivate(g, idx);
      const used = action === 'steal' ? '🤲 ' + picked + '을(를) 뺏어서 사용했어요!' : ICON[picked] + ' ' + picked + ' 사용!';
      after.push(updateBoardLater(g, base));
      return done({ type: 7, data: { content: used + (secret.length ? '\n' + secret.join('\n') : ''), components: [] } });
    }

    return reply('알 수 없는 버튼이에요.');
  }

  return { json: { type: 1 } };
}

// 5분 넘게 안 움직인 게임을 주기적으로 정리
function sweep(base) {
  for (const ch of Object.keys(games)) {
    const g = games[ch];
    const f = checkTimeout(g, base);
    if (f) f().catch(() => {});
    if (g.lobby && Date.now() - g.created > 30 * 60 * 1000) delete games[ch];
  }
}

module.exports = { verify, handleInteraction, registerCommands, sweep, setFetch, games, enabled: () => !!(APP_ID && PUBLIC_KEY) };
