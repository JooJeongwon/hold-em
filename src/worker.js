import { DurableObject } from 'cloudflare:workers';
import { act, legalActions, setQueued, startHand } from './game/holdem.js';
import { normalizeGameFormat, RING_GAME_FORMAT, TOURNAMENT_LEVELS, TOURNAMENT_MAX_REENTRIES } from './game/format.js';
import { addPlayer, advanceTournamentLevel, claimHost, clearOfflineReady, createRoom, leavePlayer, rebuyPlayer, recordTournamentEntry, refillRingStack, ringBuyInWeek, toggleReady, tournamentRegistrationOpen } from './game/room.js';
import { migrateRoom } from './game/migrations.js';
import { publicRoom } from './game/view.js';
import { hashPassword, verifyPassword } from './platform/password.js';
import { shuffledDeck } from './platform/random.js';

const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const cleanName = (value, fallback) => typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 20) || fallback : fallback;
const AUTH_SESSION_MS = 400 * 24 * 60 * 60 * 1000;
const INITIAL_PERSONAL_MONEY = 10000;
const RING_REBUY_THRESHOLD = 5000;
const AUTO_HAND_DELAY_MS = 3000;
const RING_ROOM_ID = 'ring-sixmax';
const RING_BUY_INS_KEY = 'ring-buy-ins';
const DUMMY_PASSWORD_SALT = '00'.repeat(16);
const DUMMY_PASSWORD_HASH = 'pbkdf2-sha256-chain-310k-v1$' + '00'.repeat(32);
const publicAccount = account => ({ username: account.username, displayName: account.displayName || account.username, money: account.money, createdAt: account.createdAt });
const nextAlarmAt = room => [room.deadline, room.nextHandAt, room.tournament?.nextLevelAt].filter(Number.isSafeInteger).sort((a, b) => a - b)[0] || null;
const sessionToken = request => request.headers.get('Cookie')?.match(/(?:^|;\s*)river_session=([a-f0-9-]{36})(?:;|$)/)?.[1] || null;
async function sessionHash(token) {
  if (!token) return null;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const sessionCookie = (token, secure) => `river_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=34560000${secure ? '; Secure' : ''}`;
const clearedSessionCookie = secure => `river_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
async function body(request) {
  const text = await request.text();
  if (text.length > 32768) throw new Error('요청이 너무 큽니다.');
  return JSON.parse(text);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: '허용되지 않은 요청입니다.' }, 403);
    if (request.method !== 'GET' && request.headers.get('Content-Type') !== 'application/json') return json({ error: 'JSON 요청이 필요합니다.' }, 415);
    try {
      if (url.pathname === '/api/session' && request.method === 'POST') {
        const existing = sessionToken(request);
        const token = existing || crypto.randomUUID();
        if (existing) {
          const hash = await sessionHash(existing);
          await env.ROOMS.getByName('river-members').fetch(new Request('https://room/auth/refresh', { headers: { 'x-session-hash': hash } }));
        }
        return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, url.protocol === 'https:') });
      }
      if (url.pathname === '/api/ring/lobby' && request.method === 'GET') {
        return env.ROOMS.getByName('river-members').fetch(new Request('https://room/ring/lobby'));
      }
      const token = sessionToken(request);
      const hash = await sessionHash(token);
      const memberRegistry = env.ROOMS.getByName('river-members');
      if (url.pathname.startsWith('/api/auth/')) {
        if (!hash) return json({ error: '먼저 브라우저 세션을 준비해 주세요.' }, 401);
        const action = url.pathname.slice('/api/auth/'.length);
        if (!['register', 'login', 'me', 'logout'].includes(action)) return json({ error: '없는 경로입니다.' }, 404);
        if (['register', 'login', 'logout'].includes(action) && request.method !== 'POST') return json({ error: 'POST 요청이 필요합니다.' }, 405);
        if (action === 'me' && request.method !== 'GET') return json({ error: 'GET 요청이 필요합니다.' }, 405);
        const rotatedToken = ['register', 'login'].includes(action) ? crypto.randomUUID() : null;
        const targetHash = rotatedToken ? await sessionHash(rotatedToken) : hash;
        const headers = new Headers({ 'x-session-hash': targetHash, 'x-previous-session-hash': hash, 'x-player-id': hash });
        if (['register', 'login'].includes(action)) headers.set('x-client-ip', request.headers.get('CF-Connecting-IP') || 'local');
        if (['register', 'login'].includes(action)) headers.set('Content-Type', 'application/json');
        const response = await memberRegistry.fetch(new Request(`https://room/auth/${action}`, {
          method: request.method, headers,
          body: ['register', 'login'].includes(action) ? JSON.stringify(await body(request)) : undefined,
        }));
        if (['register', 'login'].includes(action) && response.ok) {
          const responseHeaders = new Headers(response.headers);
          responseHeaders.set('Set-Cookie', sessionCookie(rotatedToken, url.protocol === 'https:'));
          return new Response(response.body, { status: response.status, headers: responseHeaders });
        }
        if (action !== 'logout') return response;
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set('Set-Cookie', clearedSessionCookie(url.protocol === 'https:'));
        return new Response(response.body, { status: response.status, headers: responseHeaders });
      }
      if (!hash) return json({ error: '로그인해 주세요.' }, 401);
      const resolved = await memberRegistry.fetch(new Request('https://room/auth/resolve', { headers: { 'x-session-hash': hash } }));
      if (!resolved.ok) return json({ error: '로그인해 주세요.' }, 401);
      const account = await resolved.json();
      const id = account.playerId;
      if (url.pathname === '/api/tournaments/current') {
        if (request.method !== 'GET') return json({ error: 'GET 요청이 필요합니다.' }, 405);
        return memberRegistry.fetch(new Request('https://room/tournaments/current', { headers: { 'x-player-id': id } }));
      }
      if (url.pathname === '/api/ring/join' || url.pathname === '/api/ring/topup' || url.pathname === '/api/ring/socket') {
        const headers = new Headers(request.headers);
        headers.set('x-player-id', id);
        headers.set('x-account-id', account.accountId);
        if (url.pathname === '/api/ring/socket') {
          if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket 연결이 필요합니다.' }, 426);
          return memberRegistry.fetch(new Request('https://room/ring/socket', { method: 'GET', headers }));
        }
        if (request.method !== 'POST') return json({ error: 'POST 요청이 필요합니다.' }, 405);
        return memberRegistry.fetch(new Request(`https://room${url.pathname.slice('/api'.length)}`, {
          method: 'POST', headers, body: url.pathname.endsWith('/join') ? JSON.stringify(await body(request)) : undefined,
        }));
      }
      if (url.pathname === '/api/rooms' && request.method === 'POST') {
        const data = await body(request);
        const format = normalizeGameFormat(data.format);
        if (format.mode !== 'tournament') return json({ error: '링게임은 고정된 공용 테이블로 입장해 주세요.' }, 400);
        const code = /^[a-f0-9]{16}$/.test(data.id || '') ? data.id : crypto.randomUUID().replaceAll('-', '').slice(0, 16);
        return env.ROOMS.getByName(code).fetch(new Request('https://room/init', {
          method: 'POST', headers: { 'x-player-id': id, 'x-account-id': account.accountId },
          body: JSON.stringify({ id: code, name: cleanName(data.roomName, `${new Date(Date.now() + 9 * 3600000).toISOString().slice(5, 10).split('-').map(Number).join('월 ')}일 토너먼트`), nickname: cleanName(data.nickname, '플레이어'), entryMethod: data.entryMethod, format }),
        }));
      }
      const match = url.pathname.match(/^\/api\/rooms\/([a-f0-9]{16})\/(join|socket|info)$/);
      if (!match) return json({ error: '없는 경로입니다.' }, 404);
      if (match[2] === 'socket' && (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')) return json({ error: 'WebSocket 연결이 필요합니다.' }, 426);
      if (match[2] === 'join' && request.method !== 'POST') return json({ error: 'POST 요청이 필요합니다.' }, 405);
      if (match[2] === 'info' && request.method !== 'GET') return json({ error: 'GET 요청이 필요합니다.' }, 405);
      const headers = new Headers(request.headers);
      headers.set('x-player-id', id);
      headers.set('x-account-id', account.accountId);
      return env.ROOMS.getByName(match[1]).fetch(new Request(`https://room/${match[2]}`, { method: request.method, headers, body: request.method === 'POST' ? JSON.stringify(await body(request)) : undefined }));
    } catch {
      return json({ error: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' }, 400);
    }
  },
};

export class PokerRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      const savedRoom = await ctx.storage.get('room');
      const savedRing = savedRoom ? null : await ctx.storage.get('ring-room');
      const saved = savedRoom || savedRing;
      this.roomKey = savedRoom ? 'room' : savedRing ? 'ring-room' : 'room';
      if (saved) {
        const migration = migrateRoom(saved);
        this.room = migration.room;
        if (migration.changed) await ctx.storage.put(this.roomKey, this.room);
      }
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  online() { return [...new Set(this.ctx.getWebSockets().map(ws => ws.deserializeAttachment().id))]; }
  broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(JSON.stringify({ type: 'state', room: publicRoom(this.room, ws.deserializeAttachment().id, this.online()) })); } catch { /* Closed connections are removed by the runtime. */ }
    }
  }
  scheduleAutoHand(now) {
    if (this.room?.stage === 'finished' && !this.room.tournament?.winnerId) this.room = { ...this.room, nextHandAt: now + AUTO_HAND_DELAY_MS };
  }
  startAutoHand(now) {
    if (!this.room || !['waiting', 'finished'].includes(this.room.stage) || this.room.tournament?.winnerId || this.room.nextHandAt > now) return false;
    const online = new Set(this.online());
    const eligible = this.room.players.filter(player => online.has(player.id) && player.chips > 0);
    const changed = this.room.nextHandAt != null;
    if (changed) this.room = { ...this.room, nextHandAt: null };
    if (eligible.length < 2) return changed;
    const nextRoom = {
      ...this.room,
      players: this.room.players.map(player => ({ ...player, ready: online.has(player.id) && player.chips > 0 })),
    };
    this.room = startHand(nextRoom, nextRoom.hostId, shuffledDeck(() => crypto.getRandomValues(new Uint32Array(1))[0]), now);
    return true;
  }
  async ringBuyInLedger() {
    const week = ringBuyInWeek();
    const saved = await this.ctx.storage.get(RING_BUY_INS_KEY);
    return saved?.week === week && saved.records ? saved : { week, records: {} };
  }
  async recordRingBuyIn(id, name) {
    const ledger = await this.ringBuyInLedger();
    const record = ledger.records[id] || { id, name, weeklyBuyIns: 0 };
    record.name = name;
    record.weeklyBuyIns = (Number.isSafeInteger(record.weeklyBuyIns) ? record.weeklyBuyIns : 0) + 1;
    ledger.records[id] = record;
    return ledger;
  }
  async save(bump = true, authData = null, storageEntries = []) {
    if (bump) this.room = { ...this.room, revision: this.room.revision + 1 };
    const alarmAt = nextAlarmAt(this.room);
    if (alarmAt) {
      const previousAlarm = await this.ctx.storage.getAlarm();
      await this.ctx.storage.setAlarm(previousAlarm == null ? alarmAt : Math.min(previousAlarm, alarmAt));
    }
    const roomKey = this.roomKey || 'room';
    const persistRoom = () => storageEntries.length
      ? this.ctx.storage.transaction(async transaction => {
        await transaction.put(roomKey, this.room);
        for (const [key, value] of storageEntries) await transaction.put(key, value);
      })
      : this.ctx.storage.put(roomKey, this.room);
    if (!authData) return persistRoom();
    const previousAuthData = await this.readState('auth-data', { accounts: {}, usernames: {}, sessions: {}, failures: {} });
    await this.writeStates([['auth-data', authData]]);
    try {
      await persistRoom();
    } catch (error) {
      try { await this.writeStates([['auth-data', previousAuthData]]); }
      catch { throw new Error('테이블 저장에 실패해 머니 복구를 확인할 수 없습니다. 지원을 요청해 주세요.'); }
      throw error;
    }
  }
  // shortcut: one central Durable Object serializes this JSON row; normalize it before adding parallel account writers.
  async readState(key, fallback) {
    const row = await this.env.DB.prepare('SELECT value FROM app_state WHERE key = ?').bind(key).first();
    if (row) return JSON.parse(row.value);
    const legacy = await this.ctx.storage.get(key);
    const value = legacy === undefined ? structuredClone(fallback) : legacy;
    if (legacy !== undefined) await this.writeStates([[key, value]]);
    return value;
  }
  async writeStates(entries) {
    await this.env.DB.batch(entries.map(([key, value]) => this.env.DB.prepare(
      'INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).bind(key, JSON.stringify(value), Date.now())));
  }
  async chargeTournamentEntry(roomId, playerId, accountId, entry, method) {
    const reference = `${roomId}:${playerId}:${entry}`;
    let response, result;
    try {
      response = await this.env.ROOMS.getByName('river-members').fetch(new Request('https://room/tournament/charge', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-player-id': playerId, 'x-account-id': accountId },
        body: JSON.stringify({ reference, method }),
      }));
      result = await response.json();
    } catch (error) {
      try { await this.refundTournamentEntry(playerId, accountId, reference); }
      catch { throw new Error('토너먼트 바이인을 처리하지 못했고 머니 복구도 확인되지 않았습니다. 지원을 요청해 주세요.'); }
      throw error;
    }
    if (!response.ok) throw new Error(result.error || '토너먼트 바이인을 처리하지 못했습니다.');
    return { reference, account: { ...result.account, id: accountId } };
  }
  async refundTournamentEntry(playerId, accountId, reference) {
    const response = await this.env.ROOMS.getByName('river-members').fetch(new Request('https://room/tournament/refund', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-player-id': playerId, 'x-account-id': accountId },
      body: JSON.stringify({ reference }),
    }));
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '토너먼트 바이인을 복구하지 못했습니다.');
    return { ...result.account, id: accountId };
  }
  async autoRefillRingLosers() {
    if (this.room?.format.mode !== 'ring' || this.room.stage !== 'finished') return null;
    const hand = this.room.history[0];
    if (!hand?.players) return null;
    const authData = await this.readState('auth-data', { accounts: {} });
    const accounts = new Map(Object.values(authData.accounts).map(account => [account.playerId, account]));
    const updatedAccounts = [];
    for (const outcome of hand.players) {
      if (!Number.isSafeInteger(outcome.start) || !Number.isSafeInteger(outcome.end) || outcome.end >= outcome.start) continue;
      const player = this.room.players.find(entry => entry.id === outcome.id);
      const account = accounts.get(outcome.id);
      if (!player || !account || player.chips >= this.room.format.buyIn || !Number.isSafeInteger(account.money) || account.money <= 0) continue;
      const amount = Math.min(this.room.format.buyIn - player.chips, account.money);
      if (amount <= 0) continue;
      this.room = refillRingStack(this.room, player.id, amount);
      account.money -= amount;
      updatedAccounts.push(account);
    }
    return updatedAccounts.length ? { authData, updatedAccounts } : null;
  }
  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const path = new URL(request.url).pathname;
      const id = request.headers.get('x-player-id');
      try {
        if (path === '/ring/lobby') {
          if (request.method !== 'GET') return json({ error: 'GET 요청이 필요합니다.' }, 405);
          const room = this.room?.id === RING_ROOM_ID && this.room.format.mode === 'ring' ? this.room : null;
          const seated = new Set(room?.players.map(player => player.id) || []);
          const ledger = await this.ringBuyInLedger();
          const players = Object.values(ledger.records).filter(record => Number.isSafeInteger(record.weeklyBuyIns) && record.weeklyBuyIns > 0).map(record => ({
            name: record.name, weeklyBuyIns: record.weeklyBuyIns, seated: seated.has(record.id),
          })).sort((a, b) => b.weeklyBuyIns - a.weeklyBuyIns || Number(b.seated) - Number(a.seated) || a.name.localeCompare(b.name, 'ko'));
          return json({ players });
        }
        if (path.startsWith('/auth/')) {
          const action = path.slice('/auth/'.length);
          const sessionHash = request.headers.get('x-session-hash');
          const previousHash = request.headers.get('x-previous-session-hash');
          if (!/^[a-f0-9]{64}$/.test(sessionHash || '')) return json({ error: '로그인 정보를 확인해 주세요.' }, 401);
          const auth = await this.readState('auth-data', { accounts: {}, usernames: {}, sessions: {}, failures: {} });
          const migrateEconomy = () => {
            if (auth.economyVersion === 1) return false;
            for (const account of Object.values(auth.accounts)) {
              if (!Number.isSafeInteger(account.money)) account.money = INITIAL_PERSONAL_MONEY;
              else if (account.money === 100000) account.money = INITIAL_PERSONAL_MONEY;
            }
            auth.economyVersion = 1;
            return true;
          };
          const now = Date.now();
          const validSession = renew => {
            const session = auth.sessions[sessionHash];
            const account = session && auth.accounts[session.accountId];
            if (!session) return null;
            if (!account || session.expiresAt <= now) { delete auth.sessions[sessionHash]; return null; }
            if (renew) session.expiresAt = now + AUTH_SESSION_MS;
            return account;
          };
          if (action === 'refresh') {
            if (validSession(true)) migrateEconomy();
            await this.writeStates([['auth-data', auth]]);
            return json({ ok: true });
          }
          if (action === 'resolve' || action === 'me') {
            const account = validSession(false);
            if (!account) return json({ error: '로그인해 주세요.' }, 401);
            if (migrateEconomy()) await this.writeStates([['auth-data', auth]]);
            return json(action === 'me' ? { account: publicAccount(account) } : {
              accountId: account.id, playerId: account.playerId, username: account.username, money: account.money,
            });
          }
          if (action === 'logout') {
            delete auth.sessions[sessionHash];
            await this.writeStates([['auth-data', auth]]);
            return json({ ok: true });
          }
          if (action === 'register') {
            const data = await request.json();
            const username = typeof data.username === 'string' ? data.username.trim() : '';
            const displayName = cleanName(data.displayName, '');
            const normalized = username.toLowerCase();
            const password = data.password;
            const playerId = request.headers.get('x-player-id');
            const ip = request.headers.get('x-client-ip') || 'local';
            if (username.length < 4 || typeof password !== 'string' || password.length < 4) return json({ error: '아이디와 비밀번호를 각각 4자 이상 입력해 주세요.' }, 400);
            if (!displayName) return json({ error: '가입할 이름을 입력해 주세요.' }, 400);
            if (['__proto__', 'constructor', 'prototype'].includes(normalized)) return json({ error: '사용할 수 없는 아이디입니다.' }, 400);
            if (!/^[a-f0-9]{64}$/.test(playerId || '')) return json({ error: '브라우저 세션을 확인해 주세요.' }, 401);
            if (auth.sessions[previousHash]) return json({ error: '이미 로그인되어 있습니다.' }, 409);
            if (Object.hasOwn(auth.usernames, normalized)) return json({ error: '이미 사용 중인 아이디입니다.' }, 409);
            if (Object.keys(auth.accounts).length >= 1000) return json({ error: '가입 가능한 계정 수를 초과했습니다.' }, 400);
            const signup = auth.signups?.[ip] || { count: 0, updatedAt: now };
            if (signup.until > now) return json({ error: '가입 시도가 잠겼습니다. 잠시 후 다시 시도해 주세요.' }, 429);
            if (now - signup.updatedAt > 60 * 60 * 1000) signup.count = 0;
            signup.count++;
            signup.updatedAt = now;
            if (signup.count >= 5) signup.until = now + 60 * 60 * 1000;
            auth.signups ||= {};
            auth.signups[ip] = signup;
            const passwordData = await hashPassword(password);
            const account = {
              id: crypto.randomUUID(), username, displayName, normalized, playerId,
              passwordSalt: passwordData.salt, passwordHash: passwordData.hash,
              money: INITIAL_PERSONAL_MONEY, createdAt: now,
            };
            auth.accounts[account.id] = account;
            auth.usernames[normalized] = account.id;
            migrateEconomy();
            delete auth.sessions[previousHash];
            auth.sessions[sessionHash] = { accountId: account.id, expiresAt: now + AUTH_SESSION_MS };
            await this.writeStates([['auth-data', auth]]);
            return json({ account: publicAccount(account) }, 201);
          }
          if (action === 'login') {
            const data = await request.json();
            const username = typeof data.username === 'string' ? data.username.trim().toLowerCase() : '';
            const password = typeof data.password === 'string' ? data.password : '';
            const ip = request.headers.get('x-client-ip') || 'local';
            const failure = auth.failures[ip];
            if (failure?.until > now) return json({ error: '로그인 시도가 잠겼습니다. 잠시 후 다시 시도해 주세요.' }, 429);
            const accountId = Object.hasOwn(auth.usernames, username) ? auth.usernames[username] : null;
            const account = accountId && auth.accounts[accountId];
            const valid = await verifyPassword(password, account?.passwordSalt || DUMMY_PASSWORD_SALT, account?.passwordHash || DUMMY_PASSWORD_HASH);
            if (!account || !valid) {
              const nextFailure = failure?.until > now ? failure : { count: 0, updatedAt: now };
              nextFailure.count++;
              nextFailure.updatedAt = now;
              if (nextFailure.count >= 10) nextFailure.until = now + 15 * 60 * 1000;
              auth.failures[ip] = nextFailure;
              const entries = Object.entries(auth.failures).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 2000);
              auth.failures = Object.fromEntries(entries);
              await this.writeStates([['auth-data', auth]]);
              return json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' }, 401);
            }
            migrateEconomy();
            delete auth.failures[ip];
            delete auth.sessions[previousHash];
            auth.sessions[sessionHash] = { accountId: account.id, expiresAt: now + AUTH_SESSION_MS };
            await this.writeStates([['auth-data', auth]]);
            return json({ account: publicAccount(account) });
          }
          return json({ error: '없는 경로입니다.' }, 404);
        }
        if (path === '/tournaments/current') {
          if (request.method !== 'GET') return json({ error: 'GET 요청이 필요합니다.' }, 405);
          const savedRooms = await this.readState('tournament-rooms', []);
          const indexedRooms = new Map((Array.isArray(savedRooms) ? savedRooms : [])
            .filter(room => /^[a-f0-9]{16}$/.test(room?.id || ''))
            .map(room => [room.id, room]));
          const charges = await this.readState('tournament-charges', {});
          const now = Date.now();
          for (const [reference, receipt] of Object.entries(charges)) {
            const roomId = reference.slice(0, 16);
            if (receipt.expiresAt > now && /^[a-f0-9]{16}$/.test(roomId) && !indexedRooms.has(roomId)) {
              indexedRooms.set(roomId, { id: roomId, createdAt: now });
            }
          }
          const rooms = await Promise.all([...indexedRooms.values()].map(async entry => {
            try {
              const response = await this.env.ROOMS.getByName(entry.id).fetch(new Request('https://room/info', { headers: { 'x-player-id': id } }));
              if (response.status === 404 || response.status === 410) return null;
              if (!response.ok) return { entry };
              const info = await response.json();
              return info.finished || info.format?.mode !== 'tournament' ? null : { entry, info };
            } catch { return { entry }; }
          }));
          const activeRooms = rooms.filter(Boolean);
          const keptRooms = activeRooms.map(({ entry }) => entry);
          if (JSON.stringify(savedRooms) !== JSON.stringify(keptRooms)) await this.writeStates([['tournament-rooms', keptRooms]]);
          const room = activeRooms.filter(candidate => candidate.info?.canJoin)
            .sort((a, b) => Number(b.info.seated) - Number(a.info.seated)
              || Number(b.info.startedAt !== null) - Number(a.info.startedAt !== null)
              || (a.entry.createdAt || 0) - (b.entry.createdAt || 0))[0]?.info || null;
          return json({ room });
        }
        if (path === '/tournament/charge' || path === '/tournament/refund') {
          if (request.method !== 'POST') return json({ error: 'POST 요청이 필요합니다.' }, 405);
          const accountId = request.headers.get('x-account-id');
          const auth = await this.readState('auth-data', { accounts: {} });
          const account = auth.accounts[accountId];
          if (!account || account.playerId !== id) return json({ error: '로그인 정보를 확인해 주세요.' }, 401);
          const { reference, method } = await request.json();
          if (typeof reference !== 'string' || !/^[a-f0-9]{16}:[a-f0-9]{64}:[1-3]$/.test(reference)) return json({ error: '토너먼트 참가 정보를 확인해 주세요.' }, 400);
          const charges = await this.readState('tournament-charges', {});
          const now = Date.now();
          let tournamentRooms = null;
          for (const [key, receipt] of Object.entries(charges)) if (receipt.expiresAt <= now) delete charges[key];
          if (path === '/tournament/refund') {
            const receipt = charges[reference];
            if (!receipt) return json({ account: publicAccount(account) });
            if (receipt.accountId !== account.id || receipt.playerId !== id) return json({ error: '토너먼트 참가 정보를 확인해 주세요.' }, 403);
            if (receipt.method === 'money') {
              if (!Number.isSafeInteger(account.money + INITIAL_PERSONAL_MONEY)) return json({ error: '개인 머니 복구 범위를 확인해 주세요.' }, 409);
              account.money += INITIAL_PERSONAL_MONEY;
            }
            delete charges[reference];
          } else {
            if (!['money', 'count'].includes(method)) return json({ error: '바이인 방식을 확인해 주세요.' }, 400);
            const existing = charges[reference];
            if (existing) {
              if (existing.accountId !== account.id || existing.playerId !== id || (existing.requestedMethod || existing.method) !== method) return json({ error: '이미 처리된 다른 바이인 요청입니다.' }, 409);
              return json({ account: publicAccount(account) });
            }
            const chargeMoney = method === 'money' || (Number.isSafeInteger(account.money) && account.money >= INITIAL_PERSONAL_MONEY);
            if (chargeMoney) {
              if (!Number.isSafeInteger(account.money) || account.money < INITIAL_PERSONAL_MONEY) return json({ error: '토너먼트 참가에는 개인 머니 10,000이 필요합니다.' }, 409);
              account.money -= INITIAL_PERSONAL_MONEY;
            }
            charges[reference] = { accountId: account.id, playerId: id, method: chargeMoney ? 'money' : 'count', requestedMethod: method, expiresAt: now + 24 * 60 * 60 * 1000 };
            tournamentRooms = await this.readState('tournament-rooms', []);
            const roomId = reference.slice(0, 16);
            if (!tournamentRooms.some(room => room.id === roomId)) tournamentRooms.push({ id: roomId, createdAt: now });
          }
          const updates = [['auth-data', auth], ['tournament-charges', charges]];
          if (tournamentRooms) updates.push(['tournament-rooms', tournamentRooms]);
          await this.writeStates(updates);
          return json({ account: publicAccount(account) });
        }
        if (path.startsWith('/ring/')) {
          const accountId = request.headers.get('x-account-id');
          const auth = await this.readState('auth-data', { accounts: {}, usernames: {}, sessions: {}, failures: {} });
          const account = auth.accounts[accountId];
          if (!account || account.playerId !== id) return json({ error: '로그인해 주세요.' }, 401);
          if (path === '/ring/topup') {
            if (request.method !== 'POST') return json({ error: 'POST 요청이 필요합니다.' }, 405);
            if (!Number.isSafeInteger(account.money) || account.money < 0 || account.money > RING_REBUY_THRESHOLD) return json({ error: '개인 머니가 5,000 이하일 때만 다시 10,000으로 충전할 수 있습니다.' }, 409);
            account.money = INITIAL_PERSONAL_MONEY;
            await this.writeStates([['auth-data', auth]]);
            return json({ account: publicAccount(account) });
          }
          if (path === '/ring/join') {
            if (request.method !== 'POST') return json({ error: 'POST 요청이 필요합니다.' }, 405);
            const data = await request.json();
            const previousRoom = this.room;
            const ring = this.room?.id === RING_ROOM_ID && this.room.players.length
              ? this.room : createRoom(RING_ROOM_ID, null, '6-max 링게임', RING_GAME_FORMAT);
            if (ring.id !== RING_ROOM_ID || ring.format.mode !== 'ring') throw new Error('링게임 테이블을 불러오지 못했습니다.');
            const previous = ring.records[id];
            const seated = ring.players.some(player => player.id === id);
            let nextRoom = addPlayer(ring, id, previous?.name || cleanName(data.nickname, account.username));
            if (!seated) {
              if (!Number.isSafeInteger(account.money) || account.money <= 0) throw new Error('개인 머니가 없습니다. 홈에서 추가 바이인해 주세요.');
              const chips = Math.min(RING_GAME_FORMAT.buyIn, account.money);
              account.money -= chips;
              const player = nextRoom.players.find(entry => entry.id === id);
              player.chips = chips;
            }
            this.room = nextRoom;
            this.roomKey = 'ring-room';
            try { await this.save(true, seated ? null : auth); }
            catch (error) { this.room = previousRoom; throw error; }
            this.broadcast();
            return json({ code: RING_ROOM_ID, account: publicAccount(account) });
          }
          if (path === '/ring/socket') {
            if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket 연결이 필요합니다.' }, 426);
            if (!this.room || this.room.format.mode !== 'ring' || !this.room.players.some(player => player.id === id)) return json({ error: '먼저 링게임에 입장해 주세요.' }, 403);
            if (this.ctx.getWebSockets().length >= 18) return json({ error: '연결 수가 많습니다. 다른 탭을 닫아 주세요.' }, 429);
            const [client, server] = Object.values(new WebSocketPair());
            this.ctx.acceptWebSocket(server);
            server.serializeAttachment({ id, accountId, lastMessage: 0 });
            if (this.startAutoHand(Date.now())) await this.save();
            this.broadcast();
            return new Response(null, { status: 101, webSocket: client });
          }
          return json({ error: '없는 경로입니다.' }, 404);
        }
        if (path === '/init') {
          const data = await request.json();
          if (this.room && !['ring', 'tournament'].includes(this.room.format?.mode)) return json({ error: '이전 비공개 테이블 형식은 더 이상 지원하지 않습니다.' }, 410);
          if (this.room) return this.room.id === data.id && this.room.records[id]
            ? json({ code: data.id, reused: true }, 200) : json({ error: '이미 존재하는 방입니다.' }, 409);
          const previousRoom = this.room;
          let charge = null;
          let roomSaved = false;
          try {
            let nextRoom = addPlayer(createRoom(data.id, id, data.name, data.format), id, cleanName(data.nickname, '플레이어'));
            if (nextRoom.format.mode === 'tournament') {
              charge = await this.chargeTournamentEntry(data.id, id, request.headers.get('x-account-id'), 1, data.entryMethod);
              nextRoom = recordTournamentEntry(nextRoom, id, data.entryMethod);
            }
            this.room = nextRoom;
            await this.save();
            roomSaved = true;
            return json({ code: data.id, ...(charge ? { account: publicAccount(charge.account) } : {}) }, 201);
          } catch (error) {
            if (!roomSaved) this.room = previousRoom;
            if (charge && !roomSaved) try { await this.refundTournamentEntry(id, request.headers.get('x-account-id'), charge.reference); } catch { throw new Error('토너먼트 생성에 실패했고 머니 복구도 확인되지 않았습니다. 지원을 요청해 주세요.'); }
            throw error;
          }
        }
        if (!this.room) return json({ error: '방을 찾을 수 없습니다. 초대 링크를 확인해 주세요.' }, 404);
        if (!['ring', 'tournament'].includes(this.room.format?.mode)) return json({ error: '이전 비공개 테이블 형식은 더 이상 지원하지 않습니다.' }, 410);
        if (path === '/info') {
          if (request.method !== 'GET') return json({ error: 'GET 요청이 필요합니다.' }, 405);
          const seated = this.room.players.some(player => player.id === id);
          const current = advanceTournamentLevel(this.room, Date.now());
          const level = current.tournament.level;
          const bigBlind = TOURNAMENT_LEVELS[level - 1]?.big ?? current.format.blinds.big;
          const registrationOpen = tournamentRegistrationOpen(this.room);
          return json({
            code: this.room.id, name: this.room.name, format: this.room.format, seated,
            players: this.room.players.length, maxPlayers: this.room.format.maxPlayers,
            startedAt: this.room.tournament.startedAt, level, bigBlind,
            finished: Boolean(this.room.tournament.winnerId),
            canJoin: seated || registrationOpen && this.room.players.length < this.room.format.maxPlayers,
          });
        }
        if (path === '/join') {
          const data = await request.json();
          const previous = this.room.records[id];
          const wasSeated = this.room.players.some(player => player.id === id);
          const previousRoom = this.room;
          let charge = null;
          let roomSaved = false;
          try {
            let nextRoom = addPlayer(this.room, id, previous?.name || cleanName(data.nickname, '플레이어'));
            if (nextRoom.format.mode === 'tournament' && !wasSeated) {
              charge = await this.chargeTournamentEntry(nextRoom.id, id, request.headers.get('x-account-id'), 1, data.entryMethod);
              nextRoom = recordTournamentEntry(nextRoom, id, data.entryMethod);
            }
            this.room = nextRoom;
            await this.save(); roomSaved = true; this.broadcast();
            return json({ code: this.room.id, ...(wasSeated ? { reused: true } : {}), ...(charge ? { account: publicAccount(charge.account) } : {}) });
          } catch (error) {
            if (!roomSaved) this.room = previousRoom;
            if (charge && !roomSaved) try { await this.refundTournamentEntry(id, request.headers.get('x-account-id'), charge.reference); } catch { throw new Error('토너먼트 참가에 실패했고 머니 복구도 확인되지 않았습니다. 지원을 요청해 주세요.'); }
            throw error;
          }
        }
        if (!this.room.players.some(p => p.id === id)) return json({ error: '먼저 테이블에 입장해 주세요.' }, 403);
        if (this.ctx.getWebSockets().length >= 18) return json({ error: '연결 수가 많습니다. 다른 탭을 닫아 주세요.' }, 429);
        const [client, server] = Object.values(new WebSocketPair());
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ id, accountId: request.headers.get('x-account-id'), lastMessage: 0 });
        if (this.startAutoHand(Date.now())) await this.save();
        this.broadcast();
        return new Response(null, { status: 101, webSocket: client });
      } catch (error) { return json({ error: error.message }, 400); }
    });
  }
  async webSocketMessage(ws, message) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!['ring', 'tournament'].includes(this.room?.format?.mode)) {
        ws.send(JSON.stringify({ type: 'error', error: '이전 비공개 테이블 형식은 더 이상 지원하지 않습니다.' }));
        ws.close(1008, 'Unsupported game format');
        return;
      }
      const session = ws.deserializeAttachment();
      const before = this.room;
      let authData = null;
      let ringBuyIns = null;
      let tournamentCharge = null;
      let roomSaved = false;
      const accountUpdates = [];
      try {
        if (typeof message !== 'string' || message.length > 8192) throw new Error('요청이 너무 큽니다.');
        if (Date.now() - session.lastMessage < 150) throw new Error('잠시 후 다시 시도해 주세요.');
        session.lastMessage = Date.now(); ws.serializeAttachment(session);
        const data = JSON.parse(message);
        const player = this.room.players.find(p => p.id === session.id);
        if (!player) throw new Error('방에 다시 입장해 주세요.');
        // Queued actions are re-validated when they run, so they do not need the latest revision.
        if (data.type !== 'queue' && data.revision !== this.room.revision) throw new Error('테이블이 갱신되었습니다. 다시 선택해 주세요.');
        const now = Date.now();
        if (data.type !== 'queue' && this.room.deadline && now >= this.room.deadline) throw new Error('행동 시간이 지났습니다. 테이블 갱신을 기다려 주세요.');
        const idle = ['waiting', 'finished'].includes(this.room.stage);
        const previousTournamentLevel = this.room.tournament?.level;
        this.room = advanceTournamentLevel(this.room, now);
        const tournamentLevelAdvanced = this.room.tournament?.level !== previousTournamentLevel;
        if (data.type === 'ready') {
          this.room = toggleReady(this.room, session.id);
        } else if (data.type === 'start') {
          const online = this.online();
          const deck = shuffledDeck(() => crypto.getRandomValues(new Uint32Array(1))[0]);
          this.room = startHand(clearOfflineReady(this.room, online), session.id, deck, now);
        } else if (data.type === 'rebuy') {
          if (this.room.format.mode === 'ring') {
            if (!idle || player.chips > RING_REBUY_THRESHOLD) throw new Error('칩이 5,000 이하일 때 대기 중에 추가 바이인할 수 있습니다.');
            authData = await this.readState('auth-data', { accounts: {} });
            const account = authData.accounts[session.accountId];
            if (!account || account.playerId !== session.id) throw new Error('로그인 정보를 확인해 주세요.');
            if (!Number.isSafeInteger(account.money) || account.money < 0) throw new Error('개인 머니 잔액을 확인해 주세요.');
            if (account.money <= RING_REBUY_THRESHOLD) account.money = INITIAL_PERSONAL_MONEY;
            const cost = this.room.format.rebuy.amount - player.chips;
            if (account.money < cost) throw new Error('추가 바이인에 필요한 개인 머니가 부족합니다.');
            account.money -= cost;
            accountUpdates.push(account);
            this.room = rebuyPlayer(this.room, session.id);
            ringBuyIns = await this.recordRingBuyIn(session.id, player.name);
          } else if (this.room.format.mode === 'tournament') {
            const entries = this.room.records[session.id]?.tournamentEntries || 0;
            if (!tournamentRegistrationOpen(this.room)) throw new Error('시작 스택이 5BB 미만이라 리엔트리가 마감됐습니다.');
            if (!idle || player.chips !== 0 || entries < 1 || entries > TOURNAMENT_MAX_REENTRIES || this.room.tournament.winnerId) throw new Error('칩이 0일 때 최대 2회까지 리엔트리할 수 있습니다.');
            tournamentCharge = await this.chargeTournamentEntry(this.room.id, session.id, session.accountId, entries + 1, data.entryMethod);
            this.room = recordTournamentEntry(this.room, session.id, data.entryMethod);
            accountUpdates.push(tournamentCharge.account);
          } else throw new Error('지원하지 않는 게임 형식입니다.');
        } else if (data.type === 'leave') {
          if (this.room.format.mode === 'ring') {
            authData = await this.readState('auth-data', { accounts: {} });
            const account = authData.accounts[session.accountId];
            if (!account || account.playerId !== session.id) throw new Error('로그인 정보를 확인해 주세요.');
            if (!Number.isSafeInteger(account.money) || account.money < 0 || !Number.isSafeInteger(account.money + player.chips)) throw new Error('개인 머니 잔액을 처리할 수 없습니다.');
            account.money += player.chips;
            accountUpdates.push(account);
          }
          this.room = leavePlayer(this.room, session.id);
          if (this.room.players.length === 0) {
            this.room = createRoom(RING_ROOM_ID, null, '6-max 링게임', RING_GAME_FORMAT);
            this.roomKey = 'ring-room';
          }
        } else if (data.type === 'claimHost') {
          this.room = claimHost(this.room, session.id, this.online().includes(this.room.hostId));
        } else if (data.type === 'action') this.room = act(this.room, session.id, data.action, data.amount, now);
        else if (data.type === 'queue') this.room = setQueued(this.room, session.id, data.queue ?? null);
        else throw new Error('알 수 없는 요청입니다.');
        if (this.room.format.mode === 'ring' && before.stage !== 'finished' && this.room.stage === 'finished') {
          const refill = await this.autoRefillRingLosers();
          if (refill) {
            authData = refill.authData;
            accountUpdates.push(...refill.updatedAccounts);
          }
        }
        if (before.stage !== 'finished' && this.room.stage === 'finished') this.scheduleAutoHand(now);
        this.startAutoHand(now);
        // A queued action must not invalidate the acting player's pending command.
        await this.save(data.type !== 'queue' || tournamentLevelAdvanced, authData, ringBuyIns ? [[RING_BUY_INS_KEY, ringBuyIns]] : []);
        roomSaved = true;
        for (const account of accountUpdates) {
          for (const peer of this.ctx.getWebSockets()) try {
            if (peer.deserializeAttachment().accountId === account.id) peer.send(JSON.stringify({ type: 'account', account: publicAccount(account) }));
          } catch { /* A disconnected tab will refresh its account on reconnect. */ }
        }
        if (data.type === 'leave') {
          for (const peer of this.ctx.getWebSockets()) if (peer.deserializeAttachment().id === session.id) { peer.send(JSON.stringify({ type: 'left' })); peer.close(1000, 'Left room'); }
        }
        this.broadcast();
      } catch (error) {
        if (!roomSaved) this.room = before;
        let message = error.message;
        if (tournamentCharge && !roomSaved) {
          try {
            const account = await this.refundTournamentEntry(session.id, session.accountId, tournamentCharge.reference);
            ws.send(JSON.stringify({ type: 'account', account: publicAccount(account) }));
          } catch { message = '토너먼트 바이인이 완료되지 않았고 머니 복구도 확인되지 않았습니다. 지원을 요청해 주세요.'; }
        }
        ws.send(JSON.stringify({ type: 'error', error: message }));
        ws.send(JSON.stringify({ type: 'state', room: publicRoom(this.room, session.id, this.online()) }));
      }
    });
  }
  async alarm() {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.room) return;
      if (!['ring', 'tournament'].includes(this.room.format?.mode)) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      const now = Date.now();
      const alarmAt = nextAlarmAt(this.room);
      if (!alarmAt) return;
      if (alarmAt > now) { await this.ctx.storage.setAlarm(alarmAt); return; }
      const before = this.room;
      this.room = advanceTournamentLevel(this.room, now);
      let authData = null;
      let refill = null;
      if (this.room.deadline && this.room.deadline <= now) {
        const player = this.room.players[this.room.turn];
        const legal = legalActions(this.room, player.id);
        this.room = act(this.room, player.id, legal.canCheck ? 'check' : 'fold', undefined, now);
        if (this.room.format.mode === 'ring' && before.stage !== 'finished' && this.room.stage === 'finished') {
          refill = await this.autoRefillRingLosers();
          if (refill) authData = refill.authData;
        }
      }
        if (before.stage !== 'finished' && this.room.stage === 'finished') this.scheduleAutoHand(now);
        this.startAutoHand(now);
      await this.save(true, authData);
      for (const account of refill?.updatedAccounts || []) for (const peer of this.ctx.getWebSockets()) {
        if (peer.deserializeAttachment().accountId === account.id) peer.send(JSON.stringify({ type: 'account', account: publicAccount(account) }));
      }
      this.broadcast();
    });
  }
  async webSocketClose(ws, code) { ws.close(code === 1005 ? 1000 : code); if (this.room) this.broadcast(); }
  async webSocketError(ws) { ws.close(1011, 'Connection error'); }
}
