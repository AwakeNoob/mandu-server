/**
 * 디스코드 명령어(/독배 ...) 등록 스크립트
 * GitHub Actions의 "디스코드 명령어 등록" 버튼으로 실행해요. (Render 서버가 디스코드에 막혔을 때 대신 등록)
 * 필요한 GitHub 비밀값: DISCORD_APP_ID, DISCORD_TOKEN
 */
const { COMMANDS } = require('./mandu-discord.js');

const APP_ID = (process.env.DISCORD_APP_ID || '').trim();
const TOKEN = (process.env.DISCORD_TOKEN || '').trim();

(async () => {
  if (!APP_ID || !TOKEN) {
    console.error('❌ GitHub 비밀값 DISCORD_APP_ID, DISCORD_TOKEN 을 먼저 넣어주세요.');
    process.exit(1);
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch('https://discord.com/api/v10/applications/' + APP_ID + '/commands', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bot ' + TOKEN },
      body: JSON.stringify(COMMANDS)
    });
    const text = await res.text();
    if (res.ok) {
      const names = JSON.parse(text).map(c => '/' + c.name + ' ' + (c.options || []).map(o => o.name).join(', '));
      console.log('✅ 등록 완료! ' + names.join(' | '));
      console.log('디스코드 앱을 껐다 켜면 새 명령어가 보여요.');
      return;
    }
    if (res.status === 401) { console.error('❌ 토큰이 틀렸어요 (401). DISCORD_TOKEN 비밀값을 확인해 주세요.'); process.exit(1); }
    if (res.status === 403 || res.status === 404) { console.error('❌ APP ID나 토큰이 안 맞아요 (' + res.status + ').'); process.exit(1); }
    let wait = 5;
    try { wait = Math.ceil(JSON.parse(text).retry_after || 5); } catch (e) { /* */ }
    console.log('⏳ ' + res.status + ' 오류, ' + wait + '초 뒤 다시 시도 (' + attempt + '/5)');
    await new Promise(r => setTimeout(r, Math.min(wait, 60) * 1000));
  }
  console.error('❌ 5번 시도했지만 실패했어요. 잠시 뒤에 다시 눌러주세요.');
  process.exit(1);
})();
