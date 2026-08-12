'use strict';

// ── Game server (hybrid: Netlify frontend → Render Socket.io) ──
function getGameServerUrl() {
  try {
    const fromWindow = (typeof window !== 'undefined' && window.GAME_SERVER_URL)
      ? String(window.GAME_SERVER_URL).trim()
      : '';
    const fromLs = localStorage.getItem('GAME_SERVER_URL');
    const raw = fromWindow || (fromLs ? String(fromLs).trim() : '') || '';
    return raw.replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

function apiUrl(path) {
  const base = getGameServerUrl();
  const p = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${p}` : p;
}

/** Public page friends should open (Netlify / HTTPS deploy). null → use local tunnel. */
function getPublicInviteUrl() {
  if (getGameServerUrl()) return `${window.location.origin}/`;
  const host = window.location.hostname || '';
  if (
    window.location.protocol === 'https:' &&
    host &&
    host !== 'localhost' &&
    host !== '127.0.0.1'
  ) {
    return `${window.location.origin}/`;
  }
  return null;
}

const SOCKET_URL = getGameServerUrl();
const socket = io(SOCKET_URL || undefined, {
  transports: ['websocket', 'polling'],
});

// ── Helpers ───────────────────────────────────────────────────
function hexPath(g, cx, cy, r) {
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 3 * i - Math.PI / 6;
    const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.closePath();
}

function lerp(a, b, t) { return a + (b - a) * t; }

function lightenColor(hex, amt) {
  const r = Math.min(255, ((hex >> 16) & 0xff) + amt);
  const g = Math.min(255, ((hex >> 8)  & 0xff) + amt);
  const b = Math.min(255, ( hex        & 0xff) + amt);
  return (r << 16) | (g << 8) | b;
}

function darkenColor(hex, pct) {
  const r = ((hex >> 16) & 0xff) * (1 - pct);
  const g = ((hex >>  8) & 0xff) * (1 - pct);
  const b = (( hex      ) & 0xff) * (1 - pct);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

function blendColor(hex, target, pct) {
  const r = ((hex >> 16) & 0xff) * (1-pct) + ((target >> 16) & 0xff) * pct;
  const g = ((hex >>  8) & 0xff) * (1-pct) + ((target >>  8) & 0xff) * pct;
  const b = (( hex      ) & 0xff) * (1-pct) + (( target      ) & 0xff) * pct;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

function brightenColor(hex, pct) {
  const r = Math.min(255, ((hex >> 16) & 0xff) + 255 * pct * 0.5);
  const g = Math.min(255, ((hex >>  8) & 0xff) + 255 * pct * 0.5);
  const b = Math.min(255, (( hex      ) & 0xff) + 255 * pct * 0.25);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

/** localStorage override: 'pc' | 'touch' | absent (= auto) */
const CONTROLS_PREF_KEY = 'tbg_controls_pref';

function getControlsPref() {
  try {
    const v = localStorage.getItem(CONTROLS_PREF_KEY);
    return v === 'pc' || v === 'touch' ? v : null;
  } catch (_) { return null; }
}

function setControlsPref(mode) {
  try {
    if (mode === 'pc' || mode === 'touch') localStorage.setItem(CONTROLS_PREF_KEY, mode);
    else localStorage.removeItem(CONTROLS_PREF_KEY);
  } catch (_) { /* ignore */ }
}

/** Real phones / tablets (incl. iPadOS desktop-UA spoof). Not Windows/macOS touchscreens. */
function isPhoneOrTabletOS() {
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const maxTouch = navigator.maxTouchPoints || 0;
  if (/Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return true;
  if (/iPad/i.test(ua)) return true;
  // iPadOS 13+: Macintosh UA + multi-touch
  if (platform === 'MacIntel' && maxTouch > 1) return true;
  if (navigator.userAgentData && navigator.userAgentData.mobile) return true;
  return false;
}

/** Desktop OS (Windows / macOS / Linux / ChromeOS). Touchscreen laptops still count. */
function isDesktopOS(game) {
  if (isPhoneOrTabletOS()) return false;
  if (game && game.device && game.device.os && game.device.os.desktop) return true;
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  if (/Win/i.test(platform) || /Windows NT/i.test(ua)) return true;
  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return true;
  if ((/Linux/i.test(platform) || /Linux/i.test(ua)) && !/Android/i.test(ua)) return true;
  if (/CrOS/i.test(ua)) return true;
  if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') {
    return !navigator.userAgentData.mobile;
  }
  return false;
}

/**
 * Auto-detect touch/joystick UI.
 * Desktop OS → always PC controls (even if touchscreen / maxTouchPoints > 0).
 * Phones & tablets → joysticks. Unknown → coarse/hover heuristics only.
 */
function detectTouchControls(game) {
  if (isPhoneOrTabletOS()) return true;
  if (isDesktopOS(game)) return false;
  const mq = (q) => (typeof window.matchMedia === 'function' ? window.matchMedia(q).matches : false);
  return !!(mq('(pointer: coarse)') || mq('(hover: none)'));
}

/** Touch / tablet UI: honor manual override, else auto-detect. Never trust maxTouchPoints alone. */
function prefersTouchControls(game) {
  const pref = getControlsPref();
  if (pref === 'touch') return true;
  if (pref === 'pc') return false;
  return detectTouchControls(game);
}

function controlsModeLabel(game) {
  return prefersTouchControls(game) ? '터치' : 'PC';
}

function touchUiScale(width, height) {
  const short = Math.min(width, height);
  // Phones ~1.0; large tablets up to ~1.4 so joysticks/skills stay usable
  return Math.min(1.4, Math.max(1, short / 720));
}

// ═════════════════════════════════════════════════════════════
// MENU SCENE
// ═════════════════════════════════════════════════════════════
class MenuScene extends Phaser.Scene {
  constructor() { super('Menu'); }

  create() {
    const W = this.scale.width, H = this.scale.height;

    this.selectedClass = 'soldier';
    this.selectedMode  = 'tdm';
    this.selectedMap   = 'warehouse';
    this._classBorderDrawers = [];
    this._modeDrawers = [];
    this._mapDrawers  = [];

    // Background
    this.add.graphics()
      .fillGradientStyle(0x03030f, 0x03030f, 0x07071e, 0x07071e, 1)
      .fillRect(0, 0, W, H);

    const hg = this.add.graphics();
    const R = 38, hW = R * Math.sqrt(3), hH = R * 1.5;
    for (let row = -1; row < Math.ceil(H / hH) + 2; row++) {
      for (let col = -1; col < Math.ceil(W / hW) + 2; col++) {
        const cx = col * hW + (row % 2 ? hW / 2 : 0);
        const cy = row * hH;
        hg.lineStyle(1, 0x1a2a44, 0.35);
        hexPath(hg, cx, cy, R - 1);
        hg.strokePath();
      }
    }

    // Pulsing hex overlay
    this._hexPulse = 0;
    this._hexOverlay = this.add.graphics();

    this.particles = [];
    for (let i = 0; i < 55; i++) {
      const g = this.add.graphics();
      g.fillStyle(Math.random() > 0.5 ? 0x88aaff : 0xff6688, Math.random() * 0.55 + 0.1);
      g.fillCircle(0, 0, Math.random() * 1.8 + 0.4);
      g.setPosition(Math.random() * W, Math.random() * H);
      this.particles.push({ gfx: g, vy: -(Math.random() * 0.3 + 0.06) });
    }

    // Title
    [14, 9, 5].forEach((thick, i) => {
      this.add.text(W / 2, H * 0.09, 'TEAM BATTLE', {
        fontSize: Math.min(56, W * 0.1) + 'px', fontFamily: '"Orbitron", "Arial Black", Arial',
        color: '#00000000',
        stroke: `rgba(255,${30 + i * 50},${50 + i * 30},${0.18 + i * 0.12})`,
        strokeThickness: thick,
      }).setOrigin(0.5);
    });
    this.add.text(W / 2, H * 0.09, 'TEAM BATTLE', {
      fontSize: Math.min(56, W * 0.1) + 'px', fontFamily: '"Orbitron", "Arial Black", Arial',
      color: '#ffffff', stroke: '#cc1133', strokeThickness: 3,
    }).setOrigin(0.5);

    this.add.text(W / 2, H * 0.155, '온라인  ·  2팀  ·  탑다운 슈터', {
      fontSize: '14px', fontFamily: '"Rajdhani", "Courier New", monospace',
      color: '#4a6088', letterSpacing: 3,
    }).setOrigin(0.5);

    this._serverStatus = this.add.text(W / 2, H * 0.178, '', {
      fontSize: '11px', fontFamily: '"Rajdhani", "Courier New", monospace',
      color: '#5a7a9a', letterSpacing: 1,
    }).setOrigin(0.5);
    this._bindServerStatus();

    // Separator
    this.add.graphics().lineStyle(1, 0x223344, 0.7).lineBetween(W * 0.05, H * 0.205, W * 0.95, H * 0.205);

    // Class selection
    this.add.text(W / 2, H * 0.228, '클래스 선택', {
      fontSize: '11px', fontFamily: '"Rajdhani", "Courier New"', color: '#4a6088', letterSpacing: 4,
    }).setOrigin(0.5);
    this.buildClassCards(H * 0.295);

    // Mode selection
    this.add.text(W / 2, H * 0.395, '게임 모드', {
      fontSize: '11px', fontFamily: '"Rajdhani", "Courier New"', color: '#4a6088', letterSpacing: 4,
    }).setOrigin(0.5);
    this.buildModeButtons(H * 0.448);

    // Map selection
    this.add.text(W / 2, H * 0.518, '맵 선택', {
      fontSize: '11px', fontFamily: '"Rajdhani", "Courier New"', color: '#4a6088', letterSpacing: 4,
    }).setOrigin(0.5);
    this.buildMapCards(H * 0.572);

    // Separator
    this.add.graphics().lineStyle(1, 0x1a2a3a, 0.8).lineBetween(W * 0.05, H * 0.634, W * 0.95, H * 0.634);

    // Name input
    this.add.text(W / 2, H * 0.658, '닉네임', {
      fontSize: '11px', fontFamily: '"Rajdhani", "Courier New"', color: '#446688', letterSpacing: 4,
    }).setOrigin(0.5);
    this.nameInput = this.add.dom(W / 2, H * 0.7).createFromHTML(`
      <input id="nameInput" type="text" placeholder="이름을 입력하세요" maxlength="12"
        autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
        style="font-size:16px;padding:12px 18px;border-radius:6px;
               border:1px solid #224466;background:#07101e;color:#aaccee;
               outline:none;text-align:center;width:min(260px,70vw);min-height:44px;
               letter-spacing:2px;font-family:'Rajdhani','Courier New',monospace;
               -webkit-appearance:none;appearance:none;">
    `);

    // Start button → goes to Lobby
    this.buildStartButton(W / 2, H * 0.755);

    // Host share panel (fresh trycloudflare link per play session)
    this.buildInviteSection(W / 2, H * 0.855);

    // Controls hint + PC/터치 override toggle
    const ctrlY = H * 0.955;
    this.add.graphics().lineStyle(1, 0x1a2a3a, 1).lineBetween(W * 0.05, ctrlY - 10, W * 0.95, ctrlY - 10);
    this._ctrlHintTexts = [];
    this._refreshControlHints = () => {
      this._ctrlHintTexts.forEach(t => t.destroy());
      this._ctrlHintTexts = [];
      const touchUI = prefersTouchControls(this.sys.game);
      const hints = touchUI ? [
        { icon: '좌 조이스틱', desc: '이동', x: W * 0.22 },
        { icon: '우 조이스틱', desc: '조준/사격', x: W * 0.45 },
        { icon: '스킬 버튼', desc: '대시/스킬', x: W * 0.7 },
      ] : [
        { icon: 'WASD', desc: '이동', x: W * 0.2 },
        { icon: 'MOUSE', desc: '조준/사격', x: W * 0.38 },
        { icon: 'SHIFT', desc: '대시', x: W * 0.56 },
        { icon: 'E/Q/R/F', desc: '스킬', x: W * 0.74 },
        { icon: 'TAB', desc: '스코어보드', x: W * 0.9 },
      ];
      hints.forEach(({ icon, desc, x }) => {
        this._ctrlHintTexts.push(
          this.add.text(x, ctrlY + 1, icon, { fontSize: '9px', fontFamily: '"Courier New"', color: '#2a4a6a' }).setOrigin(0.5, 1),
          this.add.text(x, ctrlY + 3, desc, { fontSize: '10px', fontFamily: 'Arial', color: '#4466aa' }).setOrigin(0.5, 0),
        );
      });
      if (this._ctrlToggleLabel) {
        this._ctrlToggleLabel.setText(`조작: ${controlsModeLabel(this.sys.game)}`);
      }
    };
    this._ctrlToggleLabel = this.add.text(W * 0.05, ctrlY - 22, `조작: ${controlsModeLabel(this.sys.game)}`, {
      fontSize: '11px', fontFamily: '"Rajdhani", Arial', color: '#5a7a9a',
    }).setOrigin(0, 1).setInteractive({ useHandCursor: true });
    this._ctrlToggleLabel.on('pointerover', () => this._ctrlToggleLabel.setColor('#88aacc'));
    this._ctrlToggleLabel.on('pointerout', () => this._ctrlToggleLabel.setColor('#5a7a9a'));
    this._ctrlToggleLabel.on('pointerdown', () => {
      // Cycle: auto-default → flip explicit override between PC and touch
      const next = prefersTouchControls(this.sys.game) ? 'pc' : 'touch';
      setControlsPref(next);
      this._refreshControlHints();
    });
    this._refreshControlHints();

    if (this.input.keyboard) this.input.keyboard.on('keydown-ENTER', () => this.goToLobby());
  }

  buildClassCards(y) {
    const W = this.scale.width;
    const classes = [
      { id: 'soldier',  emoji: '⚔',  name: '전사',   hp: 180, spd: 200, desc: '균형형 (250ms)' },
      { id: 'sniper',   emoji: '🎯',  name: '저격수',  hp: 135, spd: 170, desc: '고데미지+느림' },
      { id: 'tank',     emoji: '🛡',  name: '탱커',   hp: 320, spd: 130, desc: '고HP+빠른발사' },
      { id: 'medic',    emoji: '💉',  name: '의무병',  hp: 160, spd: 185, desc: '회복60+재생' },
      { id: 'assassin', emoji: '🗡',  name: '암살자',  hp: 125, spd: 240, desc: '고속+2대시' },
      { id: 'brawler',  emoji: '👊',  name: '격투가',  hp: 250, spd: 180, desc: 'E:격투 Q:산탄' },
    ];

    const CW = Math.min(120, (W * 0.9 - 50) / 6);
    const CH = 72;
    const gap = Math.max(4, (W * 0.9 - CW * 6) / 5);
    const totalW = 6 * CW + 5 * gap;
    const sx = W / 2 - totalW / 2;

    this._classBorderDrawers = [];

    classes.forEach((cls, i) => {
      const cx = sx + i * (CW + gap) + CW / 2;
      const bx = cx - CW / 2, by = y - CH / 2;

      this.add.graphics().fillStyle(0x050d1a, 0.95).fillRoundedRect(bx, by, CW, CH, 6);

      const border = this.add.graphics();
      const draw = () => {
        border.clear();
        const sel = this.selectedClass === cls.id;
        if (sel) {
          border.fillStyle(0x181200, 0.5); border.fillRoundedRect(bx - 2, by - 2, CW + 4, CH + 4, 8);
          border.lineStyle(2.5, 0xffcc00, 1); border.strokeRoundedRect(bx, by, CW, CH, 6);
        } else {
          border.lineStyle(1, 0x2a3a4a, 0.6); border.strokeRoundedRect(bx, by, CW, CH, 6);
        }
      };
      this._classBorderDrawers.push(draw);
      draw();

      const zone = this.add.zone(cx, y, CW, CH).setInteractive();
      zone.on('pointerdown', () => { this.selectedClass = cls.id; this._classBorderDrawers.forEach(fn => fn()); });
      zone.on('pointerover', () => { if (this.selectedClass !== cls.id) { border.clear(); border.lineStyle(1.5, 0x4a6680, 0.85); border.strokeRoundedRect(bx, by, CW, CH, 6); } });
      zone.on('pointerout', () => draw());

      this.add.text(cx, by + 14, `${cls.emoji}`, { fontSize: '14px' }).setOrigin(0.5);
      this.add.text(cx, by + 31, cls.name, { fontSize: '11px', fontFamily: '"Rajdhani", "Arial Black"', color: '#cce8ff' }).setOrigin(0.5);
      this.add.text(cx, by + 47, `❤${cls.hp} 💨${cls.spd}`, { fontSize: '8px', fontFamily: '"Courier New"', color: '#6699aa' }).setOrigin(0.5);
      this.add.text(cx, by + 61, cls.desc, { fontSize: '7px', fontFamily: '"Courier New"', color: '#4d6e7a' }).setOrigin(0.5);
    });
  }

  buildModeButtons(y) {
    const W = this.scale.width;
    const modes = [
      { id: 'tdm', label: '⚔  팀 데스매치', desc: '15킬 선취팀 승리', col: 0xff4444 },
      { id: 'ctf', label: '🚩  깃발 점령',   desc: '깃발 5회 점령',  col: 0x4488ff },
    ];
    const BW = Math.min(220, (W * 0.72 - 16) / 2), BH = 48, gap = 18;
    const sx = W / 2 - (2 * BW + gap) / 2;
    this._modeDrawers = [];

    modes.forEach((mode, i) => {
      const cx = sx + i * (BW + gap) + BW / 2;
      const bx = cx - BW / 2, by = y - BH / 2;
      const bg = this.add.graphics(), border = this.add.graphics();
      const draw = () => {
        bg.clear(); border.clear();
        const sel = this.selectedMode === mode.id;
        bg.fillStyle(0x050d1a, sel ? 0.98 : 0.6); bg.fillRoundedRect(bx, by, BW, BH, 7);
        border.lineStyle(sel ? 2.5 : 1, mode.col, sel ? 0.95 : 0.3); border.strokeRoundedRect(bx, by, BW, BH, 7);
        if (sel) { border.lineStyle(7, mode.col, 0.1); border.strokeRoundedRect(bx - 3, by - 3, BW + 6, BH + 6, 9); }
      };
      this._modeDrawers.push(draw); draw();
      const zone = this.add.zone(cx, y, BW, BH).setInteractive();
      zone.on('pointerdown', () => { this.selectedMode = mode.id; this._modeDrawers.forEach(fn => fn()); });
      zone.on('pointerover', () => { if (this.selectedMode !== mode.id) { border.clear(); border.lineStyle(1.5, mode.col, 0.6); border.strokeRoundedRect(bx, by, BW, BH, 7); } });
      zone.on('pointerout', () => draw());
      this.add.text(cx, by + 14, mode.label, { fontSize: '13px', fontFamily: '"Rajdhani", "Arial Black"', color: '#ccddee' }).setOrigin(0.5);
      this.add.text(cx, by + 32, mode.desc, { fontSize: '10px', fontFamily: '"Courier New"', color: '#4a6088' }).setOrigin(0.5);
    });
  }

  buildMapCards(y) {
    const W = this.scale.width;
    const maps = [
      { id: 'warehouse', icon: '🏭', label: '창고',  desc: '1600×1200  산업형' },
      { id: 'arena',     icon: '🏟', label: '경기장', desc: '1200×900   개방형' },
      { id: 'maze',      icon: '🌀', label: '미로',  desc: '1400×1000  복도형' },
    ];
    const CW = Math.min(188, (W * 0.86 - 20) / 3), CH = 58, gap = Math.max(8, (W * 0.86 - CW * 3) / 2);
    const sx = W / 2 - (3 * CW + 2 * gap) / 2;
    this._mapDrawers = [];

    maps.forEach((mapCfg, i) => {
      const cx = sx + i * (CW + gap) + CW / 2;
      const bx = cx - CW / 2, by = y - CH / 2;
      this.add.graphics().fillStyle(0x050d1a, 0.95).fillRoundedRect(bx, by, CW, CH, 6);
      const border = this.add.graphics();
      const draw = () => {
        border.clear();
        const sel = this.selectedMap === mapCfg.id;
        if (sel) { border.fillStyle(0x001a14, 0.5); border.fillRoundedRect(bx - 2, by - 2, CW + 4, CH + 4, 8); border.lineStyle(2.5, 0x00ddaa, 0.95); border.strokeRoundedRect(bx, by, CW, CH, 6); }
        else { border.lineStyle(1, 0x2a3a4a, 0.6); border.strokeRoundedRect(bx, by, CW, CH, 6); }
      };
      this._mapDrawers.push(draw); draw();
      const zone = this.add.zone(cx, y, CW, CH).setInteractive();
      zone.on('pointerdown', () => { this.selectedMap = mapCfg.id; this._mapDrawers.forEach(fn => fn()); });
      zone.on('pointerover', () => { if (this.selectedMap !== mapCfg.id) { border.clear(); border.lineStyle(1.5, 0x33aa88, 0.7); border.strokeRoundedRect(bx, by, CW, CH, 6); } });
      zone.on('pointerout', () => draw());
      this.add.text(cx, by + 15, `${mapCfg.icon}  ${mapCfg.label}`, { fontSize: '13px', fontFamily: '"Rajdhani", "Arial Black"', color: '#cce8ff' }).setOrigin(0.5);
      this.add.text(cx, by + 36, mapCfg.desc, { fontSize: '9px', fontFamily: '"Courier New"', color: '#4d6e7a' }).setOrigin(0.5);
    });
  }

  buildStartButton(x, y) {
    const bW = 210, bH = 50, col = 0xee1133;
    const g = this.add.graphics();
    const draw = (hover) => {
      g.clear();
      g.fillStyle(col, hover ? 0.25 : 0.12); g.fillRoundedRect(x - bW / 2 - 10, y - bH / 2 - 10, bW + 20, bH + 20, 16);
      g.fillStyle(hover ? 0xff3355 : col, 1); g.fillRoundedRect(x - bW / 2, y - bH / 2, bW, bH, 8);
      g.fillStyle(0xffffff, 0.1); g.fillRoundedRect(x - bW / 2 + 5, y - bH / 2 + 4, bW - 10, bH / 2 - 6, 6);
    };
    draw(false);
    g.setInteractive(new Phaser.Geom.Rectangle(x - bW / 2, y - bH / 2, bW, bH), Phaser.Geom.Rectangle.Contains);
    g.on('pointerover', () => draw(true)); g.on('pointerout', () => draw(false)); g.on('pointerdown', () => this.goToLobby());
    const t = this.add.text(x, y, '⚔  전투 시작', { fontSize: '22px', fontFamily: '"Orbitron", "Arial Black"', color: '#ffffff', stroke: '#880022', strokeThickness: 2 }).setOrigin(0.5).setInteractive();
    t.on('pointerdown', () => this.goToLobby());
  }

  buildInviteSection(x, y) {
    const W = this.scale.width;
    const panW = Math.min(520, W * 0.92);
    const panH = 72;
    const bx = x - panW / 2;
    const by = y - panH / 2;

    const panel = this.add.graphics();
    panel.fillStyle(0x061018, 0.96);
    panel.fillRoundedRect(bx, by, panW, panH, 8);
    panel.lineStyle(1.5, 0x1a4060, 0.95);
    panel.strokeRoundedRect(bx, by, panW, panH, 8);

    this.add.text(x, by + 11, '게임 열기 (호스트)', {
      fontSize: '12px', fontFamily: '"Rajdhani", "Arial Black"', color: '#88ccee', letterSpacing: 1,
    }).setOrigin(0.5);

    const urlRowY = by + 34;
    const urlBoxW = panW - 168;
    const urlBoxH = 24;
    const urlBoxX = bx + 10;
    const urlBg = this.add.graphics();
    urlBg.fillStyle(0x04090f, 1);
    urlBg.fillRoundedRect(urlBoxX, urlRowY - urlBoxH / 2, urlBoxW, urlBoxH, 4);
    urlBg.lineStyle(1, 0x162840, 1);
    urlBg.strokeRoundedRect(urlBoxX, urlRowY - urlBoxH / 2, urlBoxW, urlBoxH, 4);

    this._inviteStatus = this.add.text(urlBoxX + urlBoxW / 2, urlRowY, '링크 생성 중...', {
      fontSize: '11px', fontFamily: '"Courier New"', color: '#3a6080',
    }).setOrigin(0.5);
    this._inviteUrlText = this.add.text(urlBoxX + 8, urlRowY, '', {
      fontSize: '11px', fontFamily: '"Courier New"', color: '#5ab0e0', fixedWidth: urlBoxW - 16,
    }).setOrigin(0, 0.5).setVisible(false);

    const copyW = 48, copyH = 24;
    const copyX = urlBoxX + urlBoxW + 8 + copyW / 2;
    const copyG = this.add.graphics();
    const drawCopyBtn = (hover) => {
      copyG.clear();
      if (!this._shareUrl) return;
      copyG.fillStyle(hover ? 0x1a4a6a : 0x0a2030, 1);
      copyG.fillRoundedRect(copyX - copyW / 2, urlRowY - copyH / 2, copyW, copyH, 4);
      copyG.lineStyle(1, hover ? 0x5ab0e0 : 0x2a6080, 1);
      copyG.strokeRoundedRect(copyX - copyW / 2, urlRowY - copyH / 2, copyW, copyH, 4);
    };
    this._drawCopyBtn = drawCopyBtn;
    this._copyG = copyG;
    this._copyLabel = this.add.text(copyX, urlRowY, '복사', {
      fontSize: '11px', fontFamily: '"Rajdhani", Arial', color: '#7ec8f0',
    }).setOrigin(0.5).setVisible(false);
    copyG.setInteractive(new Phaser.Geom.Rectangle(copyX - copyW / 2, urlRowY - copyH / 2, copyW, copyH), Phaser.Geom.Rectangle.Contains);
    copyG.on('pointerover', () => drawCopyBtn(true));
    copyG.on('pointerout', () => drawCopyBtn(false));
    copyG.on('pointerdown', () => {
      if (!this._shareUrl) return;
      navigator.clipboard.writeText(this._shareUrl).catch(() => {});
      this._copyLabel.setText('OK!');
      this.time.delayedCall(900, () => { if (this._copyLabel) this._copyLabel.setText('복사'); });
    });

    const refW = 92, refH = 24;
    const refX = copyX + copyW / 2 + 8 + refW / 2;
    const refG = this.add.graphics();
    const drawRefBtn = (hover) => {
      refG.clear();
      const busy = !!this._shareRefreshing;
      refG.fillStyle(busy ? 0x1a3040 : (hover ? 0x14553a : 0x0c3024), 1);
      refG.fillRoundedRect(refX - refW / 2, urlRowY - refH / 2, refW, refH, 4);
      refG.lineStyle(1, busy ? 0x3a6070 : (hover ? 0x44cc88 : 0x2a8860), 1);
      refG.strokeRoundedRect(refX - refW / 2, urlRowY - refH / 2, refW, refH, 4);
    };
    this._drawRefBtn = drawRefBtn;
    this._refG = refG;
    this._refLabel = this.add.text(refX, urlRowY, '새 링크 만들기', {
      fontSize: '10px', fontFamily: '"Rajdhani", Arial', color: '#66ddaa',
    }).setOrigin(0.5);
    drawRefBtn(false);
    refG.setInteractive(new Phaser.Geom.Rectangle(refX - refW / 2, urlRowY - refH / 2, refW, refH), Phaser.Geom.Rectangle.Contains);
    refG.on('pointerover', () => drawRefBtn(true));
    refG.on('pointerout', () => drawRefBtn(false));
    refG.on('pointerdown', () => this._refreshShareUrl());

    const inviteHint = getPublicInviteUrl()
      ? '이 페이지 주소를 친구에게 보내세요 (서버는 Render)'
      : '친구에게 이 링크를 보내세요';
    this.add.text(x, by + panH - 10, inviteHint, {
      fontSize: '10px', fontFamily: '"Rajdhani", Arial', color: '#3a6a88',
    }).setOrigin(0.5);

    this._shareUrl = null;
    this._shareRefreshing = false;
    this._pollShareUrl();
  }

  _bindServerStatus() {
    const set = (text, color) => {
      if (!this._serverStatus || !this.scene || !this.scene.isActive()) return;
      this._serverStatus.setText(text).setColor(color);
    };
    const refresh = () => {
      const base = getGameServerUrl();
      if (socket.connected) {
        set(base ? `서버 연결됨  ·  ${base.replace(/^https?:\/\//, '')}` : '서버 연결됨 (같은 출처)', '#44aa77');
        return;
      }
      if (!base && /netlify\.app$/i.test(window.location.hostname || '')) {
        set('서버 URL 없음 — Netlify env GAME_SERVER_URL 설정 필요', '#cc6644');
        return;
      }
      set(base ? `서버 연결 중…  ${base.replace(/^https?:\/\//, '')}` : '서버 연결 중…', '#887744');
    };
    refresh();
    socket.on('connect', refresh);
    socket.on('disconnect', () => set('서버 연결 끊김', '#cc6644'));
    socket.on('connect_error', () => {
      const base = getGameServerUrl();
      set(base ? '서버 연결 실패 — Render URL / CORS 확인' : '서버 연결 실패', '#cc5544');
    });
    this.events.once('shutdown', () => {
      socket.off('connect', refresh);
    });
  }

  _applySharePayload({ url, status }) {
    if (!this.scene || !this.scene.isActive()) return;
    if (url) {
      this._shareUrl = url;
      this._shareRefreshing = false;
      this._inviteStatus.setVisible(false);
      this._inviteUrlText.setText(url.replace(/^https?:\/\//, '')).setVisible(true);
      this._drawCopyBtn(false);
      this._copyG.setVisible(true);
      this._copyLabel.setVisible(true).setText('복사');
      if (this._drawRefBtn) this._drawRefBtn(false);
      if (this._refLabel) this._refLabel.setText('새 링크 만들기').setColor('#66ddaa');
      return;
    }
    this._shareUrl = null;
    this._inviteUrlText.setVisible(false);
    this._copyLabel.setVisible(false);
    if (this._copyG) this._copyG.clear();
    const connecting = status === 'connecting' || this._shareRefreshing;
    this._inviteStatus.setText(connecting ? '링크 생성 중...' : '링크 없음 — 새 링크 만들기').setVisible(true);
    if (this._drawRefBtn) this._drawRefBtn(false);
  }

  _pollShareUrl() {
    const publicUrl = getPublicInviteUrl();
    if (publicUrl) {
      this._applySharePayload({ url: publicUrl, status: 'ready' });
      return;
    }
    fetch(apiUrl('/api/share-url')).then(r => r.json()).then((data) => {
      if (!this.scene || !this.scene.isActive()) return;
      this._applySharePayload(data || {});
      if (!data || !data.url) {
        this.time.delayedCall(1500, () => {
          if (this.scene && this.scene.isActive() && !this._shareRefreshing) this._pollShareUrl();
        });
      }
    }).catch(() => {
      if (!this.scene || !this.scene.isActive()) return;
      this.time.delayedCall(2000, () => {
        if (this.scene && this.scene.isActive() && !this._shareRefreshing) this._pollShareUrl();
      });
    });
  }

  _refreshShareUrl() {
    const publicUrl = getPublicInviteUrl();
    if (publicUrl) {
      this._applySharePayload({ url: publicUrl, status: 'ready' });
      navigator.clipboard.writeText(publicUrl).catch(() => {});
      if (this._refLabel) this._refLabel.setText('복사됨').setColor('#66ddaa');
      this.time.delayedCall(900, () => {
        if (this._refLabel) this._refLabel.setText('새 링크 만들기').setColor('#66ddaa');
      });
      return;
    }
    if (this._shareRefreshing) return;
    this._shareRefreshing = true;
    this._shareUrl = null;
    this._inviteUrlText.setVisible(false);
    this._copyLabel.setVisible(false);
    if (this._copyG) this._copyG.clear();
    this._inviteStatus.setText('링크 생성 중...').setVisible(true);
    if (this._refLabel) this._refLabel.setText('생성 중...').setColor('#88aacc');
    if (this._drawRefBtn) this._drawRefBtn(false);

    fetch(apiUrl('/api/share-url/refresh'), { method: 'POST' })
      .then(r => r.json())
      .then((data) => {
        if (!this.scene || !this.scene.isActive()) return;
        this._shareRefreshing = false;
        this._applySharePayload(data || {});
        if (!data || !data.url) this._pollShareUrl();
      })
      .catch(() => {
        if (!this.scene || !this.scene.isActive()) return;
        this._shareRefreshing = false;
        this._applySharePayload({ url: null, status: 'error' });
        this._pollShareUrl();
      });
  }

  goToLobby() {
    const el   = document.getElementById('nameInput');
    const name = el ? (el.value.trim() || 'Player' + Phaser.Math.Between(1, 999)) : 'Player';
    this.scene.start('Lobby', { name, playerClass: this.selectedClass, gameMode: this.selectedMode, mapId: this.selectedMap });
  }

  update(time) {
    for (const p of this.particles) { p.gfx.y += p.vy; if (p.gfx.y < -4) p.gfx.y = this.scale.height + 4; }

    // Pulsing hex overlay
    this._hexPulse = (time * 0.001) % (Math.PI * 2);
    const g = this._hexOverlay.clear();
    const W = this.scale.width, H = this.scale.height;
    const pulse = 0.03 + 0.02 * Math.sin(this._hexPulse);
    const R = 38, hW = R * Math.sqrt(3), hH = R * 1.5;
    for (let row = -1; row < Math.ceil(H / hH) + 2; row++) {
      for (let col = -1; col < Math.ceil(W / hW) + 2; col++) {
        const cx = col * hW + (row % 2 ? hW / 2 : 0), cy = row * hH;
        const dist = Math.hypot(cx - W / 2, cy - H / 2);
        const alpha = pulse * Math.max(0, 1 - dist / Math.max(W, H));
        if (alpha < 0.005) continue;
        g.lineStyle(1, 0x3355aa, alpha);
        hexPath(g, cx, cy, R - 1); g.strokePath();
      }
    }
  }
}

// ═════════════════════════════════════════════════════════════
// LOBBY SCENE
// ═════════════════════════════════════════════════════════════
class LobbyScene extends Phaser.Scene {
  constructor() { super('Lobby'); }

  init(data) {
    this.playerName  = data.name        || 'Player';
    this.playerClass = data.playerClass || 'soldier';
    this.gameMode    = data.gameMode    || 'tdm';
    this.mapId       = data.mapId       || 'warehouse';
    this.botsPerTeam = 2; // default matches previous auto-fill
    this._rooms      = [];
    this._codeInput  = null;
  }

  create() {
    const W = this.scale.width, H = this.scale.height;

    this.add.graphics().fillGradientStyle(0x03030f, 0x03030f, 0x07071e, 0x07071e, 1).fillRect(0, 0, W, H);
    const hg = this.add.graphics();
    const R = 36, hW = R * Math.sqrt(3), hH = R * 1.5;
    for (let row = -1; row < Math.ceil(H / hH) + 2; row++) {
      for (let col = -1; col < Math.ceil(W / hW) + 2; col++) {
        const cx = col * hW + (row % 2 ? hW / 2 : 0), cy = row * hH;
        hg.lineStyle(1, 0x1a2a44, 0.3); hexPath(hg, cx, cy, R - 1); hg.strokePath();
      }
    }

    this.add.text(W / 2, 32, 'BATTLE LOBBY', {
      fontSize: Math.min(32, W * 0.06) + 'px', fontFamily: '"Orbitron", "Arial Black"',
      color: '#ffffff', stroke: '#cc1133', strokeThickness: 3,
    }).setOrigin(0.5);

    this.add.text(W / 2, 58, `${this.playerName}  ·  ${this.playerClass}  ·  ${this.gameMode.toUpperCase()}  ·  ${this.mapId}`, {
      fontSize: '11px', fontFamily: '"Rajdhani", "Courier New"', color: '#4a6088', letterSpacing: 2,
    }).setOrigin(0.5);

    // PC/터치 override (desktop default = PC; applies on next match join)
    const ctrlToggle = this.add.text(W * 0.95, 58, `조작: ${controlsModeLabel(this.sys.game)}`, {
      fontSize: '11px', fontFamily: '"Rajdhani", Arial', color: '#5a7a9a',
    }).setOrigin(1, 0.5).setInteractive({ useHandCursor: true });
    ctrlToggle.on('pointerover', () => ctrlToggle.setColor('#88aacc'));
    ctrlToggle.on('pointerout', () => ctrlToggle.setColor('#5a7a9a'));
    ctrlToggle.on('pointerdown', () => {
      setControlsPref(prefersTouchControls(this.sys.game) ? 'pc' : 'touch');
      ctrlToggle.setText(`조작: ${controlsModeLabel(this.sys.game)}`);
    });

    this.add.graphics().lineStyle(1, 0x1a3050, 0.8).lineBetween(W * 0.05, 74, W * 0.95, 74);

    // Action buttons row (slightly larger hit targets on touch / tablets)
    const touchUI = prefersTouchControls(this.sys.game);
    const btnY = touchUI ? 110 : 104;
    const btnW = touchUI ? Math.min(180, W * 0.28) : 160;
    const btnH = touchUI ? 44 : 38;
    this._buildBtn(W * 0.22, btnY, btnW, btnH, '+ 방 만들기', 0x116622, () => this._openCreatePanel());
    this._buildBtn(W * 0.5,  btnY, btnW, btnH, '⚡ 빠른 참가', 0x1133aa, () => this._quickJoin());
    this._buildBtn(W * 0.78, btnY, btnW, btnH, '↩ 뒤로',      0x331122, () => this.scene.start('Menu'));

    // Room code input
    const codeY = touchUI ? 168 : 156;
    this.add.text(W * 0.5 - 130, codeY, '방 코드 직접 입력:', {
      fontSize: '11px', fontFamily: '"Rajdhani", "Courier New"', color: '#446688',
    }).setOrigin(0, 0.5);
    this._codeInput = this.add.dom(W * 0.5 + 20, codeY).createFromHTML(`
      <input id="roomCodeInput" type="text" placeholder="ABCD" maxlength="4"
        autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false"
        style="font-size:16px;padding:8px 10px;border-radius:5px;width:96px;text-align:center;min-height:40px;
               border:1px solid #224466;background:#07101e;color:#88ccff;outline:none;
               text-transform:uppercase;letter-spacing:4px;font-family:'Orbitron','Courier New';
               -webkit-appearance:none;appearance:none;">
    `);
    this._buildBtn(W * 0.5 + 100, codeY, touchUI ? 88 : 80, touchUI ? 40 : 30, '참가', 0x114466, () => {
      const el = document.getElementById('roomCodeInput');
      const code = el ? el.value.trim().toUpperCase() : '';
      if (code.length === 4) this._joinByCode(code);
    });

    // Room list header
    const listTop = touchUI ? 210 : 190;
    this.add.graphics().lineStyle(1, 0x1a3050, 0.6).lineBetween(W * 0.05, listTop, W * 0.95, listTop);
    this.add.text(W * 0.05, listTop + 6, '방 목록', { fontSize: '11px', fontFamily: '"Rajdhani"', color: '#4a6088', letterSpacing: 3 });
    this._refreshText = this.add.text(W * 0.95, listTop + 6, '새로고침', {
      fontSize: '10px', fontFamily: '"Courier New"', color: '#334455',
    }).setOrigin(1, 0).setInteractive({ useHandCursor: true });
    this._refreshText.on('pointerdown', () => this._fetchRooms());
    this._refreshText.on('pointerover', () => this._refreshText.setColor('#6688aa'));
    this._refreshText.on('pointerout',  () => this._refreshText.setColor('#334455'));
    this._roomListY = listTop + 24;

    // Room list container
    this._roomListContainer = this.add.container(0, 0);
    this._fetchRooms();

    // Auto-refresh
    this.time.addEvent({ delay: 4000, callback: this._fetchRooms, callbackScope: this, loop: true });
  }

  _botsLabelText() {
    if (this.botsPerTeam <= 0) return 'AI 없음';
    return `팀당 ${this.botsPerTeam}`;
  }

  _closeCreatePanel() {
    if (this._createPanel) {
      this._createPanel.destroy(true);
      this._createPanel = null;
    }
  }

  _openCreatePanel() {
    if (this._createPanel) { this._closeCreatePanel(); return; }
    const W = this.scale.width, H = this.scale.height;
    const touchUI = prefersTouchControls(this.sys.game);
    const panW = Math.min(440, W * 0.9), panH = touchUI ? 318 : 298;
    const cx = W / 2, cy = H / 2;
    // Build back-to-front: dim/bg first so option buttons are never covered
    const container = this.add.container(0, 0).setDepth(200);
    this._createPanel = container;

    const dim = this.add.graphics();
    dim.fillStyle(0x000000, 0.6); dim.fillRect(0, 0, W, H);
    dim.setInteractive(new Phaser.Geom.Rectangle(0, 0, W, H), Phaser.Geom.Rectangle.Contains);
    dim.on('pointerdown', () => this._closeCreatePanel());

    const bg = this.add.graphics();
    bg.fillStyle(0x0a1824, 1); bg.fillRoundedRect(cx - panW / 2, cy - panH / 2, panW, panH, 10);
    bg.lineStyle(2, 0x2a8855, 1); bg.strokeRoundedRect(cx - panW / 2, cy - panH / 2, panW, panH, 10);
    // Stop clicks on the panel from closing via dim
    bg.setInteractive(new Phaser.Geom.Rectangle(cx - panW / 2, cy - panH / 2, panW, panH), Phaser.Geom.Rectangle.Contains);

    const title = this.add.text(cx, cy - panH / 2 + 24, '방 만들기', {
      fontSize: '22px', fontFamily: '"Orbitron", "Arial Black"', color: '#ffffff', stroke: '#116622', strokeThickness: 2,
    }).setOrigin(0.5);
    const sub = this.add.text(cx, cy - panH / 2 + 48, `${this.gameMode.toUpperCase()}  ·  ${this.mapId}  ·  팀당 AI 선택`, {
      fontSize: '13px', fontFamily: '"Rajdhani"', color: '#88aacc',
    }).setOrigin(0.5);

    container.add([dim, bg, title, sub]);

    const options = [
      { n: 0, label: 'AI 없음' },
      { n: 1, label: '팀당 1' },
      { n: 2, label: '팀당 2' },
      { n: 3, label: '팀당 3' },
      { n: 4, label: '팀당 4' },
    ];
    const btnW = Math.min(78, (panW - 36) / 5 - 6), btnH = touchUI ? 44 : 38;
    const gap = 8;
    const totalW = options.length * btnW + (options.length - 1) * gap;
    const sx = cx - totalW / 2 + btnW / 2;
    const optY = cy - 36;
    const optGfx = [];
    const optTxt = [];

    const redrawOpts = () => {
      options.forEach((opt, i) => {
        const x = sx + i * (btnW + gap);
        const g = optGfx[i];
        g.clear();
        const sel = this.botsPerTeam === opt.n;
        g.fillStyle(sel ? 0x228855 : 0x1a2838, 1);
        g.fillRoundedRect(x - btnW / 2, optY - btnH / 2, btnW, btnH, 6);
        g.lineStyle(sel ? 2.5 : 1.5, sel ? 0x66ffaa : 0x556688, sel ? 1 : 0.85);
        g.strokeRoundedRect(x - btnW / 2, optY - btnH / 2, btnW, btnH, 6);
        optTxt[i].setColor(sel ? '#ffffff' : '#ccddee');
        optTxt[i].setStroke(sel ? '#0a4020' : '#000000', sel ? 2 : 1);
      });
    };

    options.forEach((opt, i) => {
      const x = sx + i * (btnW + gap);
      const g = this.add.graphics();
      optGfx.push(g);
      const t = this.add.text(x, optY, opt.label, {
        fontSize: '13px', fontFamily: '"Rajdhani", Arial', color: '#ccddee',
        stroke: '#000000', strokeThickness: 1,
      }).setOrigin(0.5);
      optTxt.push(t);
      const zone = this.add.zone(x, optY, btnW, btnH).setInteractive({ useHandCursor: true });
      zone.on('pointerdown', (pointer, _lx, _ly, event) => {
        if (event) event.stopPropagation();
        this.botsPerTeam = opt.n;
        redrawOpts();
      });
      // Add AFTER dim/bg so labels and hit zones render on top
      container.add([g, t, zone]);
    });
    redrawOpts();

    // Share link row — mint a fresh URL for this play session
    const shareY = cy + 18;
    const shareHint = this.add.text(cx, shareY - 18, '친구에게 이 링크를 보내세요', {
      fontSize: '11px', fontFamily: '"Rajdhani"', color: '#5a90b0',
    }).setOrigin(0.5);

    const urlBoxW = panW - 100, urlBoxH = 26;
    const urlBg = this.add.graphics();
    urlBg.fillStyle(0x04090f, 1);
    urlBg.fillRoundedRect(cx - urlBoxW / 2 - 28, shareY - urlBoxH / 2, urlBoxW, urlBoxH, 4);
    urlBg.lineStyle(1, 0x1a4060, 1);
    urlBg.strokeRoundedRect(cx - urlBoxW / 2 - 28, shareY - urlBoxH / 2, urlBoxW, urlBoxH, 4);

    const shareStatus = this.add.text(cx - 28, shareY, '링크 생성 중...', {
      fontSize: '11px', fontFamily: '"Courier New"', color: '#3a6080',
    }).setOrigin(0.5);
    const shareUrlText = this.add.text(cx - urlBoxW / 2 - 20, shareY, '', {
      fontSize: '10px', fontFamily: '"Courier New"', color: '#5ab0e0', fixedWidth: urlBoxW - 16,
    }).setOrigin(0, 0.5).setVisible(false);

    const copyW = 48, copyH = 24;
    const copyX = cx + urlBoxW / 2 + 4;
    const copyG = this.add.graphics();
    let panelShareUrl = null;
    const drawCopy = (hov) => {
      copyG.clear();
      if (!panelShareUrl) return;
      copyG.fillStyle(hov ? 0x1a4a6a : 0x0a2030, 1);
      copyG.fillRoundedRect(copyX - copyW / 2, shareY - copyH / 2, copyW, copyH, 4);
      copyG.lineStyle(1, hov ? 0x5ab0e0 : 0x2a6080, 1);
      copyG.strokeRoundedRect(copyX - copyW / 2, shareY - copyH / 2, copyW, copyH, 4);
    };
    const copyLabel = this.add.text(copyX, shareY, '복사', {
      fontSize: '11px', fontFamily: '"Rajdhani"', color: '#7ec8f0',
    }).setOrigin(0.5).setVisible(false);
    copyG.setInteractive(new Phaser.Geom.Rectangle(copyX - copyW / 2, shareY - copyH / 2, copyW, copyH), Phaser.Geom.Rectangle.Contains);
    copyG.on('pointerover', () => drawCopy(true));
    copyG.on('pointerout', () => drawCopy(false));
    copyG.on('pointerdown', () => {
      if (!panelShareUrl) return;
      navigator.clipboard.writeText(panelShareUrl).catch(() => {});
      copyLabel.setText('OK!');
      this.time.delayedCall(900, () => { if (copyLabel && copyLabel.active) copyLabel.setText('복사'); });
    });

    const applyPanelShare = (data) => {
      if (!this._createPanel) return;
      if (data && data.url) {
        panelShareUrl = data.url;
        shareStatus.setVisible(false);
        shareUrlText.setText(data.url.replace(/^https?:\/\//, '')).setVisible(true);
        drawCopy(false);
        copyLabel.setVisible(true);
      } else {
        panelShareUrl = null;
        shareUrlText.setVisible(false);
        copyLabel.setVisible(false);
        copyG.clear();
        shareStatus.setText(data && data.status === 'error' ? '링크 실패 — 메뉴에서 재시도' : '링크 생성 중...').setVisible(true);
      }
    };

    // Fresh link for this host session
    const publicInvite = getPublicInviteUrl();
    if (publicInvite) {
      applyPanelShare({ url: publicInvite, status: 'ready' });
    } else {
      fetch(apiUrl('/api/share-url/refresh'), { method: 'POST' })
        .then(r => r.json())
        .then(applyPanelShare)
        .catch(() => applyPanelShare({ url: null, status: 'error' }));
    }

    const hint = this.add.text(cx, cy + 52, '참가자는 방장의 AI 설정을 그대로 사용합니다', {
      fontSize: '11px', fontFamily: '"Rajdhani"', color: '#778899',
    }).setOrigin(0.5);

    const confY = cy + panH / 2 - 34;
    const confW = 160, confH = touchUI ? 44 : 38;
    const confG = this.add.graphics();
    const drawConf = (hov) => {
      confG.clear();
      confG.fillStyle(hov ? 0x2aaa55 : 0x1a8844, 1);
      confG.fillRoundedRect(cx - confW / 2, confY - confH / 2, confW, confH, 7);
      confG.lineStyle(2, 0x66dd88, 0.9);
      confG.strokeRoundedRect(cx - confW / 2, confY - confH / 2, confW, confH, 7);
    };
    drawConf(false);
    confG.setInteractive(new Phaser.Geom.Rectangle(cx - confW / 2, confY - confH / 2, confW, confH), Phaser.Geom.Rectangle.Contains);
    confG.on('pointerover', () => drawConf(true));
    confG.on('pointerout', () => drawConf(false));
    confG.on('pointerdown', () => { this._closeCreatePanel(); this._createRoom(); });
    const confT = this.add.text(cx, confY, '생성하기', {
      fontSize: '16px', fontFamily: '"Rajdhani", Arial', color: '#ffffff', stroke: '#003311', strokeThickness: 2,
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    confT.on('pointerdown', () => { this._closeCreatePanel(); this._createRoom(); });

    container.add([shareHint, urlBg, shareStatus, shareUrlText, copyG, copyLabel, hint, confG, confT]);
  }

  _buildBtn(x, y, w, h, label, col, cb) {
    const g = this.add.graphics();
    const draw = (hov) => {
      g.clear();
      g.fillStyle(hov ? lightenColor(col, 20) : col, 1); g.fillRoundedRect(x - w / 2, y - h / 2, w, h, 6);
      g.lineStyle(1.5, 0x334455, 0.5); g.strokeRoundedRect(x - w / 2, y - h / 2, w, h, 6);
    };
    draw(false);
    g.setInteractive(new Phaser.Geom.Rectangle(x - w / 2, y - h / 2, w, h), Phaser.Geom.Rectangle.Contains);
    g.on('pointerover', () => draw(true)); g.on('pointerout', () => draw(false)); g.on('pointerdown', cb);
    this.add.text(x, y, label, { fontSize: '13px', fontFamily: '"Rajdhani", Arial', color: '#ffffff', stroke: '#000', strokeThickness: 1 }).setOrigin(0.5).setInteractive().on('pointerdown', cb);
  }

  _fetchRooms() {
    fetch(apiUrl('/api/rooms')).then(r => r.json()).then(rooms => {
      if (!this.scene || !this.scene.isActive()) return;
      this._rooms = rooms;
      this._renderRoomList();
    }).catch(() => {});
  }

  _renderRoomList() {
    if (!this.scene || !this.scene.isActive()) return;
    const W = this.scale.width;
    this._roomListContainer.removeAll(true);

    const startY = this._roomListY || 200;
    const rowH   = prefersTouchControls(this.sys.game) ? 52 : 44;

    if (this._rooms.length === 0) {
      const t = this.add.text(W / 2, startY + 30, '방이 없습니다. "방 만들기"로 새 방을 만드세요!', {
        fontSize: '12px', fontFamily: '"Rajdhani", Arial', color: '#3a5a7a',
      }).setOrigin(0.5);
      this._roomListContainer.add(t);
      return;
    }

    const mapNames  = { warehouse: '창고', arena: '경기장', maze: '미로' };
    const modeNames = { tdm: '팀 데스', ctf: '깃발 점령' };

    this._rooms.slice(0, 7).forEach((room, i) => {
      const ry = startY + i * rowH;
      const bg = this.add.graphics();
      bg.fillStyle(0x050d18, 0.9); bg.fillRoundedRect(W * 0.04, ry, W * 0.92, rowH - 4, 6);
      bg.lineStyle(1, 0x1a3050, 0.6); bg.strokeRoundedRect(W * 0.04, ry, W * 0.92, rowH - 4, 6);

      const statusCol = room.status === 'playing' ? '#aa4400' : '#005500';
      const statusTxt = room.status === 'playing' ? '진행중' : '대기중';
      const bots = room.botsPerTeam ?? 2;
      const botsTxt = bots <= 0 ? 'AI없음' : `AI×${bots}`;

      const nameT   = this.add.text(W * 0.06, ry + rowH / 2 - 10, room.name, { fontSize: '13px', fontFamily: '"Rajdhani", Arial', color: '#cce8ff', fontStyle: 'bold' }).setOrigin(0, 0.5);
      const codeT   = this.add.text(W * 0.06, ry + rowH / 2 + 8,  `[${room.code}]`, { fontSize: '10px', fontFamily: '"Orbitron", Courier', color: '#4488aa' }).setOrigin(0, 0.5);
      const modeT   = this.add.text(W * 0.32, ry + rowH / 2,  modeNames[room.gameMode] || room.gameMode, { fontSize: '11px', fontFamily: '"Rajdhani"', color: '#8899aa' }).setOrigin(0.5);
      const mapT    = this.add.text(W * 0.44, ry + rowH / 2,  mapNames[room.mapId] || room.mapId, { fontSize: '11px', fontFamily: '"Rajdhani"', color: '#8899aa' }).setOrigin(0.5);
      const botsT   = this.add.text(W * 0.56, ry + rowH / 2, botsTxt, { fontSize: '11px', fontFamily: '"Rajdhani"', color: '#7788aa' }).setOrigin(0.5);
      const playersT = this.add.text(W * 0.68, ry + rowH / 2, `👤 ${room.players}/8`, { fontSize: '11px', fontFamily: '"Rajdhani"', color: '#99bbdd' }).setOrigin(0.5);
      const statusT = this.add.text(W * 0.78, ry + rowH / 2, statusTxt, { fontSize: '11px', fontFamily: '"Rajdhani"', color: statusCol }).setOrigin(0.5);

      const joinBtnG = this.add.graphics();
      const joinBtnX = W * 0.9, joinBtnW = W * 0.08, joinBtnH = rowH - 12;
      const drawJoin = (hov) => {
        joinBtnG.clear();
        joinBtnG.fillStyle(hov ? 0x1a5533 : 0x0d2e1e, 1); joinBtnG.fillRoundedRect(joinBtnX - joinBtnW / 2, ry + 6, joinBtnW, joinBtnH, 5);
        joinBtnG.lineStyle(1, 0x225544, 0.8); joinBtnG.strokeRoundedRect(joinBtnX - joinBtnW / 2, ry + 6, joinBtnW, joinBtnH, 5);
      };
      drawJoin(false);
      joinBtnG.setInteractive(new Phaser.Geom.Rectangle(joinBtnX - joinBtnW / 2, ry + 6, joinBtnW, joinBtnH), Phaser.Geom.Rectangle.Contains);
      joinBtnG.on('pointerover', () => drawJoin(true)); joinBtnG.on('pointerout', () => drawJoin(false));
      joinBtnG.on('pointerdown', () => this._joinRoom(room.id));

      const joinT = this.add.text(joinBtnX, ry + rowH / 2, '참가', { fontSize: '11px', fontFamily: '"Rajdhani"', color: '#44ffaa' }).setOrigin(0.5).setInteractive();
      joinT.on('pointerdown', () => this._joinRoom(room.id));

      this._roomListContainer.add([bg, nameT, codeT, modeT, mapT, botsT, playersT, statusT, joinBtnG, joinT]);
    });
  }

  _createRoom() {
    socket.emit('createRoom', { gameMode: this.gameMode, mapId: this.mapId, botsPerTeam: this.botsPerTeam });
    socket.once('roomCreated', (data) => {
      if (!this.scene || !this.scene.isActive()) return;
      this._joinRoom(data.id);
    });
  }

  _quickJoin() {
    if (this._rooms.length === 0) { this._createRoom(); return; }
    // Find least-full waiting room
    const waiting = this._rooms.filter(r => r.status === 'waiting').sort((a, b) => a.players - b.players);
    if (waiting.length > 0) this._joinRoom(waiting[0].id);
    else this._createRoom();
  }

  _joinByCode(code) {
    this.scene.start('Game', {
      name: this.playerName, playerClass: this.playerClass,
      gameMode: this.gameMode, mapId: this.mapId, roomCode: code,
    });
  }

  _joinRoom(roomId) {
    this.scene.start('Game', {
      name: this.playerName, playerClass: this.playerClass,
      gameMode: this.gameMode, mapId: this.mapId, roomId,
    });
  }
}

// ═════════════════════════════════════════════════════════════
// GAME SCENE
// ═════════════════════════════════════════════════════════════
class GameScene extends Phaser.Scene {
  constructor() { super('Game'); }

  init(data) {
    this.playerName  = data.name        || 'Player';
    this.playerClass = data.playerClass || 'soldier';
    this.gameMode    = data.gameMode    || 'tdm';
    this.mapId       = data.mapId       || 'warehouse';
    this.roomId      = data.roomId      || null;
    this.roomCode    = data.roomCode    || null;

    this.myId       = null;
    this.myTeam     = null;
    this.gameState  = null;
    this.prevState  = null;
    this.walls      = [];
    this.worldW     = 800;
    this.worldH     = 600;
    this.killGoal   = 15;

    this.isMouseDown = false;
    this.worldMouseX = 0;
    this.worldMouseY = 0;
    this.inp = { dx: 0, dy: 0, shooting: false, angle: 0, skills: {}, grenadeTarget: { x: 0, y: 0 } };

    this.isMobile    = false;
    this.lj          = { active: false, ox: 0, oy: 0, tx: 0, ty: 0, pid: -1 };
    this.rj          = { active: false, ox: 0, oy: 0, tx: 0, ty: 0, pid: -1 };
    this.mobileSkillPressed = {};
    this.facingAngle = 0;
    this.mobileSkillBtns = null;

    this.bulletTrails = new Map();
    this.deathFX      = [];
    this.hitFX        = [];
    this.muzzleFX     = [];
    this.explosionFX  = [];
    this.meleeFX      = [];
    this.damageNumbers = [];

    this._streakTween   = null;
    this._latency       = 0;
    this._pingTimer     = 0;
    this._showScoreboard = false;

    this.roomName = null;
    this.roomCodeDisplay = null;

    // Class-specific skill definitions
    if (this.playerClass === 'brawler') {
      this.skillDefs = [
        { key: 'SHIFT', label: 'SHF',  name: '대시',  cdKey: 'dash',     maxCD: 4000,  color: 0xffaa00 },
        { key: 'E',     label: 'E',    name: '격투',  cdKey: 'melee',    maxCD: 400,   color: 0xff4400 },
        { key: 'Q',     label: 'Q',    name: '산탄',  cdKey: 'brawlerQ', maxCD: 4000,  color: 0xff8800 },
        { key: 'R',     label: 'R',    name: '회복',  cdKey: 'heal',     maxCD: 10000, color: 0x33ee55 },
        { key: 'F',     label: 'F',    name: '속도',  cdKey: 'speed',    maxCD: 7000,  color: 0xcc44ff },
      ];
    } else {
      this.skillDefs = [
        { key: 'SHIFT', label: 'SHF',  name: '대시',  cdKey: 'dash',    maxCD: 4000,  color: 0xffaa00 },
        { key: 'E',     label: 'E',    name: '방어막', cdKey: 'shield',  maxCD: 6000,  color: 0x00ddff },
        { key: 'Q',     label: 'Q',    name: '수류탄', cdKey: 'grenade', maxCD: 8000,  color: 0xff6600 },
        { key: 'R',     label: 'R',    name: '회복',  cdKey: 'heal',    maxCD: 10000, color: 0x33ee55 },
        { key: 'F',     label: 'F',    name: '속도',  cdKey: 'speed',   maxCD: 7000,  color: 0xcc44ff },
      ];
    }
  }

  create() {
    this.isMobile = prefersTouchControls(this.sys.game);
    this._touchUiScale = this.isMobile ? touchUiScale(this.scale.width, this.scale.height) : 1;

    socket.emit('joinGame', {
      name:     this.playerName,
      class:    this.playerClass,
      mode:     this.gameMode,
      map:      this.mapId,
      roomId:   this.roomId,
      roomCode: this.roomCode,
    });

    socket.once('gameJoined', (data) => {
      this.myId     = data.playerId;
      this.myTeam   = data.team;
      this.walls    = data.walls;
      this.worldW   = data.gameWidth;
      this.worldH   = data.gameHeight;
      this.killGoal = data.killGoal;
      this.gameMode = data.gameMode || this.gameMode;
      this.roomName = data.roomName || null;
      this.roomCodeDisplay = data.roomCode || null;

      this._camFollow = this.add.zone(this.worldW / 2, this.worldH / 2, 1, 1);
      this.cameras.main.startFollow(this._camFollow, true);
      this.cameras.main.setLerp(0.08, 0.08);
      this.syncCameraToWorld();
      this.buildStaticWorld();
      this.buildHUD();
      if (this.isMobile) this.buildMobileControls();
    });

    // Orientation / tablet resize: keep FIT letterboxing equal and camera centered
    this._onScaleResize = () => {
      this._touchUiScale = this.isMobile ? touchUiScale(this.scale.width, this.scale.height) : 1;
      this.syncCameraToWorld();
    };
    this.scale.on('resize', this._onScaleResize);

    this._onState = (state) => {
      if (this.prevState) {
        const prevMap = new Map(this.prevState.players.map(p => [p.id, p]));
        for (const p of state.players) {
          const prev = prevMap.get(p.id);
          if (!prev) continue;
          if (prev.alive && !p.alive) this.deathFX.push({ x: p.x, y: p.y, team: p.team, t: 0.7, maxT: 0.7 });
          if (p.alive && prev.hp > p.hp) {
            const dmg = Math.round(prev.hp - p.hp);
            this.hitFX.push({ x: p.x, y: p.y, team: p.team, t: 0.25, maxT: 0.25 });
            this.damageNumbers.push({ x: p.x + (Math.random() - 0.5) * 20, y: p.y - 20, amount: dmg, t: 1.0, maxT: 1.0, team: p.team });
          }
        }
        if (state.explosions && state.explosions.length > 0) {
          for (const ex of state.explosions) this.explosionFX.push({ x: ex.x, y: ex.y, team: ex.team, t: 0.6, maxT: 0.6 });
        }
        if (state.meleeEvents && state.meleeEvents.length > 0) {
          for (const m of state.meleeEvents) this.meleeFX.push({ x: m.x, y: m.y, angle: m.angle, team: m.team, t: 0.25, maxT: 0.25 });
        }
      }
      if (state.streakEvents && state.streakEvents.length > 0) {
        for (const ev of state.streakEvents) this._showStreakAnnouncement(ev);
      }
      this.prevState = this.gameState;
      this.gameState = state;
      if (state.gameOver) {
        socket.off('state', this._onState);
        this.time.delayedCall(800, () => {
          this.scene.start('GameOver', { winner: state.winner, scores: state.scores, gameMode: this.gameMode });
        });
      }
    };
    socket.on('state', this._onState);

    // Ping/pong for latency
    socket.on('pong', (ts) => { this._latency = Date.now() - ts; });

    this.pickupGfx  = this.add.graphics().setDepth(7);
    this.fxGfx      = this.add.graphics().setDepth(12);
    this.grenadeGfx = this.add.graphics().setDepth(8);
    this.bulletGfx  = this.add.graphics().setDepth(9);
    this.playerGfx  = this.add.graphics().setDepth(10);

    // Name pool (with pill background)
    this.namePool = Array.from({ length: 24 }, () => {
      const bg = this.add.graphics().setDepth(10).setVisible(false);
      const tx = this.add.text(0, 0, '', {
        fontSize: '11px', fontFamily: '"Rajdhani", "Courier New", monospace',
        color: '#ffffff', stroke: '#000000', strokeThickness: 2, padding: { x: 4, y: 1 },
      }).setOrigin(0.5, 1).setDepth(11).setVisible(false);
      return { bg, tx };
    });

    // Damage number pool
    this.dmgNumPool = Array.from({ length: 30 }, () => {
      const t = this.add.text(0, 0, '', {
        fontSize: '14px', fontFamily: '"Rajdhani", Arial', fontStyle: 'bold',
        color: '#ffffff', stroke: '#000000', strokeThickness: 3,
      }).setOrigin(0.5).setDepth(15).setVisible(false);
      t._lastTeam = null;
      return t;
    });

    this.pickupTextPool = Array.from({ length: 24 }, () =>
      this.add.text(0, 0, '', { fontSize: '15px' }).setOrigin(0.5).setDepth(8).setVisible(false)
    );

    if (this.input.keyboard) {
      this.keys = this.input.keyboard.addKeys({
        w: 'W', a: 'A', s: 'S', d: 'D',
        up: 'UP', dn: 'DOWN', lt: 'LEFT', rt: 'RIGHT',
        shift: 'SHIFT', e: 'E', q: 'Q', r: 'R', f: 'F',
        tab: 'TAB',
      });
      this.input.keyboard.on('keydown-TAB', (e) => { e.preventDefault(); this._showScoreboard = true; });
      this.input.keyboard.on('keyup-TAB',   () => { this._showScoreboard = false; });
    } else {
      this.keys = {};
    }
    this.input.on('pointerdown', (p) => { if (!this.isMobile && p.leftButtonDown()) this.isMouseDown = true; });
    this.input.on('pointerup',   () => { if (!this.isMobile) this.isMouseDown = false; });

    if (this.isMobile) this.setupMobileInput();
  }

  /**
   * When the camera view is wider/taller than the map (common on tablets),
   * Phaser clamps scroll to 0 and the world sticks to the top-left — looks
   * like the whole screen is shifted left. Expand bounds so follow can center.
   */
  syncCameraToWorld() {
    if (!this.worldW || !this.worldH || !this.cameras || !this.cameras.main) return;
    const cam = this.cameras.main;
    const viewW = cam.width / (cam.zoom || 1);
    const viewH = cam.height / (cam.zoom || 1);
    const boundsW = Math.max(this.worldW, viewW);
    const boundsH = Math.max(this.worldH, viewH);
    const bx = (this.worldW - boundsW) / 2;
    const by = (this.worldH - boundsH) / 2;
    cam.setBounds(bx, by, boundsW, boundsH);
    if (this._camFollow) cam.centerOn(this._camFollow.x, this._camFollow.y);
  }

  // ── Static world ───────────────────────────────────────────
  buildStaticWorld() {
    const W = this.worldW, H = this.worldH;
    const g = this.add.graphics().setDepth(0);
    g.fillStyle(0x080d18, 1); g.fillRect(0, 0, W, H);

    const R = 28, hexW = R * Math.sqrt(3), hexH = R * 1.5;
    for (let row = -1; row < Math.ceil(H / hexH) + 2; row++) {
      for (let col = -1; col < Math.ceil(W / hexW) + 2; col++) {
        const cx = col * hexW + (row % 2 ? hexW / 2 : 0), cy = row * hexH;
        g.lineStyle(0.7, 0x111e2e, 0.7); hexPath(g, cx, cy, R - 1); g.strokePath();
      }
    }

    const spawnW = 180;
    for (let alpha = 0.03; alpha <= 0.09; alpha += 0.02) {
      g.fillStyle(0xff2244, alpha); g.fillRect(0, 0, spawnW, H);
      g.fillStyle(0x2266ff, alpha); g.fillRect(W - spawnW, 0, spawnW, H);
    }
    g.lineStyle(1, 0xff2244, 0.3); g.lineBetween(spawnW, 0, spawnW, H);
    g.lineStyle(1, 0x2266ff, 0.3); g.lineBetween(W - spawnW, 0, W - spawnW, H);

    for (let yy = H * 0.25; yy <= H * 0.75; yy += H * 0.25) {
      this.add.text(spawnW / 2, yy, 'RED',  { fontSize: '18px', fontFamily: '"Arial Black"', color: '#ff2244' }).setOrigin(0.5).setAlpha(0.15).setDepth(1);
      this.add.text(W - spawnW / 2, yy, 'BLUE', { fontSize: '18px', fontFamily: '"Arial Black"', color: '#2266ff' }).setOrigin(0.5).setAlpha(0.15).setDepth(1);
    }
    for (const w of this.walls) this.drawWall3D(g, w);
    g.lineStyle(3, 0x1a3050, 1); g.strokeRect(1, 1, W - 2, H - 2);
    g.lineStyle(1, 0x0a1525, 1); g.strokeRect(4, 4, W - 8, H - 8);
  }

  drawWall3D(g, w) {
    const depth = 5;
    g.fillStyle(0x000000, 0.55); g.fillRect(w.x + depth, w.y + depth, w.w, w.h);
    g.fillStyle(0x1e3248, 1);    g.fillRect(w.x, w.y, w.w, w.h);
    g.fillStyle(0x2e4a66, 1);    g.fillRect(w.x, w.y, w.w, w.h - 3);
    if (w.h > 30) { g.lineStyle(1, 0x1a2e44, 0.8); g.lineBetween(w.x + 4, w.y + w.h / 2, w.x + w.w - 4, w.y + w.h / 2); }
    if (w.w > 30) { g.lineStyle(1, 0x1a2e44, 0.8); g.lineBetween(w.x + w.w / 2, w.y + 4, w.x + w.w / 2, w.y + w.h - 4); }
    g.lineStyle(2, 0x5588aa, 0.7); g.lineBetween(w.x, w.y, w.x + w.w, w.y); g.lineBetween(w.x, w.y, w.x, w.y + w.h);
    g.lineStyle(2, 0x0a1420, 0.9); g.lineBetween(w.x, w.y + w.h, w.x + w.w, w.y + w.h); g.lineBetween(w.x + w.w, w.y, w.x + w.w, w.y + w.h);
  }

  // ── HUD ────────────────────────────────────────────────────
  buildHUD() {
    const W = this.scale.width, H = this.scale.height;
    const topH = 50;

    this.topBar = this.add.graphics().setScrollFactor(0).setDepth(95);
    this.topBar.fillStyle(0x000000, 0.7); this.topBar.fillRect(0, 0, W, topH);
    this.topBar.lineStyle(1, 0x223344, 0.8); this.topBar.lineBetween(0, topH, W, topH);

    this.redPanGfx  = this.add.graphics().setScrollFactor(0).setDepth(96);
    this.bluePanGfx = this.add.graphics().setScrollFactor(0).setDepth(96);

    this.redScoreText = this.add.text(W / 2 - 80, topH / 2, '', {
      fontSize: '22px', fontFamily: '"Orbitron", "Arial Black"', color: '#ff4466', stroke: '#000', strokeThickness: 3,
    }).setOrigin(1, 0.5).setScrollFactor(0).setDepth(97);
    this.blueScoreText = this.add.text(W / 2 + 80, topH / 2, '', {
      fontSize: '22px', fontFamily: '"Orbitron", "Arial Black"', color: '#4488ff', stroke: '#000', strokeThickness: 3,
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(97);
    this.add.text(W / 2, topH / 2, ':', {
      fontSize: '22px', fontFamily: '"Arial Black"', color: '#445566', stroke: '#000', strokeThickness: 2,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(97);

    this.goalBarGfx = this.add.graphics().setScrollFactor(0).setDepth(96);
    const goalLabel = this.gameMode === 'ctf' ? '점령' : '킬';
    this.killGoalText = this.add.text(W / 2, topH - 9, `목표 ${this.killGoal} ${goalLabel}`, {
      fontSize: '10px', fontFamily: '"Rajdhani", "Courier New"', color: '#334455', letterSpacing: 2,
    }).setOrigin(0.5, 1).setScrollFactor(0).setDepth(97);

    this.ctfTipText = this.add.text(W / 2, topH + 16, '', {
      fontSize: '13px', fontFamily: '"Rajdhani", Arial', color: '#ffee88',
      stroke: '#000000', strokeThickness: 3, align: 'center',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(98).setVisible(false);

    const tc   = this.myTeam === 'red' ? '#ff4466' : '#4488ff';
    const icon = this.myTeam === 'red' ? '▶ RED' : 'BLUE ◀';
    this.add.text(W / 2 + (this.myTeam === 'red' ? -1 : 1) * (W / 2 - 14), topH / 2, icon, {
      fontSize: '12px', fontFamily: '"Orbitron", "Arial Black"', color: tc, stroke: '#000', strokeThickness: 2,
    }).setOrigin(this.myTeam === 'red' ? 0 : 1, 0.5).setScrollFactor(0).setDepth(97);

    // Room code display
    if (this.roomCodeDisplay) {
      this.add.text(W / 2, 6, `[${this.roomCodeDisplay}]`, {
        fontSize: '9px', fontFamily: '"Orbitron"', color: '#224466', letterSpacing: 3,
      }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(97);
    }

    // Skill bar
    const btH = 52, skillBarH = 64, skillBarY = H - btH - skillBarH;
    this.skillBarY = skillBarY;
    this.skillBarBg = this.add.graphics().setScrollFactor(0).setDepth(95);
    this.skillBarBg.fillStyle(0x000000, 0.72); this.skillBarBg.fillRect(0, skillBarY, W, skillBarH);
    this.skillBarBg.lineStyle(1, 0x1a2e44, 0.9); this.skillBarBg.lineBetween(0, skillBarY, W, skillBarY);
    this.skillHudGfx = this.add.graphics().setScrollFactor(0).setDepth(97);

    const slotW = 54, slotGap = 8;
    const totalW = this.skillDefs.length * slotW + (this.skillDefs.length - 1) * slotGap;
    this.skillSlotStartX = W / 2 - totalW / 2;
    this.skillSlotW = slotW; this.skillSlotGap = slotGap;

    this.skillKeyTexts = []; this.skillNameTexts = []; this.skillCdTexts = [];
    this.skillDefs.forEach((def, i) => {
      const cx = this.skillSlotStartX + i * (slotW + slotGap) + slotW / 2;
      const arcCY = skillBarY + 28;
      this.skillKeyTexts.push(this.add.text(cx, arcCY, def.label, {
        fontSize: '12px', fontFamily: '"Rajdhani", "Arial Black"', color: '#ccddeeff', stroke: '#000000', strokeThickness: 3,
      }).setOrigin(0.5).setScrollFactor(0).setDepth(99));
      this.skillNameTexts.push(this.add.text(cx, skillBarY + 50, def.name, {
        fontSize: '9px', fontFamily: '"Rajdhani", "Courier New"', color: '#7799bb',
      }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(99));
      this.skillCdTexts.push(this.add.text(cx, arcCY + 10, '', {
        fontSize: '10px', fontFamily: '"Courier New"', color: '#ffffff', stroke: '#000000', strokeThickness: 2,
      }).setOrigin(0.5).setScrollFactor(0).setDepth(99).setVisible(false));
    });

    // Minimap
    const mmW = 160, mmH = 120, mmPad = 8;
    const mmX = W - mmW - mmPad;
    const mmY = H - mmH - btH - (this.isMobile ? 0 : skillBarH) - mmPad;
    this.mmBg = this.add.graphics().setScrollFactor(0).setDepth(98);
    this.mmBg.fillStyle(0x000000, 0.65); this.mmBg.fillRect(mmX - 1, mmY - 1, mmW + 2, mmH + 2);
    this.mmBg.lineStyle(1, 0x334455, 0.9); this.mmBg.strokeRect(mmX - 1, mmY - 1, mmW + 2, mmH + 2);
    this.mmGfx = this.add.graphics().setScrollFactor(0).setDepth(99);
    this.mmX = mmX; this.mmY = mmY; this.mmW = mmW; this.mmH = mmH;

    // Bottom bar
    const btY = H - btH;
    this.btBarGfx = this.add.graphics().setScrollFactor(0).setDepth(95);
    this.btBarGfx.fillStyle(0x000000, 0.7); this.btBarGfx.fillRect(0, btY, W, btH);
    this.btBarGfx.lineStyle(1, 0x223344, 0.8); this.btBarGfx.lineBetween(0, btY, W, btY);

    this.hpGfx  = this.add.graphics().setScrollFactor(0).setDepth(96);
    this.hpText = this.add.text(W / 2, btY - 5, '', {
      fontSize: '13px', fontFamily: '"Rajdhani", "Courier New"', color: '#7799bb', stroke: '#000', strokeThickness: 2,
    }).setOrigin(0.5, 1).setScrollFactor(0).setDepth(97);

    this.weaponText = this.add.text(14, btY + btH / 2, '권총  ∞', {
      fontSize: '12px', fontFamily: '"Rajdhani", "Courier New"', color: '#7799aa', stroke: '#000', strokeThickness: 2,
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(97);

    this.statText = this.add.text(W - 14, btY + btH / 2, '', {
      fontSize: '13px', fontFamily: '"Rajdhani", "Courier New"', color: '#3a5a7a',
    }).setOrigin(1, 0.5).setScrollFactor(0).setDepth(97);

    this.respawnText = this.add.text(W / 2, H / 2, '', {
      fontSize: '38px', fontFamily: '"Orbitron", "Arial Black"', color: '#ffffff', stroke: '#000000', strokeThickness: 7, align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(200);

    // Kill feed (5 lines, rich colored)
    this.feedGfx = this.add.graphics().setScrollFactor(0).setDepth(97);
    this.feedLines = Array.from({ length: 5 }, (_, i) =>
      this.add.text(W - 14, 58 + i * 20, '', {
        fontSize: '12px', fontFamily: '"Rajdhani", "Courier New"',
        color: '#ccddaa', stroke: '#000', strokeThickness: 2,
      }).setOrigin(1, 0).setScrollFactor(0).setDepth(97)
    );

    // Streak text
    this.streakText = this.add.text(W / 2, H / 2 - 70, '', {
      fontSize: '36px', fontFamily: '"Orbitron", "Arial Black"',
      color: '#ffcc00', stroke: '#330000', strokeThickness: 6, align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(300).setAlpha(0);

    // Connection indicator (top-left)
    this.latencyGfx  = this.add.graphics().setScrollFactor(0).setDepth(98);
    this.latencyText = this.add.text(18, 8, '', {
      fontSize: '9px', fontFamily: '"Courier New"', color: '#336633',
    }).setScrollFactor(0).setDepth(98);

    // Scoreboard overlay
    this.scoreboardGfx = this.add.graphics().setScrollFactor(0).setDepth(400);
    this.scoreboardTexts = [];
  }

  // ── Streak announcement ────────────────────────────────────
  _showStreakAnnouncement(ev) {
    if (!this.streakText) return;
    const col = ev.team === 'red' ? '#ff4466' : '#4488ff';
    this.streakText.setText(`${ev.playerName}\n${ev.name}!`).setColor(col).setAlpha(1).setScale(1);
    if (this._streakTween) this._streakTween.stop();
    this._streakTween = this.tweens.add({
      targets: this.streakText, alpha: { from: 1, to: 0 }, delay: 1800, duration: 600, ease: 'Power2',
    });
  }

  // ── Main loop ──────────────────────────────────────────────
  update(time, delta) {
    if (!this.myId) return;
    const dt = delta / 1000;

    // Ping for latency
    this._pingTimer += delta;
    if (this._pingTimer >= 2000) {
      this._pingTimer = 0;
      socket.emit('ping', Date.now());
    }

    if (this.isMobile) {
      const JR = 65 * (this._touchUiScale || 1);
      if (this.lj.active) {
        let jdx = this.lj.tx - this.lj.ox, jdy = this.lj.ty - this.lj.oy;
        const dist = Math.sqrt(jdx * jdx + jdy * jdy);
        if (dist > JR) { jdx = jdx / dist * JR; jdy = jdy / dist * JR; }
        this.inp.dx = jdx / JR; this.inp.dy = jdy / JR;
      } else { this.inp.dx = 0; this.inp.dy = 0; }

      if (this.rj.active) {
        const jdx = this.rj.tx - this.rj.ox, jdy = this.rj.ty - this.rj.oy;
        const dist = Math.sqrt(jdx * jdx + jdy * jdy);
        if (dist > 5) this.facingAngle = Math.atan2(jdy, jdx);
        this.inp.shooting = dist > JR * 0.2;
      } else { this.inp.shooting = false; }
      this.inp.angle = this.facingAngle;

      if (this.gameState) {
        const me = this.gameState.players.find(p => p.id === this.myId);
        if (me) this.inp.grenadeTarget = { x: me.x + Math.cos(this.facingAngle) * 300, y: me.y + Math.sin(this.facingAngle) * 300 };
      }
      this.inp.skills = { ...this.mobileSkillPressed };
      this.mobileSkillPressed = {};
    } else {
      let dx = 0, dy = 0;
      if (this.keys.a.isDown || this.keys.lt.isDown) dx -= 1;
      if (this.keys.d.isDown || this.keys.rt.isDown) dx += 1;
      if (this.keys.w.isDown || this.keys.up.isDown)  dy -= 1;
      if (this.keys.s.isDown || this.keys.dn.isDown)  dy += 1;
      this.inp.dx = dx; this.inp.dy = dy;

      if (this.gameState) {
        const me = this.gameState.players.find(p => p.id === this.myId);
        const ptr = this.input.activePointer, cam = this.cameras.main;
        if (me) {
          this.worldMouseX = ptr.x + cam.scrollX;
          this.worldMouseY = ptr.y + cam.scrollY;
          this.inp.angle = Math.atan2(this.worldMouseY - me.y, this.worldMouseX - me.x);
        }
      }
      this.inp.grenadeTarget = { x: this.worldMouseX, y: this.worldMouseY };
      // Brawler: no primary shooting
      this.inp.shooting = this.playerClass !== 'brawler' && this.isMouseDown;

      const JD = Phaser.Input.Keyboard.JustDown;
      const skills = {};
      if (JD(this.keys.shift)) skills.dash = true;
      if (JD(this.keys.e)) {
        if (this.playerClass === 'brawler') skills.melee    = true;
        else                                skills.shield   = true;
      }
      if (JD(this.keys.q)) {
        if (this.playerClass === 'brawler') skills.brawlerQ = true;
        else                                skills.grenade  = true;
      }
      if (JD(this.keys.r)) skills.heal  = true;
      if (JD(this.keys.f)) skills.speed = true;
      this.inp.skills = skills;
    }

    socket.emit('input', { ...this.inp });

    if (!this.gameState) return;
    const me = this.gameState.players.find(p => p.id === this.myId);
    if (me && me.alive && this._camFollow) this._camFollow.setPosition(me.x, me.y);

    this.tickFX(dt);
    this.renderFrame(dt);
    this.updateHUD(me);
  }

  tickFX(dt) {
    for (let i = this.deathFX.length    - 1; i >= 0; i--) { this.deathFX[i].t    -= dt; if (this.deathFX[i].t    <= 0) this.deathFX.splice(i, 1); }
    for (let i = this.hitFX.length      - 1; i >= 0; i--) { this.hitFX[i].t      -= dt; if (this.hitFX[i].t      <= 0) this.hitFX.splice(i, 1); }
    for (let i = this.muzzleFX.length   - 1; i >= 0; i--) { this.muzzleFX[i].t   -= dt; if (this.muzzleFX[i].t   <= 0) this.muzzleFX.splice(i, 1); }
    for (let i = this.explosionFX.length - 1; i >= 0; i--) { this.explosionFX[i].t -= dt; if (this.explosionFX[i].t <= 0) this.explosionFX.splice(i, 1); }
    for (let i = this.meleeFX.length    - 1; i >= 0; i--) { this.meleeFX[i].t    -= dt; if (this.meleeFX[i].t    <= 0) this.meleeFX.splice(i, 1); }
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      this.damageNumbers[i].t -= dt;
      this.damageNumbers[i].y -= 22 * dt;
      if (this.damageNumbers[i].t <= 0) this.damageNumbers.splice(i, 1);
    }
    if (this.gameState) {
      const live = new Set(this.gameState.bullets.map(b => b.id));
      for (const id of this.bulletTrails.keys()) { if (!live.has(id)) this.bulletTrails.delete(id); }
    }
  }

  renderFrame(dt) {
    const state = this.gameState;
    const pg    = this.playerGfx.clear();
    const bg    = this.bulletGfx.clear();
    const fg    = this.fxGfx.clear();
    const gg    = this.grenadeGfx.clear();
    this.pickupGfx.clear();
    const now = Date.now();

    // Hide all name tags
    for (const n of this.namePool) { n.bg.setVisible(false); n.tx.setVisible(false); }
    // Hide damage numbers
    for (const dn of this.dmgNumPool) dn.setVisible(false);
    let ni = 0, di = 0;

    // Pickups / items / flags
    let ptIdx = 0;
    for (const t of this.pickupTextPool) t.setVisible(false);

    if (state.weaponPickups) {
      for (const wp of state.weaponPickups) {
        const col   = wp.type === 'shotgun' ? 0xff7700 : 0x00aaff;
        const pulse = 0.85 + 0.15 * Math.sin(now * 0.003);
        this.pickupGfx.fillStyle(0x000000, 0.35); this.pickupGfx.fillCircle(wp.x, wp.y + 2, 15);
        this.pickupGfx.fillStyle(col, 0.22 * pulse); this.pickupGfx.fillCircle(wp.x, wp.y, 19 * pulse);
        this.pickupGfx.lineStyle(2.5, col, 0.9 * pulse); this.pickupGfx.strokeCircle(wp.x, wp.y, 13 * pulse);
        if (ptIdx < this.pickupTextPool.length) this.pickupTextPool[ptIdx++].setText(wp.type === 'shotgun' ? '🔫' : '🔥').setPosition(wp.x, wp.y - 1).setVisible(true);
      }
    }
    if (state.items) {
      for (const item of state.items) {
        const cols  = { hp: 0x00ee55, speed: 0xffee00, shield: 0x00ddff };
        const icons = { hp: '💊', speed: '⚡', shield: '🛡' };
        const col   = cols[item.type]  || 0xffffff;
        const icon  = icons[item.type] || '?';
        const pulse = 0.78 + 0.22 * Math.sin(now * 0.004 + 1.6);
        this.pickupGfx.fillStyle(col, 0.18 * pulse); this.pickupGfx.fillCircle(item.x, item.y, 17 * pulse);
        this.pickupGfx.lineStyle(2, col, 0.8 * pulse); this.pickupGfx.strokeCircle(item.x, item.y, 12 * pulse);
        if (ptIdx < this.pickupTextPool.length) this.pickupTextPool[ptIdx++].setText(icon).setPosition(item.x, item.y).setVisible(true);
      }
    }
    if (state.flags) {
      const flagInfo = [{ flag: state.flags.red, col: 0xff2244 }, { flag: state.flags.blue, col: 0x2266ff }];
      for (const { flag, col } of flagInfo) {
        if (!flag) continue;
        // Always show home capture zone
        const homePulse = 0.55 + 0.2 * Math.sin(now * 0.0025);
        this.pickupGfx.lineStyle(2, col, 0.35 * homePulse);
        this.pickupGfx.strokeCircle(flag.homeX, flag.homeY, 55);
        this.pickupGfx.fillStyle(col, 0.06);
        this.pickupGfx.fillCircle(flag.homeX, flag.homeY, 55);
        if (flag.carrierId) continue;
        const pulse = 0.85 + 0.15 * Math.sin(now * 0.003 + 0.8);
        this.pickupGfx.fillStyle(col, 0.28 * pulse); this.pickupGfx.fillCircle(flag.x, flag.y, 24 * pulse);
        this.pickupGfx.lineStyle(3, col, 0.95 * pulse); this.pickupGfx.strokeCircle(flag.x, flag.y, 16 * pulse);
        if (ptIdx < this.pickupTextPool.length) this.pickupTextPool[ptIdx++].setText('🚩').setPosition(flag.x, flag.y - 2).setVisible(true);
      }
    }

    // Death rings
    for (const fx of this.deathFX) {
      const pct = 1 - fx.t / fx.maxT, r = 10 + pct * 60, a = (1 - pct) * 0.9;
      const col = fx.team === 'red' ? 0xff2244 : 0x2266ff;
      fg.lineStyle(3 * (1 - pct * 0.6), col, a); fg.strokeCircle(fx.x, fx.y, r);
      fg.lineStyle(8 * (1 - pct), 0xffffff, a * 0.3); fg.strokeCircle(fx.x, fx.y, r * 0.6);
    }

    // Hit sparks
    for (const fx of this.hitFX) {
      const pct = 1 - fx.t / fx.maxT, a = (1 - pct) * 0.8;
      const col = fx.team === 'red' ? 0xff6688 : 0x66aaff;
      fg.fillStyle(col, a);
      for (let i = 0; i < 6; i++) {
        const ang = (Math.PI * 2 / 6) * i + pct * 3, r = 6 + pct * 20;
        fg.fillCircle(fx.x + Math.cos(ang) * r, fx.y + Math.sin(ang) * r, 2.5 * (1 - pct));
      }
    }

    // Melee arc flash
    for (const fx of this.meleeFX) {
      const pct = 1 - fx.t / fx.maxT;
      const col = fx.team === 'red' ? 0xff4422 : 0x2244ff;
      const arcR = 80, halfCone = Math.PI / 4;
      const startAng = fx.angle - halfCone - Math.PI / 2;
      const endAng   = fx.angle + halfCone - Math.PI / 2;
      fg.fillStyle(col, (1 - pct) * 0.5);
      fg.slice(fx.x, fx.y, arcR, startAng, endAng, false);
      fg.fillPath();
      fg.lineStyle(3, col, (1 - pct) * 0.9);
      fg.beginPath();
      fg.arc(fx.x, fx.y, arcR, startAng, endAng, false);
      fg.strokePath();
      // Flash lines
      fg.lineStyle(2, 0xffffff, (1 - pct) * 0.7);
      for (let i = -2; i <= 2; i++) {
        const a = fx.angle + i * halfCone / 2;
        fg.lineBetween(fx.x + Math.cos(a) * 20, fx.y + Math.sin(a) * 20, fx.x + Math.cos(a) * (arcR - 5), fx.y + Math.sin(a) * (arcR - 5));
      }
    }

    // Explosions
    for (const fx of this.explosionFX) {
      const pct = 1 - fx.t / fx.maxT;
      if (pct < 0.25) { const fa = (1 - pct / 0.25) * 0.85; fg.fillStyle(0xffffff, fa); fg.fillCircle(fx.x, fx.y, 30 * (1 - pct / 0.25)); }
      fg.lineStyle(8 * (1 - pct), 0xff8800, (1 - pct) * 0.9); fg.strokeCircle(fx.x, fx.y, 20 + pct * 100);
      fg.lineStyle(3 * (1 - pct), 0xffdd66, (1 - pct) * 0.5); fg.strokeCircle(fx.x, fx.y, 10 + pct * 130);
      fg.fillStyle(0xff6600, (1 - pct) * 0.8);
      for (let i = 0; i < 8; i++) {
        const ang = (Math.PI * 2 / 8) * i + pct * 1.5, dr = pct * 80;
        fg.fillCircle(fx.x + Math.cos(ang) * dr, fx.y + Math.sin(ang) * dr, 3 * (1 - pct));
      }
    }

    // Damage numbers (reuse pool entries; avoid setStyle to prevent canvas rebuild each frame)
    for (const dn of this.damageNumbers) {
      if (di >= this.dmgNumPool.length) break;
      const pct = 1 - dn.t / dn.maxT;
      const col = dn.team === 'red' ? '#ff6677' : '#6699ff';
      const t   = this.dmgNumPool[di++];
      if (t._lastTeam !== dn.team) { t.setColor(col); t._lastTeam = dn.team; }
      t.setText(`-${dn.amount}`).setPosition(dn.x, dn.y).setAlpha(1 - pct * 0.8).setVisible(true);
    }

    // Grenades
    if (state.grenades) {
      for (const g of state.grenades) {
        const col  = g.team === 'red' ? 0xff6600 : 0x66aaff;
        const dark = g.team === 'red' ? 0x441400 : 0x001444;
        const pulse = 0.8 + 0.4 * Math.abs(Math.sin(now * 0.008));
        gg.fillStyle(dark, 0.9);  gg.fillCircle(g.x, g.y, 8 * pulse);
        gg.fillStyle(col, 1);     gg.fillCircle(g.x, g.y, 5.5 * pulse);
        gg.fillStyle(0xffffff, 0.7); gg.fillCircle(g.x - 1.5, g.y - 1.5, 2);
        gg.lineStyle(3, 0xffaa00, 0.2 + (1 - Math.max(0, (g.explodeAt - now) / 1200)) * 0.6); gg.strokeCircle(g.x, g.y, 7 * pulse);
      }
    }

    // Bullets
    for (const b of state.bullets) {
      const col = b.team === 'red' ? 0xff4455 : 0x4466ff;
      if (!this.bulletTrails.has(b.id)) this.bulletTrails.set(b.id, []);
      const trail = this.bulletTrails.get(b.id);
      trail.push({ x: b.x, y: b.y });
      if (trail.length > 7) trail.shift();
      for (let i = 0; i < trail.length; i++) {
        const a = (i + 1) / trail.length;
        bg.fillStyle(col, a * 0.55); bg.fillCircle(trail[i].x, trail[i].y, 1.5 + a * 1.5);
      }
      bg.fillStyle(0xffffff, 0.95); bg.fillCircle(b.x, b.y, 4.5);
      bg.fillStyle(col, 1);         bg.fillCircle(b.x, b.y, 3);
      bg.lineStyle(3, col, 0.35);   bg.strokeCircle(b.x, b.y, 6);
    }

    // Players
    const cam = this.cameras.main;
    const viewL = cam.scrollX - 120, viewR = cam.scrollX + cam.width + 120;
    const viewT = cam.scrollY - 120, viewB = cam.scrollY + cam.height + 120;
    const detailPad = 40;
    const detailL = cam.scrollX - detailPad, detailR = cam.scrollX + cam.width + detailPad;
    const detailT = cam.scrollY - detailPad, detailB = cam.scrollY + cam.height + detailPad;

    for (const p of state.players) {
      const isMe = p.id === this.myId;
      // Cull players well outside the camera
      if (!isMe && (p.x < viewL || p.x > viewR || p.y < viewT || p.y > viewB)) continue;

      const heavyDetail = isMe || (p.x >= detailL && p.x <= detailR && p.y >= detailT && p.y <= detailB);
      const dark = p.team === 'red' ? 0x7a0c1e : 0x0c1e7a;
      const _baseCol = p.team === 'red' ? 0xff2244 : 0x2266ff;
      const classVisuals = {
        soldier:  { pR: 16, accentFn: c => c,                            style: 'standard' },
        sniper:   { pR: 13, accentFn: c => darkenColor(c, 0.30),         style: 'sniper'   },
        tank:     { pR: 20, accentFn: c => blendColor(c, 0x888888, 0.35),style: 'tank'     },
        medic:    { pR: 15, accentFn: c => blendColor(c, 0x00ff88, 0.35),style: 'medic'    },
        assassin: { pR: 12, accentFn: c => darkenColor(c, 0.50),         style: 'assassin' },
        brawler:  { pR: 19, accentFn: c => brightenColor(c, 0.40),       style: 'brawler'  },
      };
      const cv  = classVisuals[p.class] || classVisuals.soldier;
      const pR  = cv.pR;
      const col = cv.accentFn(_baseCol);

      if (!p.alive) {
        pg.lineStyle(2, col, 0.2); pg.strokeCircle(p.x, p.y, 20);
        pg.fillStyle(col, 0.08);   pg.fillCircle(p.x, p.y, 18);
        continue;
      }

      // Far/off-edge players: cheap body only (skip glow/shadow/class detail)
      if (!heavyDetail) {
        pg.fillStyle(0x000000, 0.45); pg.fillCircle(p.x, p.y, pR + 3);
        pg.fillStyle(dark, 1);        pg.fillCircle(p.x, p.y, pR + 2);
        pg.fillStyle(col, 1);         pg.fillCircle(p.x, p.y, pR);
        const ang = p.angle;
        const gx0 = p.x + Math.cos(ang) * (pR - 2), gy0 = p.y + Math.sin(ang) * (pR - 2);
        const gx1 = p.x + Math.cos(ang) * (pR + 18), gy1 = p.y + Math.sin(ang) * (pR + 18);
        pg.lineStyle(4, dark, 1); pg.lineBetween(gx0, gy0, gx1, gy1);
        const hpPct = Math.max(0, p.hp) / (p.maxHP || 100);
        const barW = 44, barH = 5;
        const barX = p.x - barW / 2, barY = p.y - pR - 16;
        pg.fillStyle(0x000000, 0.75); pg.fillRoundedRect(barX - 1, barY - 1, barW + 2, barH + 2, 3);
        pg.fillStyle(0x1a2a3a, 1);    pg.fillRoundedRect(barX, barY, barW, barH, 2);
        const hpCol = hpPct > 0.6 ? 0x33ee55 : hpPct > 0.3 ? 0xffaa00 : 0xff2222;
        pg.fillStyle(hpCol, 1); pg.fillRoundedRect(barX, barY, barW * hpPct, barH, 2);
        if (ni < this.namePool.length) {
          const entry = this.namePool[ni++];
          const botSuffix = p.isBot ? ' (BOT)' : '';
          const label     = p.name + botSuffix;
          const nameCol   = p.isBot ? '#888899' : (p.team === 'red' ? '#ffaabb' : '#aabbff');
          const pillY = barY - 3;
          entry.tx.setText(label).setColor(nameCol).setPosition(p.x, pillY).setVisible(true);
          const tw = entry.tx.width + 8, th = 14;
          entry.bg.clear();
          entry.bg.fillStyle(0x000000, 0.55); entry.bg.fillRoundedRect(p.x - tw / 2, pillY - th, tw, th, 4);
          entry.bg.setVisible(true);
        }
        continue;
      }

      // Shield
      if (p.shielded) {
        const pulse = 0.6 + 0.4 * Math.abs(Math.sin(now * 0.005));
        pg.lineStyle(12, 0x00eeff, 0.12 * pulse); pg.strokeCircle(p.x, p.y, pR + 16);
        pg.lineStyle(3, 0x00ffff, 0.85 * pulse);  pg.strokeCircle(p.x, p.y, pR + 10);
        pg.fillStyle(0x00ffff, 0.6 * pulse);
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI * 2 / 6) * i + now * 0.002;
          pg.fillCircle(p.x + Math.cos(a) * (pR + 10), p.y + Math.sin(a) * (pR + 10), 2.5);
        }
      }

      // Speed boost
      if (p.speedBoost) {
        for (let i = 0; i < 4; i++) {
          const ang = Math.PI + (i - 1.5) * 0.35, len = 12 + i * 6;
          pg.lineStyle(2 - i * 0.3, 0xcc44ff, 0.4 - i * 0.08);
          pg.lineBetween(p.x + Math.cos(ang) * 16, p.y + Math.sin(ang) * 16, p.x + Math.cos(ang) * (16 + len), p.y + Math.sin(ang) * (16 + len));
        }
        pg.lineStyle(6, 0xcc44ff, 0.25); pg.strokeCircle(p.x, p.y, pR + 6);
      }

      // ── Class-specific body + gun rendering ──────────────────
      if (cv.style === 'standard') {
        // SOLDIER — baseline
        pg.lineStyle(10, col, 0.06); pg.strokeCircle(p.x, p.y, pR + 10);
        pg.lineStyle(5,  col, 0.12); pg.strokeCircle(p.x, p.y, pR + 6);
        pg.fillStyle(0x000000, 0.4);  pg.fillEllipse(p.x + 4, p.y + 6, 38, 24);
        pg.fillStyle(0x000000, 0.5);  pg.fillCircle(p.x, p.y, pR + 4);
        pg.fillStyle(dark, 1);        pg.fillCircle(p.x, p.y, pR + 3);
        pg.fillStyle(col,  1);        pg.fillCircle(p.x, p.y, pR);
        pg.lineStyle(2, dark, 0.7);   pg.strokeCircle(p.x, p.y, pR - 5);
        pg.fillStyle(0xffffff, 0.18); pg.fillCircle(p.x - 5, p.y - 5, 5.5);
        { const ang = p.angle, gBase = pR - 2, gTip = pR + 22;
          const gx0 = p.x + Math.cos(ang) * gBase, gy0 = p.y + Math.sin(ang) * gBase;
          const gx1 = p.x + Math.cos(ang) * gTip,  gy1 = p.y + Math.sin(ang) * gTip;
          pg.lineStyle(7, 0x000000, 0.5); pg.lineBetween(gx0+1, gy0+1, gx1+1, gy1+1);
          pg.lineStyle(6, dark, 1);       pg.lineBetween(gx0, gy0, gx1, gy1);
          pg.lineStyle(3, 0x99aabb, 0.7); pg.lineBetween(gx0, gy0, gx1, gy1);
          pg.fillStyle(0xccddee, 1);      pg.fillCircle(gx1, gy1, 3.5); }

      } else if (cv.style === 'sniper') {
        // SNIPER — slim, long barrel, scope
        pg.lineStyle(10, col, 0.06); pg.strokeCircle(p.x, p.y, pR + 10);
        pg.lineStyle(5,  col, 0.12); pg.strokeCircle(p.x, p.y, pR + 6);
        pg.fillStyle(0x000000, 0.3);  pg.fillEllipse(p.x + 3, p.y + 5, 28, 18);
        pg.fillStyle(0x000000, 0.5);  pg.fillCircle(p.x, p.y, pR + 4);
        pg.fillStyle(dark, 1);        pg.fillCircle(p.x, p.y, pR + 3);
        pg.fillStyle(col,  1);        pg.fillCircle(p.x, p.y, pR);
        pg.lineStyle(1.5, dark, 0.7); pg.strokeCircle(p.x, p.y, pR - 4);
        pg.fillStyle(0xffffff, 0.18); pg.fillCircle(p.x - 4, p.y - 4, 4);
        { const ang = p.angle, gBase = pR - 2, gTip = pR + 36;
          const gx0 = p.x + Math.cos(ang) * gBase, gy0 = p.y + Math.sin(ang) * gBase;
          const gx1 = p.x + Math.cos(ang) * gTip,  gy1 = p.y + Math.sin(ang) * gTip;
          pg.lineStyle(4, 0x000000, 0.4);   pg.lineBetween(gx0+1, gy0+1, gx1+1, gy1+1);
          pg.lineStyle(3, dark, 1);          pg.lineBetween(gx0, gy0, gx1, gy1);
          pg.lineStyle(1.5, 0x99aabb, 0.7); pg.lineBetween(gx0, gy0, gx1, gy1);
          const perp = ang + Math.PI / 2;
          const scx = p.x + Math.cos(ang) * (pR + 36 * 0.6);
          const scy = p.y + Math.sin(ang) * (pR + 36 * 0.6);
          pg.lineStyle(7, 0x334455, 0.85);
          pg.lineBetween(scx + Math.cos(perp)*5, scy + Math.sin(perp)*5,
                         scx - Math.cos(perp)*5, scy - Math.sin(perp)*5);
          pg.fillStyle(0xccddee, 1); pg.fillCircle(gx1, gy1, 2.5); }

      } else if (cv.style === 'tank') {
        // TANK — heavy, double ring, hex spokes, thick barrel
        pg.lineStyle(10, col, 0.06); pg.strokeCircle(p.x, p.y, pR + 10);
        pg.lineStyle(5,  col, 0.12); pg.strokeCircle(p.x, p.y, pR + 6);
        pg.fillStyle(0x000000, 0.4);  pg.fillEllipse(p.x + 4, p.y + 6, 46, 28);
        pg.fillStyle(0x000000, 0.5);  pg.fillCircle(p.x, p.y, pR + 5);
        pg.fillStyle(dark, 1);        pg.fillCircle(p.x, p.y, pR + 4);
        pg.fillStyle(col,  1);        pg.fillCircle(p.x, p.y, pR);
        pg.lineStyle(2, dark, 0.9);   pg.strokeCircle(p.x, p.y, pR - 4);
        pg.lineStyle(2, dark, 0.6);   pg.strokeCircle(p.x, p.y, pR - 8);
        for (let i = 0; i < 6; i++) {
          const ha = (Math.PI * 2 / 6) * i;
          pg.lineStyle(1, dark, 0.4);
          pg.lineBetween(p.x, p.y, p.x + Math.cos(ha) * (pR - 8), p.y + Math.sin(ha) * (pR - 8));
        }
        pg.fillStyle(0xffffff, 0.15); pg.fillCircle(p.x - 6, p.y - 6, 7);
        { const ang = p.angle, gBase = pR - 2, gTip = pR + 16;
          const gx0 = p.x + Math.cos(ang) * gBase, gy0 = p.y + Math.sin(ang) * gBase;
          const gx1 = p.x + Math.cos(ang) * gTip,  gy1 = p.y + Math.sin(ang) * gTip;
          pg.lineStyle(11, 0x000000, 0.5); pg.lineBetween(gx0+1, gy0+1, gx1+1, gy1+1);
          pg.lineStyle(9,  dark, 1);       pg.lineBetween(gx0, gy0, gx1, gy1);
          pg.lineStyle(4,  0x99aabb, 0.6); pg.lineBetween(gx0, gy0, gx1, gy1);
          pg.fillStyle(dark, 1);       pg.fillCircle(gx1, gy1, 5.5);
          pg.fillStyle(0xaabbcc, 0.8); pg.fillCircle(gx1, gy1, 3); }

      } else if (cv.style === 'medic') {
        // MEDIC — green aura, cross marking, sidearm
        const glowPulse = 0.5 + 0.5 * Math.abs(Math.sin(now * 0.003));
        pg.lineStyle(10, 0x00ff88, 0.08 * glowPulse); pg.strokeCircle(p.x, p.y, pR + 10);
        pg.lineStyle(5,  0x00ff88, 0.15 * glowPulse); pg.strokeCircle(p.x, p.y, pR + 6);
        pg.fillStyle(0x000000, 0.4);  pg.fillEllipse(p.x + 4, p.y + 6, 38, 24);
        pg.fillStyle(0x000000, 0.5);  pg.fillCircle(p.x, p.y, pR + 4);
        pg.fillStyle(dark, 1);        pg.fillCircle(p.x, p.y, pR + 3);
        pg.fillStyle(col,  1);        pg.fillCircle(p.x, p.y, pR);
        pg.lineStyle(2, dark, 0.7);   pg.strokeCircle(p.x, p.y, pR - 5);
        pg.fillStyle(0xffffff, 0.18); pg.fillCircle(p.x - 4, p.y - 4, 5);
        const crossArm = 7, crossThick = 3;
        pg.fillStyle(0xffffff, 0.92);
        pg.fillRect(p.x - crossThick/2, p.y - crossArm, crossThick, crossArm * 2);
        pg.fillRect(p.x - crossArm, p.y - crossThick/2, crossArm * 2, crossThick);
        pg.lineStyle(0.5, 0xff4444, 0.5);
        pg.strokeRect(p.x - crossThick/2, p.y - crossArm, crossThick, crossArm * 2);
        pg.strokeRect(p.x - crossArm, p.y - crossThick/2, crossArm * 2, crossThick);
        { const ang = p.angle, gBase = pR - 2, gTip = pR + 20;
          const gx0 = p.x + Math.cos(ang) * gBase, gy0 = p.y + Math.sin(ang) * gBase;
          const gx1 = p.x + Math.cos(ang) * gTip,  gy1 = p.y + Math.sin(ang) * gTip;
          pg.lineStyle(6, 0x000000, 0.5);   pg.lineBetween(gx0+1, gy0+1, gx1+1, gy1+1);
          pg.lineStyle(5, dark, 1);          pg.lineBetween(gx0, gy0, gx1, gy1);
          pg.lineStyle(2.5, 0x99aabb, 0.7); pg.lineBetween(gx0, gy0, gx1, gy1);
          pg.fillStyle(0xccddee, 1);         pg.fillCircle(gx1, gy1, 3); }
        if (p.healing) {
          const hp2 = 0.5 + 0.5 * Math.abs(Math.sin(now * 0.006));
          pg.lineStyle(3, 0x00ff88, 0.7 * hp2); pg.strokeCircle(p.x, p.y, pR + 14 * hp2);
        }

      } else if (cv.style === 'assassin') {
        // ASSASSIN — dark fill, color edge ring, diamond, dual barrels
        const baseCol   = _baseCol;
        const accentCol = darkenColor(baseCol, 0.50);
        pg.lineStyle(10, baseCol, 0.06); pg.strokeCircle(p.x, p.y, pR + 10);
        pg.lineStyle(5,  baseCol, 0.12); pg.strokeCircle(p.x, p.y, pR + 6);
        pg.fillStyle(0x000000, 0.4);  pg.fillEllipse(p.x + 4, p.y + 6, 32, 20);
        if (p.stealthed) {
          const sv = 0.25 + 0.15 * Math.sin(now * 0.008);
          pg.lineStyle(2, baseCol, sv); pg.strokeCircle(p.x, p.y, pR + 3);
        }
        pg.fillStyle(0x000000, 0.6);   pg.fillCircle(p.x, p.y, pR + 4);
        pg.fillStyle(accentCol, 1);    pg.fillCircle(p.x, p.y, pR + 2);
        pg.lineStyle(2.5, baseCol, 1); pg.strokeCircle(p.x, p.y, pR + 2);
        pg.fillStyle(accentCol, 1);    pg.fillCircle(p.x, p.y, pR);
        const starR = 5;
        pg.fillStyle(baseCol, 0.85);
        pg.fillTriangle(p.x, p.y - starR, p.x - starR*0.5, p.y, p.x + starR*0.5, p.y);
        pg.fillTriangle(p.x, p.y + starR, p.x - starR*0.5, p.y, p.x + starR*0.5, p.y);
        pg.fillStyle(0xffffff, 0.12); pg.fillCircle(p.x - 3, p.y - 3, 3.5);
        { const ang = p.angle, perp = ang + Math.PI / 2;
          for (const off of [-3, 3]) {
            const ox = Math.cos(perp) * off, oy = Math.sin(perp) * off;
            const gBase = pR - 2, gTip = pR + 20;
            const gx0 = p.x + ox + Math.cos(ang) * gBase, gy0 = p.y + oy + Math.sin(ang) * gBase;
            const gx1 = p.x + ox + Math.cos(ang) * gTip,  gy1 = p.y + oy + Math.sin(ang) * gTip;
            pg.lineStyle(3, 0x000000, 0.4); pg.lineBetween(gx0+1, gy0+1, gx1+1, gy1+1);
            pg.lineStyle(2, accentCol, 1);  pg.lineBetween(gx0, gy0, gx1, gy1);
            pg.lineStyle(1, baseCol, 0.5);  pg.lineBetween(gx0, gy0, gx1, gy1);
            pg.fillStyle(baseCol, 0.9);     pg.fillCircle(gx1, gy1, 2);
          } }

      } else if (cv.style === 'brawler') {
        // BRAWLER — large, bright, fists on sides, melee arc flash
        pg.lineStyle(10, col, 0.06); pg.strokeCircle(p.x, p.y, pR + 10);
        pg.lineStyle(5,  col, 0.12); pg.strokeCircle(p.x, p.y, pR + 6);
        pg.fillStyle(0x000000, 0.4);  pg.fillEllipse(p.x + 4, p.y + 6, 44, 28);
        pg.fillStyle(0x000000, 0.5);  pg.fillCircle(p.x, p.y, pR + 4);
        pg.fillStyle(dark, 1);        pg.fillCircle(p.x, p.y, pR + 3);
        pg.fillStyle(col,  1);        pg.fillCircle(p.x, p.y, pR);
        pg.lineStyle(3, dark, 0.8);   pg.strokeCircle(p.x, p.y, pR - 5);
        pg.lineStyle(1.5, col, 0.4);  pg.strokeCircle(p.x, p.y, pR - 9);
        pg.fillStyle(0xffffff, 0.2);  pg.fillCircle(p.x - 6, p.y - 6, 6.5);
        { const ang = p.angle;
          const fistDist = pR + 5, fistR = 7;
          const lfx = p.x + Math.cos(ang - Math.PI/2) * fistDist;
          const lfy = p.y + Math.sin(ang - Math.PI/2) * fistDist;
          pg.fillStyle(0x000000, 0.4);       pg.fillCircle(lfx + 2, lfy + 2, fistR);
          pg.fillStyle(dark, 1);              pg.fillCircle(lfx, lfy, fistR);
          pg.fillStyle(col, 1);               pg.fillCircle(lfx, lfy, fistR - 2);
          pg.lineStyle(1.5, 0xffffff, 0.2);  pg.strokeCircle(lfx, lfy, fistR - 3);
          const rfx = p.x + Math.cos(ang + Math.PI/2) * fistDist;
          const rfy = p.y + Math.sin(ang + Math.PI/2) * fistDist;
          pg.fillStyle(0x000000, 0.4);       pg.fillCircle(rfx + 2, rfy + 2, fistR);
          pg.fillStyle(dark, 1);              pg.fillCircle(rfx, rfy, fistR);
          pg.fillStyle(col, 1);               pg.fillCircle(rfx, rfy, fistR - 2);
          pg.lineStyle(1.5, 0xffffff, 0.2);  pg.strokeCircle(rfx, rfy, fistR - 3);
          if (p.meleeActive) {
            const arcStart = ang - Math.PI / 4, arcEnd = ang + Math.PI / 4;
            const arcR = pR + 28, arcSteps = 12;
            pg.fillStyle(col, 0.35);
            const arcPts = [{ x: p.x, y: p.y }];
            for (let s = 0; s <= arcSteps; s++) {
              const a = arcStart + (arcEnd - arcStart) * s / arcSteps;
              arcPts.push({ x: p.x + Math.cos(a) * arcR, y: p.y + Math.sin(a) * arcR });
            }
            for (let i = 1; i < arcPts.length - 1; i++) {
              pg.fillTriangle(arcPts[0].x, arcPts[0].y, arcPts[i].x, arcPts[i].y, arcPts[i+1].x, arcPts[i+1].y);
            }
            const flashA = 0.7 + 0.3 * Math.sin(now * 0.02);
            for (let s = 0; s < arcSteps; s++) {
              const a0 = arcStart + (arcEnd - arcStart) * s / arcSteps;
              const a1 = arcStart + (arcEnd - arcStart) * (s+1) / arcSteps;
              pg.lineStyle(3, 0xffffff, flashA * 0.8);
              pg.lineBetween(p.x + Math.cos(a0)*arcR, p.y + Math.sin(a0)*arcR,
                             p.x + Math.cos(a1)*arcR, p.y + Math.sin(a1)*arcR);
            }
            pg.lineStyle(2, col, flashA * 0.6);
            pg.lineBetween(p.x, p.y, p.x + Math.cos(arcStart)*arcR, p.y + Math.sin(arcStart)*arcR);
            pg.lineBetween(p.x, p.y, p.x + Math.cos(arcEnd)*arcR,   p.y + Math.sin(arcEnd)*arcR);
          } }
      } // end class-specific rendering

      // Self indicator
      if (isMe) {
        pg.lineStyle(2, 0xffee00, 0.85); pg.strokeCircle(p.x, p.y, pR + 8);
        const ay = p.y - pR - 18;
        pg.fillStyle(0xffee00, 0.9); pg.fillTriangle(p.x - 6, ay, p.x + 6, ay, p.x, ay - 8);
      }

      // HP bar
      const hpPct = Math.max(0, p.hp) / (p.maxHP || 100);
      const barW = 44, barH = 5;
      const barX = p.x - barW / 2, barY = p.y - pR - 16;
      pg.fillStyle(0x000000, 0.75); pg.fillRoundedRect(barX - 1, barY - 1, barW + 2, barH + 2, 3);
      pg.fillStyle(0x1a2a3a, 1);    pg.fillRoundedRect(barX, barY, barW, barH, 2);
      const hpCol = hpPct > 0.6 ? 0x33ee55 : hpPct > 0.3 ? 0xffaa00 : 0xff2222;
      pg.fillStyle(hpCol, 1); pg.fillRoundedRect(barX, barY, barW * hpPct, barH, 2);
      pg.lineStyle(1, 0x000000, 0.7);
      [0.25, 0.5, 0.75].forEach(t => { pg.lineBetween(barX + barW * t, barY, barX + barW * t, barY + barH); });

      // CTF flag indicator
      if (p.hasFlag) {
        const flagCol = p.hasFlag === 'red' ? 0xff2244 : 0x2266ff;
        const poleBase = p.y - pR - 18, poleTop = p.y - pR - 48;
        pg.lineStyle(2, 0xdddddd, 0.9); pg.lineBetween(p.x, poleBase, p.x, poleTop);
        pg.fillStyle(flagCol, 1); pg.fillTriangle(p.x, poleTop, p.x + 16, poleTop + 7, p.x, poleTop + 15);
        pg.lineStyle(1, 0xffffff, 0.35); pg.strokeTriangle(p.x, poleTop, p.x + 16, poleTop + 7, p.x, poleTop + 15);
      }

      // Kill streak badge
      if (p.killStreak >= 3) {
        pg.fillStyle(0xff8800, 0.85); pg.fillCircle(p.x + pR + 4, p.y - pR - 4, 7);
        pg.lineStyle(1, 0xffcc00, 0.9); pg.strokeCircle(p.x + pR + 4, p.y - pR - 4, 7);
      }

      // Name label with pill background
      if (ni < this.namePool.length) {
        const entry = this.namePool[ni++];
        const botSuffix = p.isBot ? ' (BOT)' : '';
        const label     = p.name + botSuffix;
        const nameCol   = p.isBot ? '#888899' : (isMe ? '#ffee66' : (p.team === 'red' ? '#ffaabb' : '#aabbff'));
        const pillY = barY - 3;
        entry.tx.setText(label).setColor(nameCol).setPosition(p.x, pillY).setVisible(true);
        const tw = entry.tx.width + 8, th = 14;
        entry.bg.clear();
        entry.bg.fillStyle(0x000000, 0.55); entry.bg.fillRoundedRect(p.x - tw / 2, pillY - th, tw, th, 4);
        entry.bg.setVisible(true);
      }
    }
  }

  updateHUD(me) {
    const W = this.scale.width, H = this.scale.height;
    const state = this.gameState;
    const { red, blue } = state.scores;
    const G = this.killGoal;

    this.redScoreText.setText(`${red}`);
    this.blueScoreText.setText(`${blue}`);

    // CTF carrier tip
    if (this.ctfTipText) {
      if (this.gameMode === 'ctf' && me && me.alive && me.hasFlag && state.flags) {
        const own = state.flags[me.team];
        const blocked = own && (own.carrierId || own.dropped);
        this.ctfTipText.setText(blocked ? '우리 깃발이 있어야 점령 가능' : '깃발을 우리 진영으로 가져가세요');
        this.ctfTipText.setColor(blocked ? '#ff8866' : '#ffee88');
        this.ctfTipText.setVisible(true);
      } else if (this.ctfTipText.visible) {
        this.ctfTipText.setVisible(false);
      }
    }

    // Progress bars
    const pbY = 44, pbH = 4, pbW = W * 0.38;
    const rPct = Math.min(1, red / G), bPct = Math.min(1, blue / G);
    this.goalBarGfx.clear();
    this.goalBarGfx.fillStyle(0x1a0810, 1); this.goalBarGfx.fillRect(W/2 - pbW - 4, pbY, pbW, pbH);
    this.goalBarGfx.fillStyle(0xff2244, 0.9); this.goalBarGfx.fillRect(W/2 - pbW - 4, pbY, pbW * rPct, pbH);
    this.goalBarGfx.fillStyle(0x08101a, 1); this.goalBarGfx.fillRect(W/2 + 4, pbY, pbW, pbH);
    this.goalBarGfx.fillStyle(0x2266ff, 0.9); this.goalBarGfx.fillRect(W/2 + 4, pbY, pbW * bPct, pbH);

    // HP bar
    const maxHP = (me && me.maxHP) ? me.maxHP : 100;
    const hp    = (me && me.alive) ? Math.max(0, me.hp) : 0;
    const hpPct = hp / maxHP;
    const bW    = Math.min(260, W * 0.34);
    const bX    = W / 2 - bW / 2, bY = H - 36;
    this.hpGfx.clear();
    this.hpGfx.fillStyle(0x000000, 0.6); this.hpGfx.fillRoundedRect(bX - 2, bY - 2, bW + 4, 16, 5);
    this.hpGfx.fillStyle(0x0d1a28, 1);   this.hpGfx.fillRoundedRect(bX, bY, bW, 12, 4);
    if (hpPct > 0) {
      const c = hpPct > 0.6 ? 0x33ee55 : hpPct > 0.3 ? 0xffaa00 : 0xff2244;
      this.hpGfx.fillStyle(c, 1); this.hpGfx.fillRoundedRect(bX, bY, bW * hpPct, 12, 4);
      this.hpGfx.fillStyle(0xffffff, 0.1); this.hpGfx.fillRoundedRect(bX, bY, bW * hpPct, 5, 3);
    }
    this.hpGfx.lineStyle(1, 0x000000, 0.5);
    [0.25, 0.5, 0.75].forEach(t => { this.hpGfx.lineBetween(bX + bW * t, bY, bX + bW * t, bY + 12); });
    this.hpText.setText(`HP  ${Math.ceil(hp)} / ${maxHP}`).setPosition(W / 2, bY - 5);

    // Weapon / ammo
    if (me && this.weaponText) {
      const weaponNames = { pistol: '권총', shotgun: '샷건', machinegun: '기관총' };
      const wName  = me.class === 'brawler' ? '격투' : (weaponNames[me.weapon] || me.weapon || '권총');
      const ammoStr = (me.ammo === -1 || me.ammo === undefined) ? '∞' : `${me.ammo}`;
      const wCol   = me.weapon === 'shotgun' ? '#ffaa44' : me.weapon === 'machinegun' ? '#44aaff' : me.class === 'brawler' ? '#ff6633' : '#7799aa';
      this.weaponText.setText(me.class === 'brawler' ? '👊 격투가' : `${wName}  ${ammoStr}`).setColor(wCol);
    }

    // Stats
    let statStr = `K ${me?.kills ?? 0}  D ${me?.deaths ?? 0}`;
    if (me?.killStreak >= 3) statStr += `  🔥×${me.killStreak}`;
    // Assassin dash charges
    if (me?.class === 'assassin' && me.dashCharges !== undefined) statStr += `  ⚡${me.dashCharges}`;
    this.statText.setText(statStr);

    // Respawn
    if (me && !me.alive && me.respawnAt) {
      const s = Math.ceil((me.respawnAt - Date.now()) / 1000);
      this.respawnText.setText(s > 0 ? `💀\n부활까지  ${s}초` : '');
    } else {
      this.respawnText.setText('');
    }

    // Kill feed (rich, colored per team)
    this.feedGfx.clear();
    const feedX = W - 14;
    for (let i = 0; i < this.feedLines.length; i++) {
      const entry = state.killFeed[i];
      if (!entry) { this.feedLines[i].setText(''); continue; }
      if (typeof entry === 'string') {
        this.feedLines[i].setText(entry).setColor('#ccddaa');
      } else if (entry.type === 'kill') {
        const kCol = entry.kt === 'red' ? '#ff7799' : '#7799ff';
        const vCol = entry.vt === 'red' ? '#ff4455' : '#4455ff';
        // Simple colored text: show in killer team color
        const feedStr = `${entry.k} → ${entry.v}`;
        this.feedLines[i].setText(feedStr).setColor(kCol);
      } else if (entry.type === 'flag') {
        const fCol = entry.team === 'red' ? '#ff8899' : '#8899ff';
        this.feedLines[i].setText(entry.text || '').setColor(fCol);
      } else {
        this.feedLines[i].setText('').setColor('#ccddaa');
      }
    }

    // Minimap
    if (this.mmGfx) {
      const mm = this.mmGfx.clear();
      const scaleX = this.mmW / this.worldW, scaleY = this.mmH / this.worldH;
      mm.fillStyle(0x334455, 0.7);
      for (const w of this.walls) mm.fillRect(this.mmX + w.x * scaleX, this.mmY + w.y * scaleY, Math.max(2, w.w * scaleX), Math.max(2, w.h * scaleY));
      mm.fillStyle(0xff2244, 0.12); mm.fillRect(this.mmX, this.mmY, 180 * scaleX, this.mmH);
      mm.fillStyle(0x2266ff, 0.12); mm.fillRect(this.mmX + this.mmW - 180 * scaleX, this.mmY, 180 * scaleX, this.mmH);
      if (state.weaponPickups) {
        for (const wp of state.weaponPickups) {
          mm.fillStyle(wp.type === 'shotgun' ? 0xff7700 : 0x00aaff, 0.85);
          mm.fillCircle(this.mmX + wp.x * scaleX, this.mmY + wp.y * scaleY, 2);
        }
      }
      if (state.flags && this.gameMode === 'ctf') {
        for (const { flag, col } of [{ flag: state.flags.red, col: 0xff3344 }, { flag: state.flags.blue, col: 0x3366ff }]) {
          if (!flag) continue;
          mm.fillStyle(col, 1); mm.fillCircle(this.mmX + flag.x * scaleX, this.mmY + flag.y * scaleY, 4.5);
          mm.lineStyle(1, 0xffffff, 0.8); mm.strokeCircle(this.mmX + flag.x * scaleX, this.mmY + flag.y * scaleY, 4.5);
        }
      }
      for (const p of state.players) {
        if (!p.alive) continue;
        const col = p.team === 'red' ? 0xff3344 : 0x3366ff;
        mm.fillStyle(p.id === this.myId ? 0xffee00 : col, 1);
        mm.fillCircle(this.mmX + p.x * scaleX, this.mmY + p.y * scaleY, p.id === this.myId ? 3.5 : 2.5);
      }
      if (state.grenades) {
        for (const g of state.grenades) { mm.fillStyle(0xff6600, 0.9); mm.fillCircle(this.mmX + g.x * scaleX, this.mmY + g.y * scaleY, 2); }
      }
      const cam = this.cameras.main;
      mm.lineStyle(1, 0xffffff, 0.4);
      mm.strokeRect(this.mmX + cam.scrollX * scaleX, this.mmY + cam.scrollY * scaleY, cam.width * scaleX, cam.height * scaleY);
    }

    if (this.isMobile) this.drawMobileControls(me);

    // Skill HUD
    if (this.skillHudGfx && me) {
      const g = this.skillHudGfx.clear();
      const cds = me.skillCooldowns || {};
      this.skillDefs.forEach((def, i) => {
        const cx = this.skillSlotStartX + i * (this.skillSlotW + this.skillSlotGap) + this.skillSlotW / 2;
        const arcCY = this.skillBarY + 28;
        const remaining = cds[def.cdKey] || 0;
        const ready = remaining <= 0;
        const readyFrac = ready ? 1 : Math.max(0, 1 - remaining / def.maxCD);
        g.fillStyle(0x050d1a, 0.96); g.fillRoundedRect(cx - 26, arcCY - 24, 52, 48, 7);
        g.lineStyle(1.5, ready ? def.color : 0x1e2e3e, ready ? 0.8 : 0.5);
        g.strokeRoundedRect(cx - 26, arcCY - 24, 52, 48, 7);
        g.lineStyle(4, 0x1a2a3a, 1); g.beginPath(); g.arc(cx, arcCY, 16, 0, Math.PI * 2, false); g.strokePath();
        if (ready) {
          g.lineStyle(4, def.color, 0.95); g.beginPath(); g.arc(cx, arcCY, 16, 0, Math.PI * 2, false); g.strokePath();
          g.lineStyle(8, def.color, 0.2); g.strokeCircle(cx, arcCY, 16);
          this.skillCdTexts[i].setVisible(false);
          this.skillKeyTexts[i].setAlpha(1).setColor('#ffffff');
          this.skillNameTexts[i].setAlpha(1).setColor('#99bbdd');
        } else {
          if (readyFrac > 0.01) {
            g.lineStyle(4, def.color, 0.7); g.beginPath();
            g.arc(cx, arcCY, 16, -Math.PI / 2, -Math.PI / 2 + readyFrac * Math.PI * 2, false);
            g.strokePath();
          }
          this.skillCdTexts[i].setText((remaining / 1000).toFixed(1)).setVisible(true);
          this.skillKeyTexts[i].setAlpha(0.35).setColor('#667788');
          this.skillNameTexts[i].setAlpha(0.4).setColor('#445566');
        }
      });
    }

    // Connection indicator
    if (this.latencyGfx) {
      this.latencyGfx.clear();
      const lat = this._latency;
      const latCol = lat < 50 ? 0x00ee44 : lat < 150 ? 0xffcc00 : 0xff3333;
      this.latencyGfx.fillStyle(latCol, 0.9); this.latencyGfx.fillCircle(10, 42, 5);
      this.latencyGfx.lineStyle(1, 0x000000, 0.5); this.latencyGfx.strokeCircle(10, 42, 5);
      this.latencyText.setText(`${lat}ms`).setPosition(18, 38).setColor(lat < 50 ? '#00ee44' : lat < 150 ? '#ffcc00' : '#ff3333');
    }

    // Scoreboard overlay
    this._renderScoreboard(me);
  }

  _renderScoreboard(me) {
    if (!this.scoreboardGfx) return;
    const g = this.scoreboardGfx.clear();
    for (const t of this.scoreboardTexts) t.destroy();
    this.scoreboardTexts = [];

    if (!this._showScoreboard || !this.gameState) return;

    const W = this.scale.width, H = this.scale.height;
    const panW = Math.min(560, W * 0.88), panH = Math.min(380, H * 0.78);
    const panX = W / 2 - panW / 2, panY = H / 2 - panH / 2;

    g.fillStyle(0x000000, 0.85); g.fillRoundedRect(panX, panY, panW, panH, 12);
    g.lineStyle(1.5, 0x334455, 0.9); g.strokeRoundedRect(panX, panY, panW, panH, 12);

    const add = (x, y, txt, style) => {
      const t = this.add.text(x, y, txt, style).setScrollFactor(0).setDepth(401);
      this.scoreboardTexts.push(t);
      return t;
    };

    add(W / 2, panY + 18, 'SCOREBOARD', {
      fontSize: '18px', fontFamily: '"Orbitron", "Arial Black"', color: '#ccddff', stroke: '#000', strokeThickness: 2,
    }).setOrigin(0.5);

    const headY = panY + 42;
    add(panX + 24,        headY, '이름',  { fontSize: '11px', fontFamily: '"Rajdhani"', color: '#4a6088' });
    add(panX + panW * 0.52, headY, '팀',   { fontSize: '11px', fontFamily: '"Rajdhani"', color: '#4a6088' }).setOrigin(0.5);
    add(panX + panW * 0.64, headY, 'K',   { fontSize: '11px', fontFamily: '"Rajdhani"', color: '#4a6088' }).setOrigin(0.5);
    add(panX + panW * 0.74, headY, 'D',   { fontSize: '11px', fontFamily: '"Rajdhani"', color: '#4a6088' }).setOrigin(0.5);
    add(panX + panW * 0.86, headY, 'K/D', { fontSize: '11px', fontFamily: '"Rajdhani"', color: '#4a6088' }).setOrigin(0.5);
    g.lineStyle(1, 0x1a3050, 0.8); g.lineBetween(panX + 12, headY + 14, panX + panW - 12, headY + 14);

    const players = [...this.gameState.players].sort((a, b) => b.kills - a.kills);
    const rowH = 26;
    players.forEach((p, i) => {
      const ry = headY + 20 + i * rowH;
      if (ry + rowH > panY + panH - 12) return;
      const isMe   = p.id === this.myId;
      const teamC  = p.team === 'red' ? '#ff5577' : '#5577ff';
      const nameC  = p.isBot ? '#888899' : (isMe ? '#ffee66' : '#ccdded');
      const kd     = p.deaths > 0 ? (p.kills / p.deaths).toFixed(1) : p.kills.toFixed(1);
      const nameStr = p.name + (p.isBot ? ' (BOT)' : '');

      if (isMe) { g.fillStyle(0x203040, 0.5); g.fillRoundedRect(panX + 8, ry - 2, panW - 16, rowH - 2, 4); }
      add(panX + 24,          ry + 9, nameStr, { fontSize: '12px', fontFamily: '"Rajdhani"', color: nameC }).setOrigin(0, 0.5);
      add(panX + panW * 0.52, ry + 9, p.team.toUpperCase(), { fontSize: '11px', fontFamily: '"Rajdhani"', color: teamC }).setOrigin(0.5);
      add(panX + panW * 0.64, ry + 9, `${p.kills}`,  { fontSize: '12px', fontFamily: '"Rajdhani"', color: '#aaffaa' }).setOrigin(0.5);
      add(panX + panW * 0.74, ry + 9, `${p.deaths}`, { fontSize: '12px', fontFamily: '"Rajdhani"', color: '#ffaaaa' }).setOrigin(0.5);
      add(panX + panW * 0.86, ry + 9, kd,             { fontSize: '12px', fontFamily: '"Rajdhani"', color: '#aabbcc' }).setOrigin(0.5);
    });

    add(W / 2, panY + panH - 14, '[TAB] 닫기', {
      fontSize: '10px', fontFamily: '"Courier New"', color: '#334455',
    }).setOrigin(0.5);
  }

  // ── Mobile controls ────────────────────────────────────────
  buildMobileControls() {
    const W = this.scale.width, H = this.scale.height;
    const s = this._touchUiScale || touchUiScale(W, H);
    this._touchUiScale = s;
    const btH = Math.round(52 * s), BtnR = Math.round(30 * s), fanR = Math.round(85 * s);
    const spreadRad = Math.PI * (140 / 180), startAngle = -Math.PI / 2 - spreadRad / 2;
    const fanCX = W - Math.round(120 * s), fanCY = H - btH - Math.round(70 * s);
    const icons     = ['⚡', this.playerClass === 'brawler' ? '👊' : '🛡', this.playerClass === 'brawler' ? '💥' : '💣', '💊', '⚡'];
    const skillKeys = ['dash', this.playerClass === 'brawler' ? 'melee' : 'shield', this.playerClass === 'brawler' ? 'brawlerQ' : 'grenade', 'heal', 'speed'];

    this.mobileSkillBtns = this.skillDefs.map((def, i) => {
      const angle = startAngle + (spreadRad / 4) * i;
      return { sx: fanCX + Math.cos(angle) * fanR, sy: fanCY + Math.sin(angle) * fanR, r: BtnR, skillKey: skillKeys[i], icon: icons[i], color: def.color, cdKey: def.cdKey, maxCD: def.maxCD, pressed: false };
    });

    const btnBg = this.add.graphics().setScrollFactor(0).setDepth(151);
    for (const btn of this.mobileSkillBtns) {
      btnBg.fillStyle(btn.color, 0.35); btnBg.fillCircle(btn.sx, btn.sy, btn.r);
      btnBg.lineStyle(1.5, 0xffffff, 0.22); btnBg.strokeCircle(btn.sx, btn.sy, btn.r);
    }
    const iconSize = Math.round(16 * s) + 'px';
    const cdSize = Math.round(9 * s) + 'px';
    this.mobileIconTexts = this.mobileSkillBtns.map(btn =>
      this.add.text(btn.sx, btn.sy - 5 * s, btn.icon, { fontSize: iconSize }).setOrigin(0.5).setScrollFactor(0).setDepth(154)
    );
    this.mobileCdTexts = this.mobileSkillBtns.map(btn =>
      this.add.text(btn.sx, btn.sy + 10 * s, '', { fontSize: cdSize, fontFamily: '"Courier New"', color: '#ffffff', stroke: '#000', strokeThickness: 2 }).setOrigin(0.5).setScrollFactor(0).setDepth(155).setVisible(false)
    );
    this.mobileHudGfx = this.add.graphics().setScrollFactor(0).setDepth(152);
    if (this.skillBarBg)    this.skillBarBg.setVisible(false);
    if (this.skillHudGfx)   this.skillHudGfx.setVisible(false);
    for (const t of this.skillKeyTexts)  t.setVisible(false);
    for (const t of this.skillNameTexts) t.setVisible(false);
    for (const t of this.skillCdTexts)   t.setVisible(false);
  }

  setupMobileInput() {
    this.input.on('pointerdown', (ptr) => {
      if (!this.myId) return;
      const sx = ptr.x, sy = ptr.y, W = this.scale.width;
      if (this.mobileSkillBtns) {
        for (const btn of this.mobileSkillBtns) {
          const dx = sx - btn.sx, dy = sy - btn.sy;
          if (dx * dx + dy * dy <= btn.r * btn.r) { this.mobileSkillPressed[btn.skillKey] = true; btn.pressed = true; return; }
        }
      }
      if (sx < W / 2) { if (!this.lj.active) this.lj = { active: true, ox: sx, oy: sy, tx: sx, ty: sy, pid: ptr.id }; }
      else            { if (!this.rj.active) this.rj = { active: true, ox: sx, oy: sy, tx: sx, ty: sy, pid: ptr.id }; }
    });
    this.input.on('pointermove', (ptr) => {
      if (this.lj.active && ptr.id === this.lj.pid) { this.lj.tx = ptr.x; this.lj.ty = ptr.y; }
      if (this.rj.active && ptr.id === this.rj.pid) { this.rj.tx = ptr.x; this.rj.ty = ptr.y; }
    });
    this.input.on('pointerup', (ptr) => {
      if (this.lj.active && ptr.id === this.lj.pid) this.lj.active = false;
      if (this.rj.active && ptr.id === this.rj.pid) this.rj.active = false;
      if (this.mobileSkillBtns) for (const btn of this.mobileSkillBtns) btn.pressed = false;
    });
  }

  drawMobileControls(me) {
    if (!this.mobileHudGfx) return;
    const s = this._touchUiScale || 1;
    const g = this.mobileHudGfx.clear(), JR = 65 * s, knobR = 24 * s;
    if (this.lj.active) {
      const dx = this.lj.tx - this.lj.ox, dy = this.lj.ty - this.lj.oy;
      const dist = Math.sqrt(dx * dx + dy * dy), clampD = Math.min(dist, JR);
      const kx = this.lj.ox + (dist > 0 ? (dx / dist) * clampD : 0);
      const ky = this.lj.oy + (dist > 0 ? (dy / dist) * clampD : 0);
      g.fillStyle(0xffffff, 0.10); g.fillCircle(this.lj.ox, this.lj.oy, JR);
      g.lineStyle(1.5, 0xffffff, 0.25); g.strokeCircle(this.lj.ox, this.lj.oy, JR);
      g.fillStyle(0xffffff, 0.42); g.fillCircle(kx, ky, knobR);
    }
    if (this.rj.active) {
      const dx = this.rj.tx - this.rj.ox, dy = this.rj.ty - this.rj.oy;
      const dist = Math.sqrt(dx * dx + dy * dy), clampD = Math.min(dist, JR);
      const kx = this.rj.ox + (dist > 0 ? (dx / dist) * clampD : 0);
      const ky = this.rj.oy + (dist > 0 ? (dy / dist) * clampD : 0);
      const shooting = dist > JR * 0.2;
      g.fillStyle(0xffffff, 0.10); g.fillCircle(this.rj.ox, this.rj.oy, JR);
      g.lineStyle(1.5, 0xffffff, 0.25); g.strokeCircle(this.rj.ox, this.rj.oy, JR);
      g.fillStyle(shooting ? 0xff6644 : 0xffffff, shooting ? 0.55 : 0.42); g.fillCircle(kx, ky, knobR);
      if (shooting) { g.lineStyle(2, 0xff8844, 0.5); g.strokeCircle(kx, ky, knobR); }
    }
    if (!this.mobileSkillBtns) return;
    const cds = (me && me.skillCooldowns) ? me.skillCooldowns : {};
    this.mobileSkillBtns.forEach((btn, i) => {
      const remaining = cds[btn.cdKey] || 0, ready = remaining <= 0;
      const readyFrac = ready ? 1 : Math.max(0, 1 - remaining / btn.maxCD);
      if (btn.pressed) { g.fillStyle(btn.color, 0.55); g.fillCircle(btn.sx, btn.sy, btn.r); }
      g.lineStyle(3.5, 0x0d1a28, 0.9); g.beginPath(); g.arc(btn.sx, btn.sy, btn.r - 5, 0, Math.PI * 2, false); g.strokePath();
      if (ready) {
        g.lineStyle(3.5, btn.color, 0.92); g.beginPath(); g.arc(btn.sx, btn.sy, btn.r - 5, 0, Math.PI * 2, false); g.strokePath();
        g.lineStyle(7, btn.color, 0.18); g.strokeCircle(btn.sx, btn.sy, btn.r - 5);
        if (this.mobileCdTexts[i]) this.mobileCdTexts[i].setVisible(false);
      } else {
        if (readyFrac > 0.01) { g.lineStyle(3.5, btn.color, 0.72); g.beginPath(); g.arc(btn.sx, btn.sy, btn.r - 5, -Math.PI / 2, -Math.PI / 2 + readyFrac * Math.PI * 2, false); g.strokePath(); }
        g.fillStyle(0x000000, 0.42); g.fillCircle(btn.sx, btn.sy, btn.r - 6);
        if (this.mobileCdTexts[i]) this.mobileCdTexts[i].setText((remaining / 1000).toFixed(1)).setVisible(true);
      }
    });
  }

  shutdown() {
    if (this._onScaleResize) this.scale.off('resize', this._onScaleResize);
    socket.off('state', this._onState);
    socket.off('gameJoined');
    socket.off('pong');
    this.isMouseDown = false;
    this.lj.active = false; this.rj.active = false;
    for (const t of this.scoreboardTexts) t.destroy();
  }
}

// ═════════════════════════════════════════════════════════════
// GAME OVER SCENE
// ═════════════════════════════════════════════════════════════
class GameOverScene extends Phaser.Scene {
  constructor() { super('GameOver'); }

  init(data) {
    this.winner   = data.winner;
    this.scores   = data.scores;
    this.gameMode = data.gameMode || 'tdm';
  }

  create() {
    const W = this.scale.width, H = this.scale.height;
    const isRed = this.winner === 'red';
    const col   = isRed ? 0xff2244 : 0x2266ff;
    const cStr  = isRed ? '#ff4466' : '#4488ff';

    this.add.graphics()
      .fillGradientStyle(0x03030f, 0x03030f, isRed ? 0x1a0008 : 0x00081a, isRed ? 0x1a0008 : 0x00081a, 1)
      .fillRect(0, 0, W, H);

    const hg = this.add.graphics();
    const R = 36, hW = R * Math.sqrt(3), hH = R * 1.5;
    for (let row = -1; row < Math.ceil(H / hH) + 2; row++) {
      for (let col2 = -1; col2 < Math.ceil(W / hW) + 2; col2++) {
        const cx = col2 * hW + (row % 2 ? hW / 2 : 0), cy = row * hH;
        hg.lineStyle(1, isRed ? 0x2a0a12 : 0x0a122a, 0.6);
        hexPath(hg, cx, cy, R - 1); hg.strokePath();
      }
    }

    for (let i = 1; i <= 5; i++) {
      const ringG = this.add.graphics();
      ringG.lineStyle(1.5, col, 0.08); ringG.strokeCircle(W / 2, H * 0.38, i * 80);
      this.tweens.add({ targets: ringG, scaleX: { from: 0, to: 1 }, scaleY: { from: 0, to: 1 }, alpha: { from: 0.5, to: 0 }, duration: 2000 + i * 400, delay: i * 200, repeat: -1, ease: 'Sine.easeOut' });
      ringG.setOrigin(0).setPosition(W / 2, H * 0.38);
    }

    [18, 12, 6, 0].forEach((extra, idx) => {
      this.add.text(W / 2, H * 0.24, isRed ? 'RED TEAM WIN!' : 'BLUE TEAM WIN!', {
        fontSize: Math.min(58, W * 0.1) + 'px', fontFamily: '"Orbitron", "Arial Black"',
        color: idx === 3 ? '#ffffff' : '#00000000', stroke: cStr, strokeThickness: extra + 3,
      }).setOrigin(0.5).setAlpha(idx === 3 ? 1 : 0.15 + idx * 0.05);
    });

    this.add.text(W / 2, H * 0.36, (isRed ? '🔴 RED' : 'BLUE 🔵') + ' 팀 승리!', {
      fontSize: '26px', fontFamily: '"Rajdhani", "Arial Black"', color: cStr, stroke: '#000', strokeThickness: 4,
    }).setOrigin(0.5);

    const panW = 340, panH = 90, panX = W / 2 - panW / 2, panY = H * 0.45;
    const panG = this.add.graphics();
    panG.fillStyle(0x000000, 0.6); panG.fillRoundedRect(panX, panY, panW, panH, 10);
    panG.lineStyle(1.5, 0x334455, 0.8); panG.strokeRoundedRect(panX, panY, panW, panH, 10);
    this.add.text(W / 2, panY + 20, this.gameMode === 'ctf' ? '최 종  점 령 수' : '최 종  스 코 어', {
      fontSize: '11px', fontFamily: '"Rajdhani", "Courier New"', color: '#3a5a7a', letterSpacing: 4,
    }).setOrigin(0.5);
    const unitLabel = this.gameMode === 'ctf' ? '점' : '';
    this.add.text(W / 2, panY + 55, `🔴  ${this.scores.red}${unitLabel}  —  ${this.scores.blue}${unitLabel}  🔵`, {
      fontSize: '24px', fontFamily: '"Orbitron", "Arial Black"', color: '#ffffff', stroke: '#000', strokeThickness: 3,
    }).setOrigin(0.5);

    this.buildButton(W / 2, H * 0.72, '🔄  다시 하기', 0x116622, () => this.scene.start('Menu'));
    this.buildButton(W / 2, H * 0.82, '메인 메뉴',     0x1a2a3a, () => this.scene.start('Menu'));
    if (this.input.keyboard) {
      this.input.keyboard.on('keydown-ENTER', () => this.scene.start('Menu'));
      this.input.keyboard.on('keydown-SPACE', () => this.scene.start('Menu'));
    }
  }

  buildButton(x, y, label, color, cb) {
    const bW = 220, bH = 48;
    const g = this.add.graphics();
    const draw = (hover) => {
      g.clear();
      g.fillStyle(hover ? lightenColor(color, 30) : color, 1); g.fillRoundedRect(x - bW / 2, y - bH / 2, bW, bH, 8);
      g.lineStyle(1.5, 0x334455, hover ? 0.8 : 0.4); g.strokeRoundedRect(x - bW / 2, y - bH / 2, bW, bH, 8);
      g.fillStyle(0xffffff, 0.08); g.fillRoundedRect(x - bW / 2 + 4, y - bH / 2 + 4, bW - 8, bH / 2 - 6, 5);
    };
    draw(false);
    g.setInteractive(new Phaser.Geom.Rectangle(x - bW / 2, y - bH / 2, bW, bH), Phaser.Geom.Rectangle.Contains);
    g.on('pointerover', () => draw(true)); g.on('pointerout', () => draw(false)); g.on('pointerdown', cb);
    const t = this.add.text(x, y, label, { fontSize: '19px', fontFamily: '"Rajdhani", "Arial Black"', color: '#ffffff', stroke: '#000', strokeThickness: 2 }).setOrigin(0.5).setInteractive();
    t.on('pointerdown', cb);
  }
}

// ═════════════════════════════════════════════════════════════
// BOOT
// ═════════════════════════════════════════════════════════════
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game-container',
  backgroundColor: '#03030f',
  roundPixels: true,
  fps: { target: 60 },
  render: { powerPreference: 'high-performance', antialias: false },
  // FIT + CENTER_BOTH → equal letterboxing (not left-aligned) on tablets
  // Avoid `resolution: devicePixelRatio` — it mis-sizes canvas CSS on retina pads
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: 1280,
    height: 720,
    autoRound: true,
    expandParent: false,
  },
  dom: { createContainer: true },
  input: { activePointers: 5 },
  scene: [MenuScene, LobbyScene, GameScene, GameOverScene],
});

function refreshGameScale() {
  if (!game || !game.scale) return;
  game.scale.refresh();
  const gs = game.scene.getScene('Game');
  if (gs && gs.sys && gs.sys.settings && gs.sys.settings.active && typeof gs.syncCameraToWorld === 'function') {
    gs.syncCameraToWorld();
  }
}

window.addEventListener('resize', refreshGameScale);
window.addEventListener('orientationchange', () => {
  setTimeout(refreshGameScale, 50);
  setTimeout(refreshGameScale, 300);
});
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', refreshGameScale);
}
