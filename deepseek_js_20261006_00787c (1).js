/* ============================================================================
   ARENA FPS — Socket.IO SERVER (single-file)
   Запуск:  node server.js
   Порт:    process.env.PORT || 3001
   ============================================================================ */
const express   = require('express');
const http      = require('http');
const { Server }= require('socket.io');
const cors      = require('cors');

const PORT = process.env.PORT || 3001;

/* -------------------- EXPRESS -------------------- */
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/',      (_q, r) => r.json({
  name: 'ARENA FPS Server',
  status: 'ok',
  rooms: ROOMS.size,
  players: [...ROOMS.values()].reduce((a, r) => a + r.players.size, 0),
  uptime: Math.round(process.uptime()) + 's'
}));
app.get('/health', (_q, r) => r.send('OK'));

/* -------------------- SOCKET.IO -------------------- */
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 10000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e5
});

/* -------------------- КОНСТАНТЫ -------------------- */
const TICK_RATE        = 20;
const TICK_MS          = 1000 / TICK_RATE;
const MAX_PLAYERS      = 8;
const MAX_RANGE        = 100;
const SHOT_COOLDOWN_MS = 40;
const RESPAWN_DELAY_MS = 3000;

const SPAWNS = [
  { x: -20, z: -20 }, { x: 20, z: -20 },
  { x: -20, z:  20 }, { x: 20, z:  20 },
  { x:   0, z: -21 }, { x:  0, z:  21 },
  { x: -21, z:   0 }, { x: 21, z:   0 }
];

const WEAPON_DAMAGE = {
  smg: 20, ak47: 30, sniper: 90,
  shotgun: 14, pistol: 34, knife: 55
};
const HEAD_MULT = 2.5;
const LEG_MULT  = 0.8;

/* Упрощённые хитбоксы (цилиндр) */
const HITBOX_RADIUS = 0.4;
const HITBOX_PARTS  = {
  head: [1.55, 1.85],
  body: [0.70, 1.55],
  legs: [0.00, 0.70]
};

/* -------------------- ROOM / PLAYER -------------------- */
const ROOMS = new Map();

function genRoomCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
  return ROOMS.has(s) ? genRoomCode() : s;
}

function findFreeRoom() {
  for (const r of ROOMS.values()) if (r.players.size < MAX_PLAYERS) return r;
  const id = genRoomCode();
  const room = new Room(id);
  ROOMS.set(id, room);
  return room;
}

class Room {
  constructor(id) { this.id = id; this.players = new Map(); this.createdAt = Date.now(); }
  add(p)    { if (this.players.size >= MAX_PLAYERS) return false; this.players.set(p.id, p); return true; }
  remove(id){ this.players.delete(id); }
  isEmpty() { return this.players.size === 0; }
  serialize() {
    const arr = [];
    for (const p of this.players.values()) {
      arr.push({
        id: p.id, name: p.name,
        x: p.x, y: p.y, z: p.z,
        yaw: p.yaw, pitch: p.pitch,
        hp: p.hp, kills: p.kills, deaths: p.deaths,
        weaponId: p.weaponId, alive: p.alive
      });
    }
    return arr;
  }
}

class Player {
  constructor(id, name) {
    this.id       = id;
    this.name     = String(name || 'Player').slice(0, 24) || 'Player';
    const sp      = SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
    this.x = sp.x; this.y = 0; this.z = sp.z;
    this.yaw = 0; this.pitch = 0;
    this.hp       = 100;
    this.kills    = 0;
    this.deaths   = 0;
    this.weaponId = 'smg';
    this.alive    = true;
    this.lastShot = 0;
    this.lastInput= Date.now();
  }
}

/* -------------------- RAYCAST -------------------- */
function rayAABB(o, d, box) {
  let tmin = 0, tmax = Infinity;
  for (const ax of ['x', 'y', 'z']) {
    const mn = box[ax], mx = box['max' + ax.toUpperCase()];
    const dd = d[ax];
    if (Math.abs(dd) < 1e-8) {
      if (o[ax] < mn || o[ax] > mx) return null;
    } else {
      let t1 = (mn - o[ax]) / dd;
      let t2 = (mx - o[ax]) / dd;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

function raycastPlayer(from, dir, room, shooterId) {
  let best = null, bestDist = MAX_RANGE;
  for (const p of room.players.values()) {
    if (p.id === shooterId || !p.alive) continue;
    for (const [part, [yMin, yMax]] of Object.entries(HITBOX_PARTS)) {
      const t = rayAABB(from, dir, {
        x: p.x - HITBOX_RADIUS, y: p.y + yMin, z: p.z - HITBOX_RADIUS,
        maxX: p.x + HITBOX_RADIUS, maxY: p.y + yMax, maxZ: p.z + HITBOX_RADIUS
      });
      if (t !== null && t > 0 && t < bestDist) {
        bestDist = t;
        best = { targetId: p.id, part, distance: t };
      }
    }
  }
  return best;
}

/* -------------------- UTIL -------------------- */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* -------------------- SOCKET.IO HANDLERS -------------------- */
io.on('connection', socket => {
  console.log('[+] connect:', socket.id);
  let room = null, me = null;

  socket.on('join', ({ nickname, roomId } = {}) => {
    // Уход из старой комнаты
    if (room && me) {
      room.remove(me.id);
      io.to(room.id).emit('playerLeft', { id: me.id, name: me.name });
      socket.leave(room.id);
      if (room.isEmpty()) ROOMS.delete(room.id);
    }

    let target;
    if (roomId) {
      target = ROOMS.get(String(roomId).toUpperCase());
      if (!target) { socket.emit('joinError', { message: 'Комната не найдена' }); return; }
    } else {
      target = findFreeRoom();
    }
    if (target.players.size >= MAX_PLAYERS) {
      socket.emit('joinError', { message: 'Комната заполнена' });
      return;
    }

    me   = new Player(socket.id, nickname);
    room = target;
    room.add(me);
    socket.join(room.id);

    socket.emit('joined', { roomId: room.id, you: me.id, players: room.serialize() });
    socket.to(room.id).emit('playerJoined', {
      id: me.id, name: me.name,
      x: me.x, y: me.y, z: me.z,
      yaw: me.yaw, pitch: me.pitch,
      hp: me.hp, kills: me.kills, deaths: me.deaths, weaponId: me.weaponId
    });
    console.log(`[join] ${me.name} → ${room.id} (${room.players.size}/${MAX_PLAYERS})`);
  });

  socket.on('input', d => {
    if (!me || !room || !d) return;
    if (typeof d.x !== 'number' || typeof d.z !== 'number') return;
    me.x     = clamp(d.x, -25, 25);
    me.y     = clamp(typeof d.y === 'number' ? d.y : 0, 0, 20);
    me.z     = clamp(d.z, -25, 25);
    me.yaw   = typeof d.yaw === 'number'   ? d.yaw   : 0;
    me.pitch = typeof d.pitch === 'number' ? d.pitch : 0;
    if (typeof d.weaponId === 'string' && WEAPON_DAMAGE[d.weaponId]) me.weaponId = d.weaponId;
    me.lastInput = Date.now();
  });

  socket.on('shoot', d => {
    if (!me || !room || !d) return;
    const now = Date.now();
    if (now - me.lastShot < SHOT_COOLDOWN_MS) return;
    me.lastShot = now;

    const from = {
      x: clamp(d.x ?? me.x,     -30, 30),
      y: clamp(d.y ?? me.y + 1.6, 0,  25),
      z: clamp(d.z ?? me.z,     -30, 30)
    };
    let dx = +d.dx || 0, dy = +d.dy || 0, dz = +d.dz || 0;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return;
    dx /= len; dy /= len; dz /= len;

    const weaponId = WEAPON_DAMAGE[d.weaponId] ? d.weaponId : me.weaponId;

    io.to(room.id).emit('shot', {
      id: me.id, x: from.x, y: from.y, z: from.z,
      dx, dy, dz, weaponId
    });

    const hit = raycastPlayer(from, { x: dx, y: dy, z: dz }, room, me.id);
    if (!hit) return;
    const victim = room.players.get(hit.targetId);
    if (!victim || !victim.alive) return;

    let dmg = WEAPON_DAMAGE[weaponId] || 20;
    if (hit.part === 'head') dmg *= HEAD_MULT;
    else if (hit.part === 'legs') dmg *= LEG_MULT;
    dmg = Math.round(dmg);

    victim.hp -= dmg;

    io.to(room.id).emit('hit', {
      shooterId: me.id, shooterName: me.name,
      victimId: victim.id, victimName: victim.name,
      dmg, part: hit.part, hp: Math.max(0, victim.hp)
    });

    if (victim.hp <= 0) {
      victim.hp = 0;
      victim.alive = false;
      victim.deaths++;
      me.kills++;

      io.to(room.id).emit('kill', {
        killerId: me.id, killerName: me.name,
        victimId: victim.id, victimName: victim.name,
        isHead: hit.part === 'head'
      });

      setTimeout(() => {
        const sp = SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
        victim.x = sp.x; victim.z = sp.z; victim.y = 0;
        victim.hp = 100; victim.alive = true;
        io.to(room.id).emit('respawn', {
          id: victim.id, x: victim.x, y: victim.y, z: victim.z, hp: 100
        });
      }, RESPAWN_DELAY_MS);
    }
  });

  socket.on('chat', d => {
    if (!me || !room) return;
    const text = String(d?.text || '').slice(0, 120).trim();
    if (!text) return;
    io.to(room.id).emit('chat', { name: me.name, text });
  });

  socket.on('disconnect', () => {
    console.log('[-] disconnect:', socket.id);
    if (room && me) {
      room.remove(me.id);
      io.to(room.id).emit('playerLeft', { id: me.id, name: me.name });
      if (room.isEmpty()) { ROOMS.delete(room.id); console.log('[room] deleted', room.id); }
    }
  });
});

/* -------------------- BROADCAST 20Hz -------------------- */
setInterval(() => {
  for (const room of ROOMS.values()) {
    if (room.players.size === 0) continue;
    io.to(room.id).emit('state', { players: room.serialize(), t: Date.now() });
  }
}, TICK_MS);

/* -------------------- START -------------------- */
httpServer.listen(PORT, () => {
  console.log(`⚡ ARENA FPS server on :${PORT}`);
  console.log(`   Tick: ${TICK_RATE}Hz  |  Max/room: ${MAX_PLAYERS}`);
  console.log(`   CORS: * (все домены разрешены)`);
});