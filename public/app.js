import { DEFAULT_BET_SIZES, raisePresets, raisePreview } from './betting.js';

const $ = selector => document.querySelector(selector);
const app = $('#app');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const format = value => Number(value || 0).toLocaleString('ko-KR');
const accountName = account => account?.displayName || account?.username || '';
const RING_ROOM_ID = 'ring-sixmax';
const stages = { waiting: '친구를 기다리는 중', preflop: '프리플롭', flop: '플롭', turn: '턴', river: '리버', finished: '핸드 종료' };
const suits = ['♠', '♥', '♣', '♦'];
let room, socket, account = null, retryTimer, toastTimer, panel = 'history', pending = false, reconnectAttempt = 0;
let ringLobbyPlayers = [], ringLobbyTimer, connected = false;
let displayUnit = 'chips', betSizes = {}, calculatorValue = '0';
let currentTournament = null;
let inviteFormat = null, inviteInfoCode = '', pendingRoomId = null;
let replyTimer, resumeTimer, renderedTurn = null;
let stateQueue = [], queueTimer = null, animFrom = null, latestRoom = null;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let openHands = new Set();
let code = new URLSearchParams(location.search).get('room') || '';
function readLocal(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function saveLocal(key, value) { try { localStorage.setItem(key, value); } catch { /* Private browser storage can be unavailable. */ } }
function defaultBetSizes() {
  return Object.fromEntries(['ring', 'tournament'].map(mode => [mode, {
    preflop: structuredClone(DEFAULT_BET_SIZES.preflop), postflop: structuredClone(DEFAULT_BET_SIZES.postflop),
  }]));
}
function validSize(size) {
  return size && ['bb', 'pot'].includes(size.unit) && Number.isFinite(size.value)
    && (size.unit === 'bb' ? size.value >= 0.5 && size.value <= 100 : size.value >= 1 && size.value <= 1000);
}
function loadBetSizes() {
  const defaults = defaultBetSizes();
  try {
    const saved = JSON.parse(readLocal('river-bet-sizes', '{}'));
    for (const mode of ['ring', 'tournament']) for (const [street, min, max] of [['preflop', 4, 4], ['postflop', 4, 6]]) {
      const sizes = saved[mode]?.[street];
      if (Array.isArray(sizes) && sizes.length >= min && sizes.length <= max && sizes.every(validSize)) defaults[mode][street] = sizes;
    }
  } catch { /* Use the built-in presets when browser storage is unavailable or invalid. */ }
  return defaults;
}
displayUnit = readLocal('river-chip-unit', 'chips') === 'bb' ? 'bb' : 'chips';
betSizes = loadBetSizes();
function recentRooms() { try { return JSON.parse(readLocal('river-rooms', '[]')); } catch { return []; } }
function entryButtonLabel() {
  if (code && code !== RING_ROOM_ID) return '토너먼트 참가하기 →';
  return currentTournament ? '현재 토너먼트 참가하기 →' : '토너먼트 시작하기 →';
}
function ringLobbyRows() {
  return ringLobbyPlayers.length ? `<ol class="ring-lobby-list">${ringLobbyPlayers.map(player => `<li><b>${escape(player.name)}</b><span>${player.seated ? '테이블 참가 중' : '퇴장'}</span><strong>이번 주 추가 ${format(player.weeklyBuyIns)}회</strong></li>`).join('')}</ol>` : '<p class="ring-lobby-empty">이번 주 추가 바이인 기록이 없습니다.</p>';
}
async function loadRingLobby() {
  try {
    const result = await api('/api/ring/lobby', undefined, 'GET');
    ringLobbyPlayers = result.players;
    const target = $('#ring-lobby-list');
    if (target) target.innerHTML = ringLobbyRows();
  } catch { /* The public lobby stays usable if ring statistics are unavailable. */ }
}
function card(value, extra = '') {
  if (value === undefined) return '<div class="card placeholder" aria-label="아직 공개되지 않은 카드">♧</div>';
  if (value === null) return '<div class="card back" aria-label="상대의 비공개 카드"><span>♠</span></div>';
  const rank = value % 13 + 2, suit = Math.floor(value / 13);
  return `<div class="card suit-${suit} ${suit % 2 ? 'red' : ''} ${extra}" aria-label="${['스페이드', '하트', '클럽', '다이아몬드'][suit]} ${rank}"><b>${({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' })[rank] || rank}</b><span>${suits[suit]}</span></div>`;
}
function tableAmount(value) {
  return displayUnit === 'bb' && room?.bigBlind
    ? `${(Number(value) / room.bigBlind).toLocaleString('ko-KR', { maximumFractionDigits: 2 })} BB`
    : format(value);
}
function notify(text) { $('#toast').textContent = text; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
async function api(path, data, method = 'POST') {
  const options = { method, headers: {} };
  if (method !== 'GET') { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(data || {}); }
  const response = await fetch(path, options);
  let payload;
  try { payload = await response.json(); } catch { throw new Error('서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.'); }
  if (!response.ok) throw new Error(payload.error || '요청을 처리하지 못했습니다.');
  return payload;
}
function renderAuthHeader() {
  const label = $('#account-indicator'), button = $('#logout-button');
  if (!label || !button) return;
  label.hidden = !account;
  button.hidden = !account;
  label.textContent = account ? `${accountName(account)} · ${format(account.money)} 머니` : '';
}
async function logout() {
  try { await api('/api/auth/logout'); } catch { /* Clearing the browser cookie also ends an unavailable server session. */ }
  account = null; room = null; code = ''; pendingRoomId = null;
  clearTimeout(retryTimer); clearTimeout(replyTimer); clearTimeout(resumeTimer);
  if (socket) { socket.onclose = null; socket.close(); socket = null; }
  connected = false; pending = false; latestRoom = null;
  clearStateQueue();
  history.replaceState({}, '', '/');
  renderAuthHeader(); home();
}
async function resumeRoom() {
  if (!account || !code) return;
  try {
    const data = { nickname: accountName(account), entryMethod: account.money >= 10000 ? 'money' : 'count' };
    if (code === RING_ROOM_ID) account = (await api('/api/ring/join', data)).account;
    else {
      const info = await api(`/api/rooms/${code}/info`, undefined, 'GET');
      if (!info.canJoin) { notify('토너먼트 참가가 마감됐거나 자리가 없습니다.'); return; }
      const result = await api(`/api/rooms/${code}/join`, data);
      if (result.account) account = result.account;
    }
    renderAuthHeader();
    connect();
  } catch (error) { notify(error.message); }
}
function home() {
  app.className = account ? 'home lobby' : 'home auth';
  document.body.classList.remove('in-game');
  const invited = Boolean(code && code !== RING_ROOM_ID);
  const creating = !invited;
  if (!invited) currentTournament = null;
  if (inviteInfoCode !== code) { inviteInfoCode = code; inviteFormat = null; }
  const tournament = creating || (invited && inviteFormat?.mode === 'tournament');
  if (!account) {
    clearInterval(ringLobbyTimer);
    app.innerHTML = `<section class="welcome">
      <h1>우리들의 <em>홀덤.</em></h1>
      <p class="intro">친구들과 함께하는 홀덤 테이블</p>
      <form id="account-form" class="entry-form account-form"><div class="form-title"><h2>로그인 / 계정 만들기</h2></div><label for="account-username">아이디</label><input id="account-username" name="username" autocomplete="username" required><label for="account-display-name">이름 (가입 시 표시)</label><input id="account-display-name" name="displayName" autocomplete="name" maxlength="20"><label for="account-password">비밀번호</label><input id="account-password" name="password" type="password" autocomplete="current-password" required><div class="lobby-actions"><button class="outline" name="authAction" value="login">로그인</button><button class="primary" name="authAction" value="register">가입하기</button></div><p class="form-note">새 계정은 아이디와 비밀번호를 각각 4자 이상으로 입력해 주세요. 가입할 때 이름을 입력해 주세요. 가입 시 개인 머니 10,000이 지급됩니다. 비밀번호를 잊으면 현재는 재설정할 수 없습니다.</p></form>
    </section>`;
    $('#account-form').addEventListener('submit', async event => {
      event.preventDefault();
      const submitter = event.submitter;
      const action = submitter?.value === 'register' ? 'register' : 'login';
      const form = event.currentTarget;
      if (form.dataset.busy) return;
      const username = form.elements.username.value.trim();
      const displayName = form.elements.displayName.value.trim();
      const password = form.elements.password.value;
      if (action === 'register' && (username.length < 4 || password.length < 4)) { notify('아이디와 비밀번호를 각각 4자 이상 입력해 주세요.'); return; }
      if (action === 'register' && !displayName) { notify('이름을 입력해 주세요.'); return; }
      form.dataset.busy = 'true';
      form.querySelectorAll('button').forEach(button => { button.disabled = true; });
      try {
        await api('/api/session');
        const result = await api(`/api/auth/${action}`, { username, password, ...(action === 'register' ? { displayName } : {}) });
        account = result.account;
        renderAuthHeader(); home(); await resumeRoom();
      } catch (error) { form.dataset.busy = ''; notify(error.message); form.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
    });
    return;
  }
  app.innerHTML = `<section class="lobby-heading">
    <div><p class="eyebrow">RIVER LOBBY</p><h1>${escape(accountName(account))}님, 게임을 선택하세요.</h1><p class="intro">링게임 또는 토너먼트에 바로 입장할 수 있어요.</p></div>
    <section class="account-card" aria-label="내 계정"><b>${escape(accountName(account))}님</b><p>개인 머니 <strong>${format(account.money)}</strong></p><small>링게임 입장 시 바이인 차감 · 퇴장 시 남은 칩 환급</small>${account.money <= 5000 ? '<button type="button" id="ring-topup" class="outline">개인 머니를 10,000으로 충전</button>' : ''}</section>
  </section>
  <section class="game-selection" aria-label="게임 선택">
    <article class="game-option"><p class="eyebrow">6 MAX · CASH GAME</p><h2>링게임</h2><p>블라인드 100 / 200 · 시작 스택 10,000칩 (50 BB)</p><button type="button" id="ring-entry" class="primary large">링게임 입장하기 <span>→</span></button></article>
    <article class="game-option"><p class="eyebrow">9 MAX · TOURNAMENT</p><h2>${invited ? '초대 토너먼트' : '토너먼트'}</h2><p id="tournament-description">시작 칩 10,000 · 최대 9명 · 리엔트리 최대 2회</p>
      <form id="entry-form" class="tournament-form">
        <div id="tournament-speed-field" ${creating ? '' : 'hidden'}><label for="tournament-speed">블라인드 레벨업</label><select id="tournament-speed"><option value="normal">기본 · 6분</option><option value="turbo">터보 · 3분</option></select></div>
        <div id="tournament-entry-field" ${tournament ? '' : 'hidden'}><label for="tournament-entry-method">바이인 방식</label><select id="tournament-entry-method"><option value="money" ${account.money < 10000 ? 'disabled' : ''}>개인 머니 10,000 사용</option><option value="count" ${account.money >= 10000 ? 'disabled' : ''}>바이인 횟수 +1</option></select><p class="form-note">개인 머니가 10,000 이상이면 머니를 먼저 사용합니다.</p></div>
        ${invited ? `<p class="invite-hint">초대 코드 <span>${escape(code)}</span></p>` : ''}
        <button class="primary large" id="entry-button">${entryButtonLabel()}</button>
      </form>
    </article>
  </section>
  <section class="ring-lobby weekly-buyins" aria-labelledby="ring-lobby-title"><header><h2 id="ring-lobby-title">이번 주 링게임 추가 바이인</h2><p>한국 시간 기준 월요일부터 일요일까지 · 게임 중 직접 추가한 바이인만 집계합니다. 머니로 입장하거나 재입장한 횟수는 제외합니다.</p></header><div id="ring-lobby-list">${ringLobbyRows()}</div></section>
  <footer class="home-footer"><span>가상 칩 게임 · 결제와 환전 없음</span></footer>`;
  const updateTournamentFields = () => {
    if (!invited && currentTournament) {
      $('#tournament-speed-field').hidden = true;
      $('#tournament-entry-field').hidden = true;
      const state = currentTournament.startedAt === null ? '시작 대기' : `블라인드 ${format(currentTournament.bigBlind)}`;
      $('#tournament-description').textContent = `${currentTournament.name} · ${currentTournament.players}/${currentTournament.maxPlayers}명 · ${state} · 5BB까지 참가 가능`;
    } else {
      const speed = invited ? inviteFormat?.tournamentSpeed : $('#tournament-speed')?.value;
      $('#tournament-speed-field').hidden = !creating;
      $('#tournament-entry-field').hidden = !tournament;
      $('#tournament-description').textContent = `시작 칩 10,000 · ${speed === 'turbo' ? '터보 3분' : '기본 6분'} · 최대 9명 · 리엔트리 최대 2회 · 5BB까지 참가 가능`;
    }
    $('#entry-button').textContent = entryButtonLabel();
  };
  $('#tournament-speed')?.addEventListener('change', updateTournamentFields);
  if (!invited) api('/api/tournaments/current', undefined, 'GET').then(result => {
    currentTournament = result.room;
    updateTournamentFields();
  }).catch(() => {});
  if (invited) {
    const requestedCode = code;
    api(`/api/rooms/${requestedCode}/info`, undefined, 'GET').then(info => {
      if (code !== requestedCode || !$('#entry-form')) return;
      inviteInfoCode = requestedCode; inviteFormat = info.format;
      updateTournamentFields();
      $('#tournament-entry-field').hidden = info.format.mode !== 'tournament';
      $('#entry-button').disabled = !info.canJoin;
      if (!info.canJoin) $('#entry-button').textContent = '이미 시작된 토너먼트';
    }).catch(error => notify(error.message));
  }
  $('#ring-topup')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      account = (await api('/api/ring/topup', {})).account;
      renderAuthHeader(); home();
      notify('개인 머니를 10,000으로 충전했어요.');
    } catch (error) { notify(error.message); button.disabled = false; }
  });
  $('#ring-entry').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true; button.textContent = '테이블에 연결하는 중…';
    try {
      await api('/api/session');
      const result = await api('/api/ring/join', { nickname: accountName(account) });
      account = result.account; renderAuthHeader(); code = result.code;
      history.replaceState({}, '', `/?room=${code}`); connect();
    } catch (error) { notify(error.message); button.disabled = false; button.innerHTML = '링게임 입장하기 <span>→</span>'; }
  });
  if ($('#logout-button')) $('#logout-button').onclick = logout;
  $('#entry-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!account) { notify('먼저 로그인해 주세요.'); return; }
    const button = $('#entry-button'); button.disabled = true; button.textContent = '테이블에 연결하는 중…';
    try {
      await api('/api/session');
      const activeTournament = invited ? null : (await api('/api/tournaments/current', undefined, 'GET')).room;
      const targetCode = invited ? code : activeTournament?.code;
      const data = {
        nickname: accountName(account),
        entryMethod: account.money >= 10000 ? ($('#tournament-entry-method')?.value || 'money') : 'count',
        ...(!targetCode ? { format: { mode: 'tournament', tournamentSpeed: $('#tournament-speed').value } } : {}),
      };
      if (!targetCode) {
        pendingRoomId ||= crypto.randomUUID().replaceAll('-', '').slice(0, 16);
        data.id = pendingRoomId;
      }
      const result = targetCode ? await api(`/api/rooms/${targetCode}/join`, data) : await api('/api/rooms', data);
      account = result.account || (await api('/api/auth/me', undefined, 'GET')).account;
      renderAuthHeader();
      pendingRoomId = null;
      code = result.code; history.replaceState({}, '', `/?room=${code}`); connect();
    } catch (error) { notify(error.message); button.disabled = false; button.textContent = entryButtonLabel(); }
  });
  clearInterval(ringLobbyTimer);
  loadRingLobby();
  ringLobbyTimer = setInterval(() => { if ($('#ring-lobby-list')) loadRingLobby(); }, 15000);
}
function connect() {
  clearTimeout(retryTimer); clearTimeout(replyTimer); clearTimeout(resumeTimer);
  if (!code) return;
  if (socket) { socket.onclose = null; socket.close(); }
  connected = false; pending = false;
  clearStateQueue();
  if (room) render();
  const socketPath = code === RING_ROOM_ID ? '/api/ring/socket' : `/api/rooms/${code}/socket`;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${socketPath}`);
  socket = ws;
  ws.onmessage = async event => {
    if (socket !== ws) return;
    clearTimeout(resumeTimer);
    if (event.data === 'pong') return;
    const data = JSON.parse(event.data);
    if (data.type === 'state') {
          latestRoom = data.room; pending = false; connected = true; reconnectAttempt = 0;
      clearTimeout(replyTimer);
      saveLocal('river-rooms', JSON.stringify([{ id: latestRoom.id, name: latestRoom.name }, ...recentRooms().filter(r => r.id !== latestRoom.id)].slice(0, 5)));
      stateQueue.push({ next: data.room, preserve: true });
      showNextState();
    } else if (data.type === 'error') { pending = false; clearTimeout(replyTimer); notify(data.error); }
    else if (data.type === 'account') { account = data.account; renderAuthHeader(); }
    else if (data.type === 'left') {
      clearTimeout(replyTimer); clearTimeout(resumeTimer); clearTimeout(retryTimer);
      ws.onclose = null; ws.close(); socket = null; room = null; code = ''; connected = false; pending = false;
      clearStateQueue(); latestRoom = null;
      try { account = (await api('/api/auth/me', undefined, 'GET')).account; } catch { account = null; }
      renderAuthHeader();
      history.replaceState({}, '', '/'); home();
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    connected = false; pending = false;
    clearTimeout(replyTimer); clearTimeout(resumeTimer);
    if (room) render(); else { notify('연결이 끊겼습니다. 다시 연결하는 중입니다.'); home(); }
    if (navigator.onLine) retryTimer = setTimeout(connect, Math.min(15000, 1000 * 2 ** reconnectAttempt++));
  };
}
function clearStateQueue() { stateQueue = []; clearTimeout(queueTimer); queueTimer = null; }
function pacing(prev, next) {
  if (!prev || prev.id !== next.id || prev.hand !== next.hand) return 0;
  if (next.stage === 'finished' && prev.stage !== 'finished') return 3000;
  if (reducedMotion.matches) return 0;
  const revealed = next.board.length - prev.board.length;
  if (revealed > 0) return 400 + revealed * 600;
  return next.players.some(p => p.lastAction && p.lastAction !== prev.players.find(q => q.id === p.id)?.lastAction) ? 700 : 0;
}
function showNextState() {
  if (queueTimer || !stateQueue.length) return;
  const { next, preserve } = stateQueue.shift();
  const delay = pacing(room, next);
  animFrom = delay ? room : null;
  room = next;
  render(preserve);
  animFrom = null;
  if (delay) queueTimer = setTimeout(() => { queueTimer = null; showNextState(); }, delay);
  else showNextState();
}
function confirmAction(action, amount) {
  const legal = room.legal, chips = room.players.find(p => p.id === room.me)?.chips ?? 0;
  if (action === 'fold' && legal?.canCheck) return confirm('지금은 칩을 내지 않고 체크할 수 있어요. 그래도 폴드할까요?');
  const allIn = action === 'call' ? legal?.toCall >= chips : action === 'raise' && amount >= legal?.max;
  return !allIn || confirm(`남은 스택 ${tableAmount(chips)}을 모두 걸어 올인할까요?`);
}
function checkConnection() {
  if (!code || !room || document.hidden || !navigator.onLine) return;
  if (!connected || socket?.readyState !== WebSocket.OPEN) { connect(); return; }
  socket.send('ping');
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(connect, 6000);
}
function send(type, data = {}) {
  if (!connected || pending || socket?.readyState !== WebSocket.OPEN) return;
  pending = true; socket.send(JSON.stringify({ type, revision: (latestRoom || room).revision, ...data }));
  clearTimeout(replyTimer);
  replyTimer = setTimeout(() => { notify('응답이 늦어 다시 연결합니다. 행동 결과를 확인해 주세요.'); connect(); }, 8000);
  document.querySelectorAll('[data-send], [data-action], [data-queue], #raise-button, #raise-amount, #raise-range, [data-bet]').forEach(el => { el.disabled = true; });
}
// Seats sit evenly on an ellipse, starting with this player at the bottom and moving clockwise.
function seatPosition(index, count) {
  const angle = Math.PI / 2 + index * 2 * Math.PI / Math.max(count, 2);
  const x = 50 + 41 * Math.cos(angle), y = 50 + 36 * Math.sin(angle);
  const toward = (value, factor) => `${(value + (50 - value) * factor).toFixed(2)}%`;
  return { '--sx': `${x.toFixed(2)}%`, '--sy': `${y.toFixed(2)}%`, '--bx': toward(x, 0.4), '--by': toward(y, 0.44) };
}
function queuePanel(me) {
  const toCall = Math.min(Math.max(0, room.bet - me.bet), me.chips);
  const queued = room.queued;
  const options = [['checkFold', '체크/폴드'], toCall ? ['call', `콜 ${tableAmount(toCall)}`] : ['check', '체크'], ['fold', '폴드']];
  const stale = queued?.type === 'call' && queued.cap !== toCall;
  const disabled = connected && !pending ? '' : 'disabled';
  return `<section class="queue-panel" aria-label="내 차례 전에 미리 선택">
    <div class="queue-options">${options.map(([type, label]) => `<button type="button" class="queue-option ${type === 'fold' ? 'queue-fold' : ''}" data-queue="${type}" aria-pressed="${queued?.type === type}" ${disabled}>${label}</button>`).join('')}</div>
    <p class="queue-note" aria-live="polite">${stale ? '콜 금액이 바뀌어 차례가 오면 예약이 취소돼요.' : queued ? '내 차례가 오면 바로 실행돼요. 한 번 더 누르면 취소돼요.' : '미리 골라두면 내 차례에 자동으로 실행되고, 이번 베팅 라운드가 끝나면 사라져요.'}</p>
  </section>`;
}
function readSizeRows(container) {
  return [...container.querySelectorAll('.bet-size-row')].map(row => ({
    unit: row.querySelector('[data-size-unit]').value,
    value: Number(row.querySelector('[data-size-value]').value),
  }));
}
function renderBetSizeRows(container, sizes, street) {
  const title = street === 'preflop' ? '프리플롭' : '플랍 이후';
  container.innerHTML = sizes.map((size, index) => `<div class="bet-size-row"><span>${index + 1}</span><select data-size-unit aria-label="${title} ${index + 1} 단위"><option value="bb" ${size.unit === 'bb' ? 'selected' : ''}>BB</option><option value="pot" ${size.unit === 'pot' ? 'selected' : ''}>팟 %</option></select><input type="number" data-size-value aria-label="${title} ${index + 1} 값" min="${size.unit === 'bb' ? 0.5 : 1}" max="${size.unit === 'bb' ? 100 : 1000}" step="0.1" value="${size.value}" required>${street === 'postflop' && sizes.length > 4 ? `<button type="button" class="outline remove-bet-size" data-remove-size="${index}" aria-label="${index + 1}번 사이즈 삭제">−</button>` : '<span></span>'}</div>`).join('');
  container.querySelectorAll('[data-size-unit]').forEach(select => {
    select.onchange = () => {
      const input = select.closest('.bet-size-row').querySelector('[data-size-value]');
      input.min = select.value === 'bb' ? '0.5' : '1';
      input.max = select.value === 'bb' ? '100' : '1000';
      if (Number(input.value) < Number(input.min)) input.value = input.min;
    };
  });
  container.querySelectorAll('[data-remove-size]').forEach(button => {
    button.onclick = () => {
      const next = readSizeRows(container);
      if (next.length > 4) next.splice(Number(button.dataset.removeSize), 1);
      renderBetSizeRows(container, next, street);
      $('#add-postflop-size').disabled = next.length >= 6;
    };
  });
}
function openBetSettings() {
  if (!room) return;
  const settings = betSizes[room.format.mode];
  $('#bet-settings-context').textContent = `${room.name} · ${room.format.mode === 'ring' ? '링게임' : '토너먼트'}`;
  renderBetSizeRows($('#preflop-size-list'), settings.preflop, 'preflop');
  renderBetSizeRows($('#postflop-size-list'), settings.postflop, 'postflop');
  $('#add-postflop-size').disabled = settings.postflop.length >= 6;
  $('#bet-settings').showModal();
}
function openBetCalculator() {
  const input = $('#raise-amount');
  if (!input || !room?.legal?.canRaise) return;
  calculatorValue = input.value || String(room.legal.min);
  $('#bet-calculator-display').textContent = format(calculatorValue);
  $('#bet-calculator-help').textContent = `${format(room.legal.min)}~${format(room.legal.max)}칩 · 000 버튼으로 천 단위 입력`;
  $('#bet-calculator').showModal();
}
function calculatorKey(key) {
  const next = key === 'clear' ? '0' : key === 'delete' ? calculatorValue.slice(0, -1) || '0'
    : `${calculatorValue === '0' ? '' : calculatorValue}${key}`;
  if (next.length > 15) return;
  calculatorValue = next.replace(/^0+(?=\d)/, '');
  $('#bet-calculator-display').textContent = format(calculatorValue);
}
function seat(player, index, count) {
  if (!player) return `<div class="seat seat-${index} empty-seat"><span class="empty-avatar">+</span><span>친구의 자리</span></div>`;
  const me = player.id === room.me;
  const playerIndex = room.players.indexOf(player);
  const playing = !['waiting', 'finished'].includes(room.stage);
  const positions = `${playerIndex === room.dealer ? '<span class="dealer-badge" title="딜러">D</span>' : ''}${playing && playerIndex === room.sb ? '<span class="blind-badge" title="스몰 블라인드">SB</span>' : ''}${playing && playerIndex === room.bb ? '<span class="blind-badge" title="빅 블라인드">BB</span>' : ''}`;
  const acted = animFrom && player.lastAction && player.lastAction !== animFrom.players.find(p => p.id === player.id)?.lastAction;
  const won = room.stage === 'finished' && room.result.some(r => r.id === player.id);
  return `${playing && player.bet > 0 ? `<span class="table-bet" data-seat-pos="${index},${count}" aria-hidden="true"><i></i>${tableAmount(player.bet)}</span>` : ''}<div data-seat-pos="${index},${count}" class="seat seat-${index} ${me ? 'my-seat' : ''} ${room.turn === room.players.indexOf(player) ? 'active-seat' : ''} ${player.folded && player.active ? 'folded' : ''} ${acted ? 'acted' : ''} ${won ? 'winner' : ''} ${won && animFrom ? 'just-won' : ''}">
    <div class="seat-cards">${player.cards.map(c => card(c)).join('')}</div>
    <div class="player-info"><span class="avatar">${escape([...player.name][0])}</span><div><b>${escape(player.name)}${me ? ' <small>나</small>' : ''}</b><span class="chips" title="${format(player.chips)}칩">${tableAmount(player.chips)}</span></div><span class="presence ${player.online ? 'online' : ''}" aria-label="${player.online ? '접속 중' : '연결 끊김'}"></span></div>
    <div class="player-state">${positions ? `<span class="seat-positions">${positions}</span>` : ''}${playing ? escape(player.lastAction || '') : player.chips <= 0 ? (room.format.mode === 'tournament' ? '리엔트리 필요' : '바이인 필요') : player.online ? '자동 참가' : '재접속 대기'}</div>
    ${playing && player.bet > 0 ? `<span class="seat-bet" aria-label="이번 라운드 총 베팅 ${format(player.bet)}칩">베팅 ${tableAmount(player.bet)}</span>` : ''}
  </div>`;
}
function render() {
  if ($('#bet-calculator')?.open && !room.legal?.canRaise) $('#bet-calculator').close();
  const focused = app.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focused?.id ? `#${focused.id}` : focused?.dataset.panel ? `[data-panel="${focused.dataset.panel}"]` : focused?.dataset.send ? `[data-send="${focused.dataset.send}"]` : focused?.dataset.action ? `[data-action="${focused.dataset.action}"]` : focused?.dataset.bet ? `[data-bet="${focused.dataset.bet}"]` : null;
  const turnKey = `${room.hand}:${room.stage}:${room.turn}:${room.bet}`;
  const previousAmount = renderedTurn === turnKey ? $('#raise-amount')?.value ?? null : null;
  if (panel === 'history') openHands = new Set([...document.querySelectorAll('details.history-entry[open]')].map(d => d.dataset.hand));
  renderedTurn = turnKey;
  app.className = 'game';
  document.body.classList.add('in-game');
  const me = room.players.find(p => p.id === room.me);
  const idle = ['waiting', 'finished'].includes(room.stage);
  const ring = room.format.mode === 'ring';
  const tournament = room.format.mode === 'tournament';
  const champion = tournament ? room.players.find(player => player.id === room.tournament.winnerId) : null;
  const tournamentLevelLabel = tournament && room.tournament.activeLevel !== room.tournament.level
    ? `핸드 레벨 ${room.tournament.activeLevel} · 다음 ${room.tournament.level}` : `레벨 ${room.tournament?.activeLevel || 1}`;
  const legal = room.legal;
  const canQueue = me?.active && !me.folded && me.chips > 0;
  // Rotate seats so this player is always at the bottom of the table.
  const ownIndex = room.players.findIndex(p => p.id === room.me);
  const ordered = ownIndex >= 0 ? [...room.players.slice(ownIndex), ...room.players.slice(0, ownIndex)] : room.players;
  const disabled = connected && !pending ? '' : 'disabled';
  const lobbyTitle = champion ? `${escape(champion.name)} 님이 토너먼트에서 우승했습니다.` : room.stage === 'finished' ? room.result.map(r => `${escape(r.name)} +${tableAmount(r.amount)}`).join(' / ') : '2명 이상 접속하면 자동 시작해요';
  const lobbyDetail = champion ? '토너먼트 종료' : room.stage === 'finished' ? room.result.map(r => r.handName).join(' / ') + (room.nextHandAt ? ' — 다음 핸드가 자동으로 시작돼요.' : ' — 참가자가 모이면 자동으로 시작돼요.') : '준비 버튼 없이 온라인 참가자가 모이면 바로 진행합니다.';
  const tournamentReentry = tournament && me?.chips === 0 && !champion
    ? me.entries > room.tournament.maxReentries ? '<p class="form-note">리엔트리 횟수 2회를 모두 사용했습니다.</p>'
      : room.tournament.registrationOpen ? `<label class="tournament-entry-select">리엔트리 방식<select data-tournament-entry-method><option value="money" ${account?.money < 10000 ? 'disabled' : ''}>개인 머니 10,000 사용</option><option value="count" ${account?.money >= 10000 ? 'disabled' : ''}>바이인 횟수 +1</option></select></label><button class="primary" data-send="rebuy" ${disabled}>리엔트리 · 10,000칩</button>`
      : '<p class="form-note">시작 스택이 5BB 미만이라 리엔트리가 마감됐습니다.</p>' : '';
  const lobbyActions = `${ring && me?.chips <= 5000 ? `<button class="primary" data-send="rebuy" ${disabled}>추가 바이인 · 10,000칩으로 재설정</button>` : ''}${tournamentReentry}`;
  const currentBetSizes = betSizes[room.format.mode][room.stage === 'preflop' ? 'preflop' : 'postflop'];
  app.innerHTML = `<section class="table-heading"><div><div class="eyebrow"><span class="connection ${connected ? '' : 'disconnected'}">${connected ? '실시간 연결됨' : '다시 연결하는 중…'}</span></div><h1>${escape(room.name)}</h1></div><div class="table-tools"><button class="outline" id="invite-button" aria-haspopup="dialog">친구 초대 <span>↗</span></button>${tournament ? '' : `<button class="quiet" data-send="leave" ${!idle ? 'disabled' : disabled} title="핸드가 끝난 뒤 나갈 수 있어요">나가기</button>`}</div></section>
    <div class="game-layout"><section class="play-area"><div class="table-meta"><span>블라인드 <b>${tableAmount(room.smallBlind)} / ${tableAmount(room.bigBlind)}</b></span>${tournament ? `<span>${tournamentLevelLabel} · 앤티 <b>${tableAmount(room.ante)}</b> · ${room.format.tournamentSpeed === 'turbo' ? '터보' : '기본'}</span><span id="tournament-countdown" role="timer" aria-live="off"></span>` : ''}<span>핸드 <b>${String(room.hand).padStart(2, '0')}</b></span><button type="button" class="unit-toggle" id="unit-toggle" aria-pressed="${displayUnit === 'bb'}" aria-label="표시 단위를 변경합니다. 현재 ${displayUnit === 'bb' ? 'BB' : '칩'}">단위: ${displayUnit === 'bb' ? 'BB' : '칩'} ⇄</button><button type="button" class="bet-settings-button" id="bet-settings-button">사이즈 설정</button></div>
      <div class="poker-surface"><div class="felt"><div class="felt-border"></div><span class="felt-wordmark">RIVER</span></div>
        <div class="board-area"><div class="round-label">${stages[room.stage]}</div>${idle && room.stage === 'waiting' ? '<div class="waiting-title">자리가 준비됐어요.</div><p class="waiting-description">2명 이상 접속하면<br>첫 핸드가 자동으로 시작돼요.</p>' : `<div class="pot-label">TOTAL POT <strong title="${format(room.pot)}칩">${tableAmount(room.pot)}</strong></div><div class="board-cards">${Array.from({ length: 5 }, (_, i) => card(room.board[i], animFrom && i >= animFrom.board.length ? `reveal reveal-${i - animFrom.board.length}` : '')).join('')}</div>`}</div>
        ${ordered.map((player, i) => seat(player, i, ordered.length)).join('')}
      </div>
      <section class="action-panel" aria-label="게임 행동">${idle ? `<div class="turn-info"><span class="turn-dot"></span><div><b>${lobbyTitle}</b><span>${lobbyDetail}</span></div><span class="timer" id="next-hand-countdown" role="timer" aria-live="off"></span></div><div class="lobby-actions">${lobbyActions}</div>` : `<div class="turn-info"><span class="turn-dot ${legal ? 'your-turn' : ''}"></span><div><b>${legal ? '내 차례예요.' : `${escape(room.players[room.turn]?.name || '')} 님의 차례`}</b><span>${legal ? '어떤 플레이를 할까요?' : '다음 수를 생각해 보세요.'}</span></div><span class="timer" id="countdown"></span></div>${!legal && canQueue ? queuePanel(me) : `<div class="betting-actions"><button class="fold-button" data-action="fold" ${legal ? disabled : 'disabled'}>폴드</button><button class="primary" data-action="${legal?.canCheck ? 'check' : 'call'}" ${legal ? disabled : 'disabled'}>${!legal ? '콜' : legal.canCheck ? '체크' : `콜 ${tableAmount(legal.toCall)}`}</button><div class="raise-control"><label for="raise-amount">총 베팅액 (칩)</label><div class="raise-entry"><input id="raise-amount" type="number" inputmode="numeric" aria-describedby="raise-preview raise-help" required min="${legal?.min || 0}" max="${legal?.max || 0}" step="1" value="${legal?.min || 0}" ${legal?.canRaise ? disabled : 'disabled'}><button type="button" class="outline" id="bet-calculator-open" aria-label="숫자 계산기로 베팅 금액 입력" ${legal?.canRaise ? disabled : 'disabled'}>계산기</button></div></div><button class="primary gold" id="raise-button" ${legal?.canRaise ? disabled : 'disabled'}>레이즈 ↑</button></div>${legal?.canRaise ? `<div class="raise-range"><label for="raise-range">레이즈 범위 <output id="raise-range-value">${tableAmount(legal.min)}</output></label><input id="raise-range" type="range" aria-describedby="raise-preview raise-help" min="${legal.min}" max="${legal.max}" step="1" value="${legal.min}" ${disabled}><div class="raise-limits"><span>최소 ${tableAmount(legal.min)}</span><span>올인 ${tableAmount(legal.max)}</span></div></div><div class="bet-sizing-heading"><b>${room.stage === 'preflop' ? '프리플롭' : '플랍 이후'} 빠른 사이즈</b><span>설정에서 직접 편집</span></div><section class="quick-bets" aria-label="베팅 금액 빠른 선택">${raisePresets(room, legal, currentBetSizes).map((preset, index) => `<button type="button" id="bet-preset-${index}" data-bet="${preset.amount}" ${disabled} title="이번 라운드 총액 ${format(preset.amount)}칩">${preset.label} <b>${tableAmount(preset.amount)}</b></button>`).join('')}<button type="button" class="all-in-bet" data-bet="${legal.max}" ${disabled} title="올인 ${format(legal.max)}칩">올인 <b>${tableAmount(legal.max)}</b></button></section><output id="raise-preview" class="raise-preview" for="raise-amount" aria-live="polite"></output><p id="raise-help" class="raise-help">슬라이더는 드래그로 1칩씩, 휠로 1BB씩 조절해요. 프리셋은 BB 또는 팟 비율로 계산하고, 계산기는 칩 단위로 입력해요.</p>` : ''}`}`}</section>
      <p class="table-footnote">${tournament ? `9-max 토너먼트 · 시작 칩 10,000 · 리엔트리 최대 2회 · ${room.format.tournamentSpeed === 'turbo' ? '레벨 3분' : '레벨 6분'} · 앤티 포함` : '핸드 종료 후 남은 개인 머니를 10,000칩까지 자동 보충 · 5,000칩 이하에서 추가 바이인 가능'} / 블라인드 ${tableAmount(room.smallBlind)} / ${tableAmount(room.bigBlind)} / 행동 시간 ${room.format.turnTimeoutMs / 1000}초 / 결제 및 환전 없음</p>
    </section><aside class="sidebar"><div class="side-tabs" role="tablist" aria-label="테이블 정보"><button role="tab" id="tab-history" aria-controls="side-content" tabindex="${panel === 'history' ? 0 : -1}" aria-selected="${panel === 'history'}" data-panel="history">핸드 기록</button><button role="tab" id="tab-log" aria-controls="side-content" tabindex="${panel === 'log' ? 0 : -1}" aria-selected="${panel === 'log'}" data-panel="log">진행 로그</button></div><div id="side-content" role="tabpanel" tabindex="0" aria-labelledby="tab-${panel}">${sideContent()}</div></aside></div>`;
  // The CSP forbids inline style attributes, so seat coordinates are applied through the CSSOM.
  document.querySelectorAll('[data-seat-pos]').forEach(el => {
    const [index, count] = el.dataset.seatPos.split(',').map(Number);
    for (const [name, value] of Object.entries(seatPosition(index, count))) el.style.setProperty(name, value);
  });
  document.querySelectorAll('[data-queue]').forEach(button => {
    button.onclick = () => send('queue', { queue: room.queued?.type === button.dataset.queue ? null : { type: button.dataset.queue } });
  });
  $('#invite-button').onclick = () => {
    $('#invite-link').value = `${location.origin}/?room=${room.id}`;
    $('#invite-feedback').textContent = '';
    $('#share-invite').hidden = !navigator.share;
    $('#invite').showModal();
  };
  $('#unit-toggle').onclick = () => {
    displayUnit = displayUnit === 'chips' ? 'bb' : 'chips';
    saveLocal('river-chip-unit', displayUnit);
    render();
  };
  $('#bet-settings-button').onclick = openBetSettings;
  $('#bet-calculator-open')?.addEventListener('click', openBetCalculator);
  document.querySelectorAll('[data-send]').forEach(button => { button.onclick = () => {
    const entryMethod = room.format.mode === 'tournament' && button.dataset.send === 'rebuy' ? $('[data-tournament-entry-method]')?.value || 'money' : null;
    send(button.dataset.send, entryMethod ? { entryMethod } : {});
  }; });
  document.querySelectorAll('[data-action]').forEach(button => { button.onclick = () => { if (confirmAction(button.dataset.action)) send('action', { action: button.dataset.action }); }; });
  document.querySelectorAll('[data-panel]').forEach(button => {
    button.onclick = () => { panel = button.dataset.panel; render(); };
    button.onkeydown = event => {
      const keys = ['history', 'log'];
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = keys.indexOf(panel);
      panel = event.key === 'Home' ? keys[0] : event.key === 'End' ? keys.at(-1) : keys[(index + (event.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length];
      render(); $(`#tab-${panel}`).focus({ preventScroll: true });
    };
  });
  if (legal?.canRaise) {
    const input = $('#raise-amount'), preview = $('#raise-preview');
    const range = $('#raise-range'), rangeValue = $('#raise-range-value');
    if (previousAmount !== null) input.value = previousAmount;
    const updatePreview = () => {
      const result = raisePreview(input.value, me, legal, room.bigBlind);
      input.setAttribute('aria-invalid', String(!result));
      preview.classList.toggle('invalid', !result);
      if (!result) preview.textContent = `${format(legal.min)}~${format(legal.max)} 사이의 정수 칩을 입력해 주세요.`;
      else {
        range.value = input.value;
        rangeValue.textContent = tableAmount(input.value);
        preview.innerHTML = `<span>추가 투입 <b>${tableAmount(result.additional)}</b></span><span>남은 스택 <b>${tableAmount(result.remaining)}</b></span><span>총액 <b>${result.bigBlinds.toLocaleString('ko-KR', { maximumFractionDigits: 2 })} BB</b></span>`;
      }
      return result;
    };
    input.oninput = updatePreview;
    range.oninput = () => { input.value = range.value; updatePreview(); };
    range.onwheel = event => {
      if (!connected || pending || range.disabled) return;
      event.preventDefault();
      range.value = String(Math.max(legal.min, Math.min(legal.max, Number(range.value) + (event.deltaY < 0 ? 1 : -1) * room.bigBlind)));
      input.value = range.value;
      updatePreview();
    };
    document.querySelectorAll('[data-bet]').forEach(button => {
      button.onclick = () => {
        if (!connected || pending || input.disabled) return;
        input.value = button.dataset.bet;
        updatePreview();
      };
    });
    $('#raise-button').onclick = () => {
      if (!connected || pending || input.disabled) return;
      const valid = updatePreview();
      if (input.reportValidity() && valid && confirmAction('raise', Number(input.value))) send('action', { action: 'raise', amount: Number(input.value) });
    };
    input.onkeydown = event => {
      if (event.isComposing || !connected || pending || input.disabled) return;
      if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat) $('#raise-button').click(); }
      if (event.key === 'Escape') { event.preventDefault(); input.value = legal.min; updatePreview(); }
    };
    updatePreview();
  }
  if (focusKey) $(focusKey)?.focus({ preventScroll: true });
  const announcement = !connected ? '서버에 다시 연결하는 중입니다.' : legal ? '내 차례입니다.' : idle ? stages[room.stage] : `${room.players[room.turn]?.name || ''} 님의 차례입니다.`;
  if ($('#turn-announcement').textContent !== announcement) $('#turn-announcement').textContent = announcement;
  countdown();
}
function historyEntry(h) {
  const summary = `<summary><span class="history-title"><b>HAND #${h.hand}</b><time>${new Date(h.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</time></span><div class="mini-board">${h.board.map(c => card(c)).join('')}</div>${h.result.map(r => `<p>${escape(r.name)} <strong>+${format(r.amount)}</strong><small>${escape(r.handName)}</small></p>`).join('')}</summary>`;
  // Hands saved before detailed history only have the result summary.
  if (!h.players) return `<article class="history-entry">${summary.replace(/<\/?summary>/g, '')}</article>`;
  const signed = value => `${value > 0 ? '+' : ''}${format(value)}`;
  const players = h.players.map(p => `<tr><th scope="row">${escape(p.name)}${p.id === room.me ? ' <small>나</small>' : ''}${p.folded ? ' <small>폴드</small>' : ''}<span class="history-cards">${p.cards ? p.cards.map(c => card(c)).join('') : ''}</span></th><td>${format(p.contributed)}${p.refund ? `<small>환급 ${format(p.refund)}</small>` : ''}</td><td>${format(p.end)}<small class="${p.end - p.start < 0 ? 'negative' : 'positive'}">${signed(p.end - p.start)}</small></td></tr>`).join('');
  const rounds = ['preflop', 'flop', 'turn', 'river'].map(stage => [stage, h.actions.filter(a => a.stage === stage)]).filter(([, list]) => list.length);
  return `<details class="history-entry" data-hand="${h.hand}" ${openHands.has(String(h.hand)) ? 'open' : ''}>${summary}
    <table class="history-players"><thead><tr><th scope="col">참가자</th><th scope="col">투입</th><th scope="col">종료 칩</th></tr></thead><tbody>${players}</tbody></table>
    <ol class="history-actions">${rounds.map(([stage, list]) => `<li><b>${stages[stage]}</b>${list.map(a => `<span>${escape(a.name)} ${escape(a.text)}</span>`).join('')}</li>`).join('')}</ol>
    <p class="history-privacy">공개되지 않은 상대의 패는 표시하지 않아요.</p>
  </details>`;
}
function sideContent() {
  if (panel === 'log') return `<div class="section-caption">지금까지의 플레이</div><ol class="game-log">${room.log.map(item => `<li>${escape(item)}</li>`).join('')}</ol>`;
  return `<div class="section-caption">최근 50개 핸드</div>${room.history.length ? room.history.map(historyEntry).join('') : '<div class="empty-state"><span>↺</span><b>첫 핸드를 기다리고 있어요</b><p>완료된 핸드의 결과가 여기에 남아요.</p></div>'}`;
}
function countdown() {
  const now = Date.now();
  const action = $('#countdown');
  if (action && room?.deadline) action.textContent = `${Math.max(0, Math.ceil((room.deadline - now) / 1000))}초`;
  const nextHand = $('#next-hand-countdown');
  if (nextHand) nextHand.textContent = room?.nextHandAt ? `${Math.max(0, Math.ceil((room.nextHandAt - now) / 1000))}초` : '';
  const level = $('#tournament-countdown');
  if (level && room?.tournament) {
    const seconds = Math.max(0, Math.ceil(((room.tournament.nextLevelAt || now) - now) / 1000));
    level.textContent = room.tournament.winnerId ? '토너먼트 종료' : room.tournament.startedAt == null ? '첫 핸드부터 시작' : room.tournament.nextLevelAt ? `레벨업 ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : '마지막 레벨';
  }
}
setInterval(countdown, 1000);
setInterval(checkConnection, 25000);
document.addEventListener('visibilitychange', checkConnection);
window.addEventListener('online', checkConnection);
window.addEventListener('offline', () => { if (room) { connected = false; pending = false; render(); } });
$('#close-invite').onclick = () => $('#invite').close();
$('#copy-invite').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('#invite-link').value);
    $('#invite-feedback').textContent = '링크를 복사했어요. 친구에게 보내주세요.';
  } catch {
    $('#invite-link').focus(); $('#invite-link').select();
    $('#invite-feedback').textContent = '자동 복사를 사용할 수 없어요. 선택된 링크를 길게 누르거나 복사 단축키로 복사해 주세요.';
  }
};
$('#share-invite').onclick = async () => {
  try { await navigator.share({ title: `${room.name} | RIVER`, text: '가상 칩으로 함께하는 친구들의 홀덤', url: $('#invite-link').value }); }
  catch (error) { if (error.name !== 'AbortError') $('#invite-feedback').textContent = '공유 메뉴를 열지 못했어요. 링크 복사를 이용해 주세요.'; }
};
$('#invite').addEventListener('close', () => $('#invite-button')?.focus({ preventScroll: true }));
$('#close-bet-settings').onclick = () => $('#bet-settings').close();
$('#add-postflop-size').onclick = () => {
  const sizes = readSizeRows($('#postflop-size-list'));
  if (sizes.length >= 6) return;
  sizes.push({ unit: 'pot', value: sizes.length === 4 ? 125 : 150 });
  renderBetSizeRows($('#postflop-size-list'), sizes, 'postflop');
  $('#add-postflop-size').disabled = sizes.length >= 6;
};
$('#bet-settings-form').onsubmit = event => {
  event.preventDefault();
  const preflop = readSizeRows($('#preflop-size-list'));
  const postflop = readSizeRows($('#postflop-size-list'));
  if (!event.currentTarget.reportValidity() || preflop.length !== 4 || postflop.length < 4 || postflop.length > 6 || ![...preflop, ...postflop].every(validSize)) return;
  betSizes[room.format.mode] = { preflop, postflop };
  saveLocal('river-bet-sizes', JSON.stringify(betSizes));
  $('#bet-settings').close();
  render();
  $('#bet-settings-button')?.focus({ preventScroll: true });
};
$('#close-bet-calculator').onclick = $('#cancel-bet-calculator').onclick = () => $('#bet-calculator').close();
document.querySelectorAll('[data-calculator-key]').forEach(button => {
  button.onclick = () => {
    calculatorKey(button.dataset.calculatorKey);
    const legal = room?.legal, me = room?.players.find(player => player.id === room.me);
    const valid = legal?.canRaise && raisePreview(calculatorValue, me, legal, room.bigBlind);
    $('#bet-calculator-help').textContent = valid
      ? `${format(legal.min)}~${format(legal.max)}칩 · 000 버튼으로 천 단위 입력`
      : `${format(legal?.min)}~${format(legal?.max)} 사이의 정수 칩을 입력해 주세요.`;
  };
});
$('#apply-bet-calculator').onclick = () => {
  const input = $('#raise-amount'), me = room?.players.find(player => player.id === room.me);
  if (!input || !room?.legal?.canRaise || !raisePreview(calculatorValue, me, room.legal, room.bigBlind)) {
    $('#bet-calculator-help').textContent = `${format(room?.legal?.min)}~${format(room?.legal?.max)} 사이의 정수 칩을 입력해 주세요.`;
    return;
  }
  input.value = calculatorValue;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  $('#bet-calculator').close();
  input.focus({ preventScroll: true });
};
(async () => {
  try { await api('/api/session'); } catch { /* The account form remains available if session setup is temporarily unavailable. */ }
  try { account = (await api('/api/auth/me', undefined, 'GET')).account; } catch { account = null; }
  renderAuthHeader();
  home();
  if (account && code) await resumeRoom();
})();
