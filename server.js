'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Allow Netlify (or any) frontend origin to talk to this Socket.io + REST API
const io = new Server(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Cloudflare tunnel (one process; refreshable per play session) ─
let shareUrl = null;
let shareStatus = 'connecting'; // 'ready' | 'connecting' | 'error'
let cfProcess = null;
let tunnelGeneration = 0;
let refreshInFlight = null;

// Require hyphenated host (excludes api.trycloudflare.com and similar)
const TUNNEL_URL_RE = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/;
const TUNNEL_WAIT_MS = 25000;

function sharePayload() {
  return { url: shareUrl, status: shareStatus };
}

app.get('/api/share-url', (_req, res) => {
  res.json(sharePayload());
});

app.post('/api/share-url/refresh', async (_req, res) => {
  try {
    const result = await refreshTunnel();
    res.json(result);
  } catch (err) {
    shareStatus = 'error';
    res.status(500).json({ url: shareUrl, status: 'error', error: String(err && err.message || err) });
  }
});

function stopTunnel() {
  const proc = cfProcess;
  cfProcess = null;
  if (!proc || proc.killed) return Promise.resolve();

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    proc.once('exit', finish);

    try {
      if (process.platform === 'win32' && proc.pid) {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        proc.kill('SIGTERM');
      }
    } catch (_) {
      try { proc.kill('SIGKILL'); } catch {}
    }

    setTimeout(() => {
      try { if (!proc.killed) proc.kill('SIGKILL'); } catch {}
      finish();
    }, 2500);
  });
}

function startTunnel(expectedGen) {
  return new Promise((resolve) => {
    const candidates = [
      'cloudflared',
      'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
      'C:\\Program Files\\cloudflared\\cloudflared.exe',
      `${process.env.LOCALAPPDATA || ''}\\cloudflared\\cloudflared.exe`,
      `${process.env.APPDATA || ''}\\cloudflared\\cloudflared.exe`,
    ].filter(Boolean);

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(waitTimer);
      resolve(sharePayload());
    };

    const waitTimer = setTimeout(() => {
      if (expectedGen === tunnelGeneration && !shareUrl) {
        shareStatus = 'error';
        console.warn('⚠️  cloudflared tunnel timed out waiting for URL');
      }
      finish();
    }, TUNNEL_WAIT_MS);

    function tryNext(index) {
      if (expectedGen !== tunnelGeneration) { finish(); return; }
      if (index >= candidates.length) {
        shareStatus = 'error';
        console.warn('⚠️  cloudflared not found – tunnel disabled');
        finish();
        return;
      }

      const exe = candidates[index];
      let cf;
      try {
        cf = spawn(exe, ['tunnel', '--url', 'http://localhost:3000'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        if (err && err.code === 'ENOENT') { tryNext(index + 1); return; }
        shareStatus = 'error';
        console.warn(`⚠️  cloudflared spawn failed: ${err.message}`);
        finish();
        return;
      }

      cfProcess = cf;

      const onData = (chunk) => {
        if (expectedGen !== tunnelGeneration || cfProcess !== cf) return;
        const m = chunk.toString().match(TUNNEL_URL_RE);
        if (m) {
          shareUrl = m[0];
          shareStatus = 'ready';
          const urlMsg = `🌐 Share URL: ${shareUrl}\n`;
          console.log('\n' + urlMsg);
          try { fs.appendFileSync(path.join(__dirname, 'server.log'), urlMsg); } catch {}
          finish();
        }
      };

      cf.stdout.on('data', onData);
      cf.stderr.on('data', onData);
      cf.on('error', (err) => {
        if (err.code === 'ENOENT') {
          if (cfProcess === cf) cfProcess = null;
          tryNext(index + 1);
          return;
        }
        if (expectedGen === tunnelGeneration) {
          shareStatus = 'error';
          console.warn(`⚠️  cloudflared error: ${err.message}`);
        }
        finish();
      });
      cf.on('exit', (code) => {
        if (cfProcess === cf) cfProcess = null;
        if (expectedGen === tunnelGeneration && !shareUrl && code !== 0 && code !== null) {
          console.warn(`⚠️  cloudflared exited (code ${code})`);
        }
      });
    }

    tryNext(0);
  });
}

function refreshTunnel() {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    tunnelGeneration += 1;
    const gen = tunnelGeneration;
    shareUrl = null;
    shareStatus = 'connecting';
    console.log('🔄 Refreshing Cloudflare tunnel…');
    await stopTunnel();
    return startTunnel(gen);
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

// ── Character class stats ─────────────────────────────────────
const CLASS_STATS = {
  // HP ~1.8× previous values — longer TTK without lowering damage
  soldier:  { maxHP: 180, speed: 200, fireRate: 250,   bulletSpeed: 560, bulletDamage: 25, radius: 16 },
  sniper:   { maxHP: 135, speed: 170, fireRate: 600,   bulletSpeed: 650, bulletDamage: 50, radius: 16 },
  tank:     { maxHP: 320, speed: 130, fireRate: 180,   bulletSpeed: 560, bulletDamage: 20, radius: 20 },
  medic:    { maxHP: 160, speed: 185, fireRate: 250,   bulletSpeed: 560, bulletDamage: 20, radius: 16 },
  assassin: { maxHP: 125, speed: 240, fireRate: 250,   bulletSpeed: 560, bulletDamage: 35, radius: 16 },
  brawler:  { maxHP: 250, speed: 180, fireRate: 99999, bulletSpeed: 0,   bulletDamage: 0,  radius: 18 },
};

// ── Weapon configs ────────────────────────────────────────────
const WEAPON_STATS = {
  pistol:     { fireRate: null, bulletSpeed: null, damage: null, ammo: -1,  pellets: 1, spread: 0    },
  shotgun:    { fireRate: 500,  bulletSpeed: 480,  damage: 15,   ammo: 6,   pellets: 5, spread: 0.2  },
  machinegun: { fireRate: 80,   bulletSpeed: 580,  damage: 12,   ammo: 30,  pellets: 1, spread: 0.05 },
};

const ITEM_TYPES = ['hp', 'speed', 'shield'];

// ── Global constants ──────────────────────────────────────────
const BULLET_RADIUS        = 5;
const RESPAWN_MS           = 3000;
const TICK_RATE            = 20;
const TICK_MS              = 1000 / TICK_RATE;
const WEAPON_RESPAWN_MS    = 20000;
const ITEM_RESPAWN_MIN_MS  = 15000;
const ITEM_RESPAWN_MAX_MS  = 25000;
const PICKUP_RADIUS        = 24;
const FLAG_PICKUP_RADIUS   = 52;
const FLAG_CAPTURE_RADIUS  = 140;
const MAX_FEED             = 8;

// ── Skill constants ───────────────────────────────────────────
const SKILL_CD = { dash: 4000, shield: 6000, grenade: 8000, heal: 10000, speed: 7000, melee: 400, brawlerQ: 4000 };
const DASH_DISTANCE        = 180;
const ASSASSIN_DASH_DIST   = 280;
const SHIELD_DURATION      = 1500;
const SPEED_DURATION       = 3000;
const SPEED_MULT           = 2.0;
const GRENADE_FUSE         = 1200;
const GRENADE_DAMAGE       = 60;
const GRENADE_RADIUS       = 80;
const HEAL_AMOUNT          = 30;
const MEDIC_HEAL_AMOUNT    = 60;
const MEDIC_REGEN_RATE     = 2;
const MELEE_DAMAGE         = 40;
const MELEE_RANGE          = 80;
const MELEE_HALF_CONE      = Math.PI / 4; // 45° each side = 90° total
const BRAWLER_Q_PELLETS    = 5;
const BRAWLER_Q_SPREAD     = 0.4;
const BRAWLER_Q_DAMAGE     = 20;
const BRAWLER_Q_SPEED      = 480;
const BRAWLER_Q_RANGE_MS   = 0.42; // life in seconds (~200px)

// ── Kill streak constants ─────────────────────────────────────
const STREAK_SPEED_MULT     = 1.1;
const STREAK_SPEED_DURATION = 10000;
const STREAK_CD_MULT        = 0.7;

// ── Item effect constants ─────────────────────────────────────
const ITEM_SPEED_MULT      = 1.5;
const ITEM_SPEED_DURATION  = 5000;
const ITEM_SHIELD_DURATION = 3000;
const ITEM_HP_AMOUNT       = 40;

// ── Game mode kill/capture goals ──────────────────────────────
const KILL_GOALS = { tdm: 15, ctf: 5 };

// ── Map configurations ────────────────────────────────────────
const WAREHOUSE_WALLS = [
  { x: 640, y: 420, w: 320, h: 22 }, { x: 640, y: 758, w: 320, h: 22 },
  { x: 640, y: 420, w: 22, h: 148 }, { x: 640, y: 632, w: 22, h: 148 },
  { x: 938, y: 420, w: 22, h: 148 }, { x: 938, y: 632, w: 22, h: 148 },
  { x: 700, y: 120, w: 200, h: 22 }, { x: 789, y: 80,  w: 22, h: 62 },
  { x: 700, y: 1058, w: 200, h: 22 }, { x: 789, y: 1058, w: 22, h: 62 },
  { x: 350, y: 360, w: 22, h: 140 }, { x: 350, y: 700, w: 22, h: 140 }, { x: 290, y: 570, w: 100, h: 22 },
  { x: 1228, y: 360, w: 22, h: 140 }, { x: 1228, y: 700, w: 22, h: 140 }, { x: 1210, y: 570, w: 100, h: 22 },
  { x: 160, y: 180, w: 22, h: 200 }, { x: 160, y: 820, w: 22, h: 200 }, { x: 100, y: 560, w: 120, h: 22 },
  { x: 1418, y: 180, w: 22, h: 200 }, { x: 1418, y: 820, w: 22, h: 200 }, { x: 1380, y: 560, w: 120, h: 22 },
  { x: 280, y: 160, w: 120, h: 22 }, { x: 280, y: 1018, w: 120, h: 22 },
  { x: 1200, y: 160, w: 120, h: 22 }, { x: 1200, y: 1018, w: 120, h: 22 },
  { x: 520, y: 240, w: 80, h: 22 }, { x: 520, y: 938, w: 80, h: 22 },
  { x: 1000, y: 240, w: 80, h: 22 }, { x: 1000, y: 938, w: 80, h: 22 },
];

const ARENA_WALLS = [
  { x: 490, y: 340, w: 220, h: 20 }, { x: 490, y: 540, w: 220, h: 20 },
  { x: 470, y: 340, w: 20, h: 100 }, { x: 470, y: 460, w: 20, h: 100 },
  { x: 710, y: 340, w: 20, h: 100 }, { x: 710, y: 460, w: 20, h: 100 },
  { x: 200, y: 160, w: 140, h: 20 }, { x: 860, y: 160, w: 140, h: 20 },
  { x: 200, y: 720, w: 140, h: 20 }, { x: 860, y: 720, w: 140, h: 20 },
  { x: 130, y: 300, w: 20, h: 140 }, { x: 130, y: 460, w: 20, h: 140 }, { x: 100, y: 420, w: 80, h: 20 },
  { x: 1050, y: 300, w: 20, h: 140 }, { x: 1050, y: 460, w: 20, h: 140 }, { x: 1020, y: 420, w: 80, h: 20 },
  { x: 350, y: 200, w: 80, h: 20 }, { x: 770, y: 200, w: 80, h: 20 },
  { x: 350, y: 680, w: 80, h: 20 }, { x: 770, y: 680, w: 80, h: 20 },
  { x: 270, y: 100, w: 80, h: 20 }, { x: 850, y: 100, w: 80, h: 20 },
  { x: 270, y: 780, w: 80, h: 20 }, { x: 850, y: 780, w: 80, h: 20 },
];

const MAZE_WALLS = [
  { x: 150, y: 250, w: 180, h: 18 }, { x: 500, y: 250, w: 160, h: 18 },
  { x: 750, y: 250, w: 160, h: 18 }, { x: 1080, y: 250, w: 180, h: 18 },
  { x: 200, y: 500, w: 130, h: 18 }, { x: 430, y: 500, w: 200, h: 18 },
  { x: 780, y: 500, w: 200, h: 18 }, { x: 1070, y: 500, w: 130, h: 18 },
  { x: 150, y: 750, w: 180, h: 18 }, { x: 500, y: 750, w: 160, h: 18 },
  { x: 750, y: 750, w: 160, h: 18 }, { x: 1080, y: 750, w: 180, h: 18 },
  { x: 340, y: 100, w: 18, h: 130 }, { x: 340, y: 290, w: 18, h: 180 },
  { x: 340, y: 510, w: 18, h: 200 }, { x: 340, y: 760, w: 18, h: 120 },
  { x: 680, y: 100, w: 18, h: 100 }, { x: 680, y: 270, w: 18, h: 220 },
  { x: 680, y: 550, w: 18, h: 170 }, { x: 680, y: 770, w: 18, h: 120 },
  { x: 1020, y: 100, w: 18, h: 130 }, { x: 1020, y: 290, w: 18, h: 180 },
  { x: 1020, y: 510, w: 18, h: 200 }, { x: 1020, y: 760, w: 18, h: 120 },
  { x: 490, y: 150, w: 100, h: 18 }, { x: 820, y: 150, w: 100, h: 18 },
  { x: 490, y: 840, w: 100, h: 18 }, { x: 820, y: 840, w: 100, h: 18 },
  { x: 170, y: 390, w: 110, h: 18 }, { x: 1120, y: 390, w: 110, h: 18 },
  { x: 170, y: 600, w: 110, h: 18 }, { x: 1120, y: 600, w: 110, h: 18 },
];

const MAP_CONFIGS = {
  warehouse: {
    width: 1600, height: 1200,
    walls: WAREHOUSE_WALLS,
    weaponSpawns: [
      { x: 400, y: 200 }, { x: 1200, y: 200 }, { x: 400, y: 1000 }, { x: 1200, y: 1000 },
      { x: 500, y: 590 }, { x: 1100, y: 590 }, { x: 800, y: 250 },
    ],
    itemSpawns: [
      { x: 800, y: 180 }, { x: 800, y: 1020 },
      { x: 200, y: 600 }, { x: 1400, y: 600 },
      { x: 600, y: 900 }, { x: 1000, y: 300 },
    ],
    // Clear of nearby cover walls so carriers can score reliably
    redFlagPos:  { x: 90,   y: 600 },
    blueFlagPos: { x: 1510, y: 600 },
  },
  arena: {
    width: 1200, height: 900,
    walls: ARENA_WALLS,
    weaponSpawns: [
      { x: 250, y: 150 }, { x: 950, y: 150 }, { x: 250, y: 750 }, { x: 950, y: 750 },
      { x: 300, y: 450 }, { x: 900, y: 450 }, { x: 600, y: 200 },
    ],
    itemSpawns: [
      { x: 600, y: 100 }, { x: 600, y: 800 },
      { x: 200, y: 450 }, { x: 1000, y: 450 },
      { x: 350, y: 380 }, { x: 850, y: 580 },
    ],
    redFlagPos:  { x: 70,   y: 450 },
    blueFlagPos: { x: 1130, y: 450 },
  },
  maze: {
    width: 1400, height: 1000,
    walls: MAZE_WALLS,
    weaponSpawns: [
      { x: 200, y: 160 }, { x: 1200, y: 160 }, { x: 200, y: 840 }, { x: 1200, y: 840 },
      { x: 550, y: 390 }, { x: 850, y: 390 }, { x: 700, y: 620 },
    ],
    itemSpawns: [
      { x: 700, y: 130 }, { x: 700, y: 870 },
      { x: 150, y: 500 }, { x: 1250, y: 500 },
      { x: 430, y: 630 }, { x: 900, y: 370 },
    ],
    redFlagPos:  { x: 70,   y: 500 },
    blueFlagPos: { x: 1330, y: 500 },
  },
};

// ── Room name / code helpers ──────────────────────────────────
const rooms = new Map();
let roomNameCounter = 0;
const ROOM_PREFIXES = ['전장', '격전지', '전투구역', '작전지'];

function generateRoomName() {
  const prefix = ROOM_PREFIXES[roomNameCounter % ROOM_PREFIXES.length];
  roomNameCounter++;
  return `${prefix}-${roomNameCounter}`;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while ([...rooms.values()].some(r => r.code === code));
  return code;
}

// ── Bot system ────────────────────────────────────────────────
const BOT_NAMES = ['Bot_Alpha', 'Bot_Bravo', 'Bot_Charlie', 'Bot_Delta', 'Bot_Echo', 'Bot_Foxtrot', 'Bot_Sigma', 'Bot_Nova'];
const BOT_CLASSES = ['soldier', 'sniper', 'tank', 'medic'];

function spawnPos(team, room) {
  if (team === 'red') return { x: 80 + Math.random() * 80, y: 120 + Math.random() * (room.worldH - 240) };
  return { x: room.worldW - 160 + Math.random() * 80, y: 120 + Math.random() * (room.worldH - 240) };
}

function makePlayer(id, name, team, validClass, room, extraFields = {}) {
  const cs  = CLASS_STATS[validClass];
  const pos = spawnPos(team, room);
  return {
    id,
    name: (name || 'Player').slice(0, 14),
    team, class: validClass,
    x: pos.x, y: pos.y,
    hp: cs.maxHP, maxHP: cs.maxHP,
    baseSpeed: cs.speed, radius: cs.radius,
    alive: true,
    angle: team === 'red' ? 0 : Math.PI,
    kills: 0, deaths: 0, killStreak: 0,
    respawnAt: null, shootAt: 0,
    input: { dx: 0, dy: 0, shooting: false, angle: 0, skills: {}, grenadeTarget: { x: 0, y: 0 } },
    skills: { dash: 0, shield: 0, grenade: 0, heal: 0, speed: 0, melee: 0, brawlerQ: 0 },
    shielded: false, shieldEnd: 0,
    speedBoost: false, speedEnd: 0,
    streakSpeedBoost: false, streakSpeedEnd: 0, streakCdMult: 1.0,
    itemSpeedBoost: false, itemSpeedEnd: 0,
    weapon: 'pistol', ammo: -1,
    hasFlag: null,
    dashCharges: validClass === 'assassin' ? 2 : 1,
    maxDashCharges: validClass === 'assassin' ? 2 : 1,
    dashChargeRegenAt: 0,
    isBot: false,
    ...extraFields,
  };
}

function createBot(team, room) {
  const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
  const cls  = BOT_CLASSES[Math.floor(Math.random() * BOT_CLASSES.length)];
  const botId = 'bot_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
  const now  = Date.now();
  const bot  = makePlayer(botId, name, team, cls, room, {
    isBot: true,
    botState: {
      stuckTimer: 0,
      stuckLastPos: { x: 0, y: 0 },
      stuckDir: { dx: 0, dy: 1 },
      wanderDir: null,
      nextGrenadeAt: now + 8000 + Math.random() * 4000,
    },
  });
  room.players.set(botId, bot);
}

function dropCarriedFlag(player, room) {
  if (!player || !player.hasFlag || !room.flags) return;
  const flag = room.flags[player.hasFlag];
  if (flag) {
    flag.carrierId = null;
    flag.dropped = true;
    flag.x = player.x;
    flag.y = player.y;
    flag.dropAt = Date.now();
  }
  player.hasFlag = null;
}

function removePlayerFromRoom(room, playerId) {
  const player = room.players.get(playerId);
  if (!player) return;
  dropCarriedFlag(player, room);
  room.players.delete(playerId);
}

function balanceBots(room) {
  const maxBots = Math.max(0, Math.min(4, room.botsPerTeam ?? 2));
  const humans = { red: 0, blue: 0 };
  const botIds = { red: [], blue: [] };

  for (const [id, p] of room.players) {
    if (p.isBot) botIds[p.team].push(id);
    else         humans[p.team]++;
  }

  for (const team of ['red', 'blue']) {
    // Fill each team up to botsPerTeam with bots; humans replace bot slots
    const want = Math.max(0, maxBots - humans[team]);
    // Remove excess bots (must drop flags or CTF gets stuck forever)
    while (botIds[team].length > want) {
      removePlayerFromRoom(room, botIds[team].pop());
    }
    // Add missing bots
    while (botIds[team].length < want) {
      createBot(team, room);
      botIds[team].push('_');
    }
  }
}

function updateBotAI(bot, room, dt, now) {
  if (!bot.alive || !bot.isBot) return;
  const bs  = bot.botState;
  const inp = bot.input;

  // Find nearest live enemy
  let enemy = null, enemyDist = Infinity;
  for (const [, p] of room.players) {
    if (p.id === bot.id || p.team === bot.team || !p.alive) continue;
    const dx = p.x - bot.x, dy = p.y - bot.y;
    const d = Math.hypot(dx, dy);
    if (d < enemyDist) { enemyDist = d; enemy = p; }
  }

  inp.skills = {};

  // CTF objective override: return / capture flags so matches don't stall
  let ctfTarget = null;
  if (room.flags) {
    const ownFlag = room.flags[bot.team];
    const enemyTeam = bot.team === 'red' ? 'blue' : 'red';
    const enemyFlag = room.flags[enemyTeam];
    if (bot.hasFlag && ownFlag) {
      ctfTarget = { x: ownFlag.homeX, y: ownFlag.homeY };
    } else if (ownFlag && ownFlag.dropped && !ownFlag.carrierId) {
      ctfTarget = { x: ownFlag.x, y: ownFlag.y };
    } else if (!bot.hasFlag && enemyFlag && !enemyFlag.carrierId) {
      // Only chase enemy flag if reasonably close / no urgent fight
      const fd = Math.hypot(enemyFlag.x - bot.x, enemyFlag.y - bot.y);
      if (!enemy || enemyDist > 280 || fd < enemyDist * 0.85) {
        ctfTarget = { x: enemyFlag.x, y: enemyFlag.y };
      }
    }
  }

  if (ctfTarget) {
    const tdx = ctfTarget.x - bot.x, tdy = ctfTarget.y - bot.y;
    const td = Math.hypot(tdx, tdy) || 1;
    inp.dx = tdx / td;
    inp.dy = tdy / td;
    if (enemy) {
      const edx = enemy.x - bot.x, edy = enemy.y - bot.y;
      const aimAngle = Math.atan2(edy, edx);
      const errorRad = (5 + Math.random() * 10) * (Math.PI / 180);
      inp.angle = aimAngle + (Math.random() - 0.5) * errorRad * 2;
      inp.shooting = enemyDist < 380;
      if (bot.class === 'brawler' && enemyDist < MELEE_RANGE + enemy.radius + 10 && now >= bot.skills.melee) {
        inp.skills.melee = true;
        inp.shooting = false;
      }
    } else {
      inp.angle = Math.atan2(tdy, tdx);
      inp.shooting = false;
    }
  } else if (enemy) {
    const edx = enemy.x - bot.x, edy = enemy.y - bot.y;

    // Stuck detection
    const movedD = Math.hypot(bot.x - bs.stuckLastPos.x, bot.y - bs.stuckLastPos.y);
    if (movedD < 2) {
      bs.stuckTimer += dt;
    } else {
      bs.stuckTimer = 0;
      bs.stuckLastPos = { x: bot.x, y: bot.y };
    }
    if (bs.stuckTimer > 1.0) {
      const a = Math.random() * Math.PI * 2;
      bs.stuckDir = { dx: Math.cos(a), dy: Math.sin(a) };
      bs.stuckTimer = 0;
    }

    let moveDx, moveDy;
    if (bs.stuckTimer > 0.5) {
      moveDx = bs.stuckDir.dx;
      moveDy = bs.stuckDir.dy;
    } else if (enemyDist < 300) {
      // Strafe + slight approach
      moveDx = edy / enemyDist + edx / enemyDist * 0.3;
      moveDy = -edx / enemyDist + edy / enemyDist * 0.3;
    } else {
      moveDx = edx / enemyDist;
      moveDy = edy / enemyDist;
    }
    inp.dx = moveDx;
    inp.dy = moveDy;

    // Aim with 5-15° error
    const aimAngle  = Math.atan2(edy, edx);
    const errorRad  = (5 + Math.random() * 10) * (Math.PI / 180);
    const aimFinal  = aimAngle + (Math.random() - 0.5) * errorRad * 2;
    inp.angle = aimFinal;

    // Shoot when roughly aimed and in range
    const angleDiff = Math.abs(((aimAngle - aimFinal) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
    inp.shooting = enemyDist < 400 && angleDiff < (25 * Math.PI / 180);

    // Brawler bots: use melee in close range
    if (bot.class === 'brawler' && enemyDist < MELEE_RANGE + enemy.radius + 10 && now >= bot.skills.melee) {
      inp.skills.melee = true;
      inp.shooting = false;
    }

    // Grenade
    if (bot.class !== 'brawler' && now >= bs.nextGrenadeAt && enemyDist < 500) {
      inp.skills.grenade = true;
      inp.grenadeTarget = { x: enemy.x, y: enemy.y };
      bs.nextGrenadeAt = now + 8000 + Math.random() * 4000;
    }

  } else {
    // Wander
    if (!bs.wanderDir || Math.random() < 0.008) {
      const a = Math.random() * Math.PI * 2;
      bs.wanderDir = { dx: Math.cos(a), dy: Math.sin(a) };
    }
    inp.dx = bs.wanderDir.dx;
    inp.dy = bs.wanderDir.dy;
    inp.shooting = false;
  }

  // Skill: dash/heal when low HP
  const hpPct = bot.hp / bot.maxHP;
  if (hpPct < 0.5) {
    if (Math.random() < 0.02 && now >= bot.skills.dash)  inp.skills.dash = true;
    if (Math.random() < 0.02 && now >= bot.skills.heal)  inp.skills.heal = true;
  }
  // Shield when damaged and unlucky
  if (hpPct < 0.7 && Math.random() < 0.005 && now >= bot.skills.shield) {
    inp.skills.shield = true;
  }
}

function clampBotsPerTeam(n) {
  const v = parseInt(n, 10);
  if (Number.isNaN(v)) return 2;
  return Math.max(0, Math.min(4, v));
}

// ── Room factory ──────────────────────────────────────────────
function createRoom(id, gameMode, mapId, creatorId, botsPerTeam) {
  const mapCfg   = MAP_CONFIGS[mapId] || MAP_CONFIGS.warehouse;
  const safeMode = KILL_GOALS[gameMode] ? gameMode : 'tdm';

  const weaponPickups = new Map();
  mapCfg.weaponSpawns.forEach((pos, idx) => {
    weaponPickups.set(idx, {
      id: idx, type: Math.random() < 0.5 ? 'shotgun' : 'machinegun',
      x: pos.x, y: pos.y, active: true, respawnAt: 0,
    });
  });

  const items = new Map();
  const now0  = Date.now();
  mapCfg.itemSpawns.forEach((pos, idx) => {
    items.set(idx, {
      id: idx, type: null, x: pos.x, y: pos.y, active: false,
      spawnAt: now0 + 5000 + Math.random() * 10000,
    });
  });

  let flags = null;
  if (safeMode === 'ctf') {
    flags = {
      red:  { x: mapCfg.redFlagPos.x,  y: mapCfg.redFlagPos.y,  homeX: mapCfg.redFlagPos.x,  homeY: mapCfg.redFlagPos.y,  carrierId: null, dropped: false, dropAt: 0 },
      blue: { x: mapCfg.blueFlagPos.x, y: mapCfg.blueFlagPos.y, homeX: mapCfg.blueFlagPos.x, homeY: mapCfg.blueFlagPos.y, carrierId: null, dropped: false, dropAt: 0 },
    };
  }

  const room = {
    id, gameMode: safeMode, mapId,
    walls: mapCfg.walls, worldW: mapCfg.width, worldH: mapCfg.height,
    players: new Map(),
    bullets: new Map(), bulletIdCounter: 0,
    grenades: new Map(), grenadeIdCounter: 0,
    explosions: [], streakEvents: [], meleeEvents: [],
    scores: { red: 0, blue: 0 },
    killFeed: [], gameOver: false, winner: null,
    killGoal: KILL_GOALS[safeMode],
    weaponPickups, items, flags,
    botsPerTeam: clampBotsPerTeam(botsPerTeam),
    // Room metadata
    name: generateRoomName(),
    code: generateRoomCode(),
    status: 'waiting',
    creatorId: creatorId || null,
  };

  return room;
}

function getOrCreateRoom(gameMode, mapId, creatorId) {
  for (const [, r] of rooms) {
    if (!r.gameOver && r.status === 'waiting' && r.gameMode === gameMode && r.mapId === mapId) {
      let humanCount = 0;
      for (const [, p] of r.players) if (!p.isBot) humanCount++;
      if (humanCount < 8) return r;
    }
  }
  const r = createRoom(Date.now().toString(), gameMode, mapId, creatorId);
  rooms.set(r.id, r);
  return r;
}

// ── API: room list ────────────────────────────────────────────
app.get('/api/rooms', (_req, res) => {
  const list = [];
  for (const [, r] of rooms) {
    if (r.gameOver) continue;
    let humanCount = 0, totalCount = 0;
    for (const [, p] of r.players) {
      totalCount++;
      if (!p.isBot) humanCount++;
    }
    list.push({
      id: r.id, name: r.name, code: r.code,
      gameMode: r.gameMode, mapId: r.mapId,
      status: r.status, players: humanCount, total: totalCount,
      botsPerTeam: r.botsPerTeam ?? 2,
    });
  }
  res.json(list);
});

// ── Kill streak helper ────────────────────────────────────────
function applyStreakBonus(shooter, now, room) {
  const streak    = shooter.killStreak;
  let   eventName = null;

  if (streak === 3) {
    shooter.streakSpeedBoost = true;
    shooter.streakSpeedEnd   = now + STREAK_SPEED_DURATION;
    eventName = '킬링스프리';
  } else if (streak === 5) {
    shooter.streakCdMult = STREAK_CD_MULT;
    eventName = '도미네이팅';
  } else if (streak === 7) {
    for (const k of Object.keys(shooter.skills)) shooter.skills[k] = 0;
    shooter.streakCdMult = STREAK_CD_MULT;
    shooter.shootAt = 0;
    eventName = '갓라이크';
  }

  if (eventName) {
    room.streakEvents.push({ playerId: shooter.id, playerName: shooter.name, streak, team: shooter.team, name: eventName });
  }
}

// ── Kill/death handler ────────────────────────────────────────
function handleDeath(victim, killerOrNull, room, now, weapon) {
  victim.hp = 0; victim.alive = false; victim.deaths++;
  victim.respawnAt = now + RESPAWN_MS;

  if (victim.hasFlag && room.flags) {
    dropCarriedFlag(victim, room);
  }
  victim.killStreak = 0; victim.streakCdMult = 1.0; victim.streakSpeedBoost = false;

  const killer = killerOrNull;
  if (killer) {
    killer.kills++; killer.killStreak++;
    applyStreakBonus(killer, now, room);
    if (room.gameMode === 'tdm') {
      room.scores[killer.team]++;
      if (room.scores[killer.team] >= room.killGoal) { room.gameOver = true; room.winner = killer.team; }
    }
    room.killFeed.unshift({ type: 'kill', k: killer.name, kt: killer.team, v: victim.name, vt: victim.team, w: weapon || 'bullet' });
    if (room.killFeed.length > MAX_FEED) room.killFeed.pop();
  }
}

// ── Collision helpers ─────────────────────────────────────────
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function resolveCircleRect(circle, r, rect) {
  const cx = clamp(circle.x, rect.x, rect.x + rect.w);
  const cy = clamp(circle.y, rect.y, rect.y + rect.h);
  const dx = circle.x - cx, dy = circle.y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < r && dist > 0) { circle.x += (dx / dist) * (r - dist); circle.y += (dy / dist) * (r - dist); }
}

function bulletHitsWall(b, walls) {
  for (const w of walls) {
    if (b.x >= w.x && b.x <= w.x + w.w && b.y >= w.y && b.y <= w.y + w.h) return true;
  }
  return false;
}

// ── Socket.io ─────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[connect]', socket.id);
  let room = null;

  // Ping/pong for latency
  socket.on('ping', (ts) => socket.emit('pong', ts));

  // List rooms
  socket.on('getRooms', () => {
    const list = [];
    for (const [, r] of rooms) {
      if (r.gameOver) continue;
      let humanCount = 0, totalCount = 0;
      for (const [, p] of r.players) { totalCount++; if (!p.isBot) humanCount++; }
      list.push({
        id: r.id, name: r.name, code: r.code, gameMode: r.gameMode, mapId: r.mapId,
        status: r.status, players: humanCount, total: totalCount, botsPerTeam: r.botsPerTeam ?? 2,
      });
    }
    socket.emit('roomList', list);
  });

  // Create a room (client gets back room info, then calls joinGame with roomId)
  socket.on('createRoom', ({ gameMode, mapId, botsPerTeam }) => {
    const validMode = KILL_GOALS[gameMode] ? gameMode : 'tdm';
    const validMap  = MAP_CONFIGS[mapId]   ? mapId    : 'warehouse';
    const bots      = clampBotsPerTeam(botsPerTeam);
    const r = createRoom(Date.now().toString() + '_' + socket.id.slice(0, 4), validMode, validMap, socket.id, bots);
    rooms.set(r.id, r);
    socket.emit('roomCreated', { id: r.id, name: r.name, code: r.code, gameMode: r.gameMode, mapId: r.mapId, botsPerTeam: r.botsPerTeam });
    console.log(`[createRoom] ${r.name} (${r.code}) mode=${validMode} map=${validMap} botsPerTeam=${r.botsPerTeam}`);
  });

  socket.on('joinGame', ({ name, class: playerClass, mode, map: mapId, roomId, roomCode }) => {
    const validClass = CLASS_STATS[playerClass] ? playerClass : 'soldier';
    const validMode  = KILL_GOALS[mode]         ? mode        : 'tdm';
    const validMap   = MAP_CONFIGS[mapId]        ? mapId       : 'warehouse';

    // Find target room
    if (roomId && rooms.has(roomId)) {
      room = rooms.get(roomId);
    } else if (roomCode) {
      for (const [, r] of rooms) if (r.code === roomCode.toUpperCase()) { room = r; break; }
    }
    if (!room) room = getOrCreateRoom(validMode, validMap, socket.id);

    let redCount = 0, blueCount = 0;
    for (const [, p] of room.players) { if (!p.isBot) { p.team === 'red' ? redCount++ : blueCount++; } }
    const team = redCount <= blueCount ? 'red' : 'blue';

    const player = makePlayer(socket.id, name || 'Player', team, validClass, room);
    room.players.set(socket.id, player);
    room.status = 'playing';

    // Rebalance bots after human joins
    balanceBots(room);

    socket.join(room.id);
    socket.emit('gameJoined', {
      playerId: socket.id, team, roomId: room.id,
      walls: room.walls, gameWidth: room.worldW, gameHeight: room.worldH,
      killGoal: room.killGoal, gameMode: room.gameMode, mapId: room.mapId,
      roomName: room.name, roomCode: room.code,
    });

    console.log(`[join] ${name} (${validClass}) → room ${room.name}(${room.code}) mode=${validMode} team=${team} (${room.players.size})`);
  });

  socket.on('input', (input) => {
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) player.input = input;
  });

  socket.on('disconnect', () => {
    if (room) {
      removePlayerFromRoom(room, socket.id);
      // Rebalance bots after human leaves
      if (room.players.size > 0) {
        balanceBots(room);
      } else {
        rooms.delete(room.id);
      }
    }
    console.log('[disconnect]', socket.id);
  });
});

// ── Game loop ─────────────────────────────────────────────────
let gameTick = 0;
setInterval(() => {
  const dt  = TICK_MS / 1000;
  const now = Date.now();
  gameTick++;
  const runBotAI = (gameTick % 2) === 0;

  for (const [, room] of rooms) {
    if (room.gameOver) continue;

    room.explosions.length   = 0;
    room.streakEvents.length = 0;
    room.meleeEvents.length  = 0;

    // ── Weapon pickup respawn ──────────────────────────────
    for (const [, wp] of room.weaponPickups) {
      if (!wp.active && now >= wp.respawnAt) {
        wp.active = true;
        wp.type   = Math.random() < 0.5 ? 'shotgun' : 'machinegun';
      }
    }

    // ── Item respawn ───────────────────────────────────────
    for (const [, item] of room.items) {
      if (!item.active && now >= item.spawnAt) {
        item.active = true;
        item.type   = ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];
      }
    }

    // ── CTF: auto-return dropped flags after 15s ───────────
    if (room.flags) {
      for (const team of ['red', 'blue']) {
        const flag = room.flags[team];
        if (!flag) continue;
        if (flag.dropped && !flag.carrierId) {
          if (!flag.dropAt) flag.dropAt = now;
          if (now - flag.dropAt >= 15000) {
            flag.x = flag.homeX; flag.y = flag.homeY;
            flag.dropped = false; flag.dropAt = 0;
            room.killFeed.unshift({ type: 'flag', text: `${team === 'red' ? '🔴' : '🔵'} 깃발 자동 반환`, team });
            if (room.killFeed.length > MAX_FEED) room.killFeed.pop();
          }
        } else {
          flag.dropAt = 0;
        }
      }
    }

    // ── Bot AI (every 2nd tick) ────────────────────────────
    if (runBotAI) {
      for (const [, p] of room.players) {
        if (p.isBot && p.alive) updateBotAI(p, room, dt * 2, now);
      }
    }

    // ── Players ────────────────────────────────────────────
    for (const [, p] of room.players) {
      if (!p.alive) {
        if (p.respawnAt && now >= p.respawnAt) {
          const pos = spawnPos(p.team, room);
          p.x = pos.x; p.y = pos.y; p.hp = p.maxHP; p.alive = true; p.respawnAt = null;
          p.shielded = false; p.shieldEnd = 0;
          p.speedBoost = false; p.speedEnd = 0;
          p.weapon = 'pistol'; p.ammo = -1;
          if (p.class === 'assassin') p.dashCharges = p.maxDashCharges;
        }
        continue;
      }

      // Effect expiry
      if (p.shielded         && now >= p.shieldEnd)      p.shielded         = false;
      if (p.speedBoost       && now >= p.speedEnd)        p.speedBoost       = false;
      if (p.streakSpeedBoost && now >= p.streakSpeedEnd)  p.streakSpeedBoost = false;
      if (p.itemSpeedBoost   && now >= p.itemSpeedEnd)    p.itemSpeedBoost   = false;

      // Assassin dash charge regen
      if (p.class === 'assassin' && p.dashCharges < p.maxDashCharges && p.dashChargeRegenAt > 0 && now >= p.dashChargeRegenAt) {
        p.dashCharges++;
        p.dashChargeRegenAt = p.dashCharges < p.maxDashCharges ? now + SKILL_CD.dash * p.streakCdMult : 0;
        p.skills.dash = p.dashChargeRegenAt; // update HUD display
      }

      // Medic passive regen
      if (p.class === 'medic' && p.hp < p.maxHP) {
        p.hp = Math.min(p.maxHP, p.hp + MEDIC_REGEN_RATE * dt);
      }

      // Move carried flag
      if (p.hasFlag && room.flags) {
        const flag = room.flags[p.hasFlag];
        if (flag) { flag.x = p.x; flag.y = p.y; }
      }

      const inp        = p.input;
      const { dx, dy, shooting, angle } = inp;
      const inputSkills = inp.skills || {};
      const cdMult      = p.streakCdMult;

      // ── Skill: dash ────────────────────────────────────────
      if (inputSkills.dash) {
        const canDash = p.class === 'assassin' ? p.dashCharges > 0 : now >= p.skills.dash;
        if (canDash) {
          if (p.class === 'assassin') {
            p.dashCharges--;
            if (p.dashChargeRegenAt === 0) p.dashChargeRegenAt = now + SKILL_CD.dash * cdMult;
            p.skills.dash = p.dashChargeRegenAt;
          } else {
            p.skills.dash = now + SKILL_CD.dash * cdMult;
          }
          const dashDist = p.class === 'assassin' ? ASSASSIN_DASH_DIST : DASH_DISTANCE;
          let dashAngle  = p.angle;
          if (dx !== 0 || dy !== 0) dashAngle = Math.atan2(dy, dx);
          p.x += Math.cos(dashAngle) * dashDist;
          p.y += Math.sin(dashAngle) * dashDist;
          p.x = clamp(p.x, p.radius, room.worldW - p.radius);
          p.y = clamp(p.y, p.radius, room.worldH - p.radius);
          for (const w of room.walls) resolveCircleRect(p, p.radius, w);
        }
      }

      // ── Skill: shield (not brawler) ────────────────────────
      if (inputSkills.shield && p.class !== 'brawler' && now >= p.skills.shield) {
        p.skills.shield = now + SKILL_CD.shield * cdMult;
        p.shielded = true; p.shieldEnd = now + SHIELD_DURATION;
      }

      // ── Skill: grenade (not brawler) ───────────────────────
      if (inputSkills.grenade && p.class !== 'brawler' && now >= p.skills.grenade) {
        p.skills.grenade = now + SKILL_CD.grenade * cdMult;
        const gt    = inp.grenadeTarget || { x: p.x, y: p.y };
        const gdx   = gt.x - p.x, gdy = gt.y - p.y;
        const gdist = Math.sqrt(gdx * gdx + gdy * gdy);
        const maxRange = 700;
        const ratio = gdist > 0 ? Math.min(1, maxRange / gdist) : 0;
        const gvx = gdist > 0 ? (gdx * ratio) / (GRENADE_FUSE / 1000) : 0;
        const gvy = gdist > 0 ? (gdy * ratio) / (GRENADE_FUSE / 1000) : 0;
        const gid = room.grenadeIdCounter++;
        room.grenades.set(gid, {
          id: gid, ownerId: p.id, ownerName: p.name, team: p.team,
          x: p.x, y: p.y, vx: gvx, vy: gvy, explodeAt: now + GRENADE_FUSE,
        });
      }

      // ── Skill: heal ────────────────────────────────────────
      if (inputSkills.heal && now >= p.skills.heal) {
        p.skills.heal = now + SKILL_CD.heal * cdMult;
        const healAmt = p.class === 'medic' ? MEDIC_HEAL_AMOUNT : HEAL_AMOUNT;
        p.hp = Math.min(p.maxHP, p.hp + healAmt);
      }

      // ── Skill: speed ───────────────────────────────────────
      if (inputSkills.speed && now >= p.skills.speed) {
        p.skills.speed = now + SKILL_CD.speed * cdMult;
        p.speedBoost = true; p.speedEnd = now + SPEED_DURATION;
      }

      // ── Skill: melee (brawler E) ───────────────────────────
      if (inputSkills.melee && p.class === 'brawler' && now >= p.skills.melee) {
        p.skills.melee = now + SKILL_CD.melee * cdMult;
        room.meleeEvents.push({ x: p.x, y: p.y, angle: p.angle, team: p.team });

        for (const [, target] of room.players) {
          if (!target.alive || target.id === p.id || target.team === p.team || target.shielded) continue;
          const tdx = target.x - p.x, tdy = target.y - p.y;
          const dist = Math.hypot(tdx, tdy);
          if (dist > MELEE_RANGE + target.radius) continue;

          let angDiff = Math.atan2(tdy, tdx) - p.angle;
          angDiff = ((angDiff + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          if (Math.abs(angDiff) > MELEE_HALF_CONE) continue;

          target.hp -= MELEE_DAMAGE;
          if (target.hp <= 0) handleDeath(target, p, room, now, 'melee');
        }
      }

      // ── Skill: brawlerQ (shotgun burst) ────────────────────
      if (inputSkills.brawlerQ && p.class === 'brawler' && now >= p.skills.brawlerQ) {
        p.skills.brawlerQ = now + SKILL_CD.brawlerQ * cdMult;
        for (let pi = 0; pi < BRAWLER_Q_PELLETS; pi++) {
          const t = (pi / (BRAWLER_Q_PELLETS - 1)) * 2 - 1;
          const pellAngle = p.angle + t * BRAWLER_Q_SPREAD;
          const bid = room.bulletIdCounter++;
          room.bullets.set(bid, {
            id: bid, ownerId: p.id, ownerName: p.name, team: p.team,
            x: p.x + Math.cos(p.angle) * (p.radius + 6),
            y: p.y + Math.sin(p.angle) * (p.radius + 6),
            vx: Math.cos(pellAngle) * BRAWLER_Q_SPEED,
            vy: Math.sin(pellAngle) * BRAWLER_Q_SPEED,
            damage: BRAWLER_Q_DAMAGE, life: BRAWLER_Q_RANGE_MS,
          });
        }
      }

      // ── Movement ───────────────────────────────────────────
      let speed = p.baseSpeed;
      if (p.speedBoost)       speed *= SPEED_MULT;
      if (p.streakSpeedBoost) speed *= STREAK_SPEED_MULT;
      if (p.itemSpeedBoost)   speed *= ITEM_SPEED_MULT;

      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) { p.x += (dx / len) * speed * dt; p.y += (dy / len) * speed * dt; }
      p.angle = angle;
      p.x = clamp(p.x, p.radius, room.worldW - p.radius);
      p.y = clamp(p.y, p.radius, room.worldH - p.radius);
      for (const w of room.walls) resolveCircleRect(p, p.radius, w);

      // ── Weapon pickup ──────────────────────────────────────
      if (p.class !== 'brawler') {
        for (const [, wp] of room.weaponPickups) {
          if (!wp.active) continue;
          const pdx = p.x - wp.x, pdy = p.y - wp.y;
          if (pdx * pdx + pdy * pdy < (p.radius + PICKUP_RADIUS) ** 2) {
            p.weapon = wp.type; p.ammo = WEAPON_STATS[wp.type].ammo;
            wp.active = false; wp.respawnAt = now + WEAPON_RESPAWN_MS;
            break;
          }
        }
      }

      // ── Item pickup ────────────────────────────────────────
      for (const [, item] of room.items) {
        if (!item.active) continue;
        const pdx = p.x - item.x, pdy = p.y - item.y;
        if (pdx * pdx + pdy * pdy < (p.radius + PICKUP_RADIUS) ** 2) {
          item.active  = false;
          item.spawnAt = now + ITEM_RESPAWN_MIN_MS + Math.random() * (ITEM_RESPAWN_MAX_MS - ITEM_RESPAWN_MIN_MS);
          if      (item.type === 'hp')     p.hp = Math.min(p.maxHP, p.hp + ITEM_HP_AMOUNT);
          else if (item.type === 'speed')  { p.itemSpeedBoost = true; p.itemSpeedEnd = now + ITEM_SPEED_DURATION; }
          else if (item.type === 'shield') { p.shielded = true; p.shieldEnd = Math.max(p.shieldEnd, now + ITEM_SHIELD_DURATION); }
          break;
        }
      }

      // ── CTF flag interactions ──────────────────────────────
      if (room.flags) {
        const enemyTeam = p.team === 'red' ? 'blue' : 'red';
        const enemyFlag = room.flags[enemyTeam];
        const ownFlag   = room.flags[p.team];

        // Heal stuck carrier refs (bot removed / desync)
        if (enemyFlag && enemyFlag.carrierId && !room.players.has(enemyFlag.carrierId)) {
          enemyFlag.carrierId = null;
          enemyFlag.dropped = true;
          if (!enemyFlag.dropAt) enemyFlag.dropAt = now;
        }
        if (ownFlag && ownFlag.carrierId && !room.players.has(ownFlag.carrierId)) {
          ownFlag.carrierId = null;
          ownFlag.dropped = true;
          if (!ownFlag.dropAt) ownFlag.dropAt = now;
        }

        if (enemyFlag && !p.hasFlag && !enemyFlag.carrierId) {
          const fdx = p.x - enemyFlag.x, fdy = p.y - enemyFlag.y;
          if (fdx * fdx + fdy * fdy < (p.radius + FLAG_PICKUP_RADIUS) ** 2) {
            enemyFlag.carrierId = p.id; p.hasFlag = enemyTeam;
            room.killFeed.unshift({ type: 'flag', text: `${p.name} 가 ${enemyTeam === 'red' ? '🔴' : '🔵'} 깃발 획득!`, team: p.team });
            if (room.killFeed.length > MAX_FEED) room.killFeed.pop();
          }
        }

        if (ownFlag && ownFlag.dropped && !p.hasFlag) {
          const fdx = p.x - ownFlag.x, fdy = p.y - ownFlag.y;
          if (fdx * fdx + fdy * fdy < (p.radius + FLAG_PICKUP_RADIUS) ** 2) {
            ownFlag.x = ownFlag.homeX; ownFlag.y = ownFlag.homeY; ownFlag.dropped = false;
            room.killFeed.unshift({ type: 'flag', text: `${p.name} 가 ${p.team === 'red' ? '🔴' : '🔵'} 깃발 반환!`, team: p.team });
            if (room.killFeed.length > MAX_FEED) room.killFeed.pop();
          }
        }

        // Capture: own flag must be safe at home; generous base radius
        if (p.hasFlag && ownFlag && !ownFlag.carrierId && !ownFlag.dropped) {
          const fdx = p.x - ownFlag.homeX, fdy = p.y - ownFlag.homeY;
          if (fdx * fdx + fdy * fdy < (p.radius + FLAG_CAPTURE_RADIUS) ** 2) {
            room.scores[p.team]++;
            const capturedFlag = room.flags[p.hasFlag];
            capturedFlag.x = capturedFlag.homeX; capturedFlag.y = capturedFlag.homeY;
            capturedFlag.carrierId = null; capturedFlag.dropped = false;
            p.hasFlag = null;
            room.killFeed.unshift({ type: 'flag', text: `${p.name} 깃발 점령! ${p.team === 'red' ? '🔴' : '🔵'} +1`, team: p.team });
            if (room.killFeed.length > MAX_FEED) room.killFeed.pop();
            if (room.scores[p.team] >= room.killGoal) { room.gameOver = true; room.winner = p.team; }
          }
        }
      }

      // ── Shoot (not brawler) ────────────────────────────────
      if (p.class !== 'brawler' && shooting && now >= p.shootAt) {
        const cs  = CLASS_STATS[p.class];
        const ws  = WEAPON_STATS[p.weapon] || WEAPON_STATS.pistol;
        const fireRate    = ws.fireRate    !== null ? ws.fireRate    : cs.fireRate;
        const bulletSpeed = ws.bulletSpeed !== null ? ws.bulletSpeed : cs.bulletSpeed;
        const damage      = ws.damage      !== null ? ws.damage      : cs.bulletDamage;
        const pellets     = ws.pellets;
        const spread      = ws.spread;
        const canShoot    = (p.ammo === -1) || (p.ammo > 0);

        if (canShoot) {
          p.shootAt = now + fireRate;
          if (p.ammo > 0) { p.ammo--; if (p.ammo <= 0) { p.weapon = 'pistol'; p.ammo = -1; } }

          for (let pi = 0; pi < pellets; pi++) {
            let pellAngle;
            if (pellets === 1) {
              pellAngle = angle + (Math.random() - 0.5) * spread * 2;
            } else {
              const t = (pi / (pellets - 1)) * 2 - 1;
              pellAngle = angle + t * spread;
            }
            const bx = p.x + Math.cos(angle) * (p.radius + 6);
            const by = p.y + Math.sin(angle) * (p.radius + 6);
            const bid = room.bulletIdCounter++;
            room.bullets.set(bid, {
              id: bid, ownerId: p.id, ownerName: p.name, team: p.team,
              x: bx, y: by,
              vx: Math.cos(pellAngle) * bulletSpeed,
              vy: Math.sin(pellAngle) * bulletSpeed,
              damage, life: 2.0,
            });
          }
        }
      }
    }

    // ── Bullets ────────────────────────────────────────────
    for (const [bid, b] of room.bullets) {
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;

      if (b.life <= 0 || b.x < 0 || b.x > room.worldW || b.y < 0 || b.y > room.worldH) {
        room.bullets.delete(bid); continue;
      }
      if (bulletHitsWall(b, room.walls)) { room.bullets.delete(bid); continue; }

      let hit = false;
      for (const [, p] of room.players) {
        if (!p.alive || p.id === b.ownerId || p.team === b.team) continue;
        const ddx = b.x - p.x, ddy = b.y - p.y;
        if (Math.sqrt(ddx * ddx + ddy * ddy) < p.radius + BULLET_RADIUS) {
          hit = true;
          if (p.shielded) break;

          p.hp -= b.damage;
          if (p.hp <= 0) {
            const shooter = room.players.get(b.ownerId);
            handleDeath(p, shooter || null, room, now, b.weapon || 'bullet');
          }
          break;
        }
      }
      if (hit) { room.bullets.delete(bid); }
    }

    // ── Grenades ───────────────────────────────────────────
    for (const [gid, g] of room.grenades) {
      g.x += g.vx * dt; g.y += g.vy * dt;

      if (now >= g.explodeAt) {
        room.grenades.delete(gid);
        room.explosions.push({ x: g.x, y: g.y, radius: GRENADE_RADIUS, team: g.team });

        for (const [, p] of room.players) {
          if (!p.alive || p.team === g.team || p.shielded) continue;
          const dx = p.x - g.x, dy = p.y - g.y;
          if (Math.sqrt(dx * dx + dy * dy) <= GRENADE_RADIUS + p.radius) {
            p.hp -= GRENADE_DAMAGE;
            if (p.hp <= 0) {
              const thrower = room.players.get(g.ownerId);
              handleDeath(p, thrower || null, room, now, 'grenade');
            }
          }
        }
      }
    }

    // ── Broadcast state ─────────────────────────────────────
    const state = {
      players: [], bullets: [], grenades: [],
      explosions:   room.explosions,
      meleeEvents:  room.meleeEvents,
      scores:       room.scores,
      killFeed:     room.killFeed.slice(0, 5),
      gameOver:     room.gameOver, winner: room.winner,
      streakEvents: room.streakEvents.slice(),
      ts: now,
    };

    for (const [, p] of room.players) {
      state.players.push({
        id: p.id, name: p.name, team: p.team, isBot: p.isBot || false,
        x: Math.round(p.x), y: Math.round(p.y), hp: p.hp, maxHP: p.maxHP,
        alive: p.alive, angle: p.angle,
        kills: p.kills, deaths: p.deaths, killStreak: p.killStreak,
        respawnAt: p.respawnAt,
        shielded: p.shielded, speedBoost: p.speedBoost,
        class: p.class, weapon: p.weapon, ammo: p.ammo,
        hasFlag: p.hasFlag,
        skillCooldowns: {
          dash:     p.class === 'assassin'
            ? (p.dashCharges > 0 ? 0 : Math.max(0, p.dashChargeRegenAt - now))
            : Math.max(0, p.skills.dash    - now),
          shield:   Math.max(0, p.skills.shield   - now),
          grenade:  Math.max(0, p.skills.grenade  - now),
          heal:     Math.max(0, p.skills.heal     - now),
          speed:    Math.max(0, p.skills.speed    - now),
          melee:    Math.max(0, p.skills.melee    - now),
          brawlerQ: Math.max(0, p.skills.brawlerQ - now),
        },
        dashCharges: p.dashCharges,
      });
    }
    for (const [, b] of room.bullets) {
      state.bullets.push({ id: b.id, team: b.team, x: Math.round(b.x), y: Math.round(b.y) });
    }
    for (const [, g] of room.grenades) {
      state.grenades.push({ id: g.id, team: g.team, x: g.x, y: g.y, explodeAt: g.explodeAt });
    }

    state.weaponPickups = [];
    for (const [, wp] of room.weaponPickups) {
      if (wp.active) state.weaponPickups.push({ id: wp.id, type: wp.type, x: wp.x, y: wp.y });
    }

    state.items = [];
    for (const [, item] of room.items) {
      if (item.active) state.items.push({ id: item.id, type: item.type, x: item.x, y: item.y });
    }

    state.flags = room.flags ? {
      red:  { x: room.flags.red.x,  y: room.flags.red.y,  homeX: room.flags.red.homeX,  homeY: room.flags.red.homeY,  carrierId: room.flags.red.carrierId,  dropped: room.flags.red.dropped  },
      blue: { x: room.flags.blue.x, y: room.flags.blue.y, homeX: room.flags.blue.homeX, homeY: room.flags.blue.homeY, carrierId: room.flags.blue.carrierId, dropped: room.flags.blue.dropped },
    } : null;

    io.to(room.id).emit('state', state);
  }
}, TICK_MS);

// ── Start ─────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Cloudflare quick tunnel: useful for local sharing; skip on PaaS (Render/Railway/Fly)
function shouldStartTunnel() {
  if (process.env.ENABLE_TUNNEL === '0' || process.env.ENABLE_TUNNEL === 'false') return false;
  if (process.env.ENABLE_TUNNEL === '1' || process.env.ENABLE_TUNNEL === 'true') return true;
  return !(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`⚠️  Port ${PORT} in use, retrying in 3s...`);
    setTimeout(() => server.listen(PORT, HOST), 3000);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

server.listen(PORT, HOST, () => {
  const msg = `\n🎮 Team Battle Game  →  http://${HOST}:${PORT}\n`;
  console.log(msg);
  try {
    fs.writeFileSync(path.join(__dirname, 'server.log'), msg);
  } catch (_) {
    // ignore (some hosts have read-only FS)
  }
  if (!shouldStartTunnel()) {
    shareStatus = 'error';
    console.log('📡 Share tunnel disabled (public host URL is enough)\n');
    return;
  }
  // Auto-start one tunnel on boot; hosts can mint a fresh URL via POST /api/share-url/refresh
  tunnelGeneration += 1;
  shareStatus = 'connecting';
  startTunnel(tunnelGeneration);
});
