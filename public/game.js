'use strict';

const GRID_W = 48;
const GRID_H = 30;
const MINE_COUNT = Math.floor(GRID_W * GRID_H * 0.17);
let CELL = 14; // px per cell — recalculated on start/resize

function calcCellSize() {
  const SIDEBAR = 160;
  const availW = window.innerWidth  - SIDEBAR - 2;
  const availH = window.innerHeight - 2;
  return Math.max(8, Math.floor(Math.min(availW / GRID_W, availH / GRID_H)));
}

const NUM_COLORS = ['', '#0057ff', '#00aa00', '#ff1100', '#8800ee', '#ff4400', '#00aacc', '#111', '#777'];
const HEARTBEAT_INTERVAL = 5000; // 5s

let ws, myId, myLobbyCode, heartbeat;
let players = [];
let grid = null; // [y][x] = { opened, number, flaggedBy, openedBy, mine? }
let playerTerritories = new Map(); // playerId -> Set<"x,y">

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $  = (id) => document.getElementById(id);
const lobbyScreen  = $('lobby-screen');
const gameScreen   = $('game-screen');
const overlay      = $('overlay');
const canvas       = $('game-canvas');
const ctx          = canvas.getContext('2d');

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}${location.pathname}`);
  ws.onopen    = () => {
    heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, HEARTBEAT_INTERVAL);
  };
  ws.onmessage = (e) => {
    if (e.data.toString() === 'pong') { return; }
    dispatch(JSON.parse(e.data));
  };
  ws.onclose   = () => { $('error-msg').textContent = 'Disconnected from server.'; clearInterval(heartbeat); };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ── Message dispatch ──────────────────────────────────────────────────────────
function dispatch(msg) {
  switch (msg.type) {
    case 'lobby_state':    onLobbyState(msg);   break;
    case 'players_update': onPlayersUpdate(msg); break;
    case 'game_start':     onGameStart(msg);     break;
    case 'update':         onUpdate(msg);        break;
    case 'game_over':      onGameOver(msg);      break;
    case 'error':          $('error-msg').textContent = msg.message; break;
  }
}

function onLobbyState(msg) {
  myId = msg.you;
  myLobbyCode = msg.code;
  players = msg.players;

  lobbyScreen.style.display = 'flex';
  gameScreen.style.display  = 'none';

  $('lobby-code-display').textContent = msg.code;
  $('lobby-waiting').style.display    = 'flex';

  const isHost = players.find(p => p.id === myId)?.isHost;
  $('start-btn').style.display   = isHost ? 'block' : 'none';
  $('waiting-msg').style.display = isHost ? 'none'  : 'block';

  renderPlayerList();
}

function onPlayersUpdate(msg) {
  players = msg.players;
  renderPlayerList();
  if (grid) renderScoreboard();
}

function onGameStart(msg) {
  grid    = msg.grid;
  players = msg.players;

  lobbyScreen.style.display = 'none';
  gameScreen.style.display  = 'block';
  overlay.style.display     = 'none';

  resizeCanvas();
  computePlayerTerritories();
  renderScoreboard();
  updateMineCounter();
}

function onUpdate(msg) {
  for (const c of msg.cells) {
    const cell = grid[c.y][c.x];
    cell.opened    = c.opened;
    cell.number    = c.number;
    cell.flaggedBy = c.flaggedBy;
    cell.openedBy  = c.openedBy;
    if (c.mine) cell.mine = true;
  }
  players = msg.players;
  computePlayerTerritories();
  renderScoreboard();
  updateMineCounter();
  renderGrid();
}

function onGameOver(msg) {
  for (const m of msg.mines) {
    grid[m.y][m.x].mine = true;
  }
  players = msg.players;
  renderGrid();

  const title = msg.reason === 'cleared' ? 'Mines Cleared!' : 'All Eliminated';
  $('overlay-title').textContent = title;

  const sorted = [...players].sort((a, b) => (msg.scores[b.id] || 0) - (msg.scores[a.id] || 0));
  $('overlay-scores').innerHTML = sorted.map(p => `
    <div class="overlay-score-row">
      <span class="dot" style="background:${p.color}"></span>
      <span class="sname">${esc(p.name)}</span>
      <span class="sval" style="color:${p.color}">${msg.scores[p.id] || 0}</span>
    </div>
  `).join('');
  overlay.style.display = 'flex';
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function renderPlayerList() {
  $('player-list').innerHTML = players.map(p => `
    <div class="player-entry">
      <span class="player-dot" style="background:${p.color}"></span>
      <span class="player-name">${esc(p.name)}</span>
      ${p.isHost ? '<span class="player-badge">host</span>' : ''}
    </div>
  `).join('');
}

function computePlayerTerritories() {
  playerTerritories.clear();
  for (const p of players) {
    if (p.eliminated || !p.territory) continue;
    playerTerritories.set(p.id, new Set(p.territory));
  }
}

function renderScoreboard() {
  $('scoreboard').innerHTML = players.map(p => {
    const tSize = (playerTerritories.get(p.id) || new Set()).size;
    return `
      <div class="score-entry ${p.eliminated ? 'eliminated' : ''}">
        <div class="score-name" style="color:${p.color}">
          <span class="dot" style="background:${p.color}"></span>
          ${esc(p.name)}
        </div>
        <div class="score-val">${tSize} sq · ${p.openedCount} open</div>
      </div>
    `;
  }).join('');
}

function updateMineCounter() {
  let flags = 0;
  for (let y = 0; y < GRID_H; y++)
    for (let x = 0; x < GRID_W; x++)
      if (grid[y][x].flaggedBy !== null) flags++;
  $('mine-count').textContent = MINE_COUNT - flags;
}

function playerById(id) { return players.find(p => p.id === id); }

function renderGrid() {
  if (!grid) return;

  // Draw all cells
  for (let y = 0; y < GRID_H; y++)
    for (let x = 0; x < GRID_W; x++)
      drawCell(x, y);

  // Draw territory contours on top
  for (const p of players) {
    if (p.eliminated) continue;
    const tSet = playerTerritories.get(p.id);
    if (tSet && tSet.size > 0) drawTerritory(p, tSet);
  }
}

function drawCell(x, y) {
  const cell = grid[y][x];
  const px = x * CELL, py = y * CELL;
  const cx = px + CELL / 2, cy = py + CELL / 2;

  if (!cell.opened) {
    // Raised bevel — classic minesweeper feel in light mode
    const base = '#b8c4dc';
    const hi   = '#dde6f8';
    const sh   = '#8898b4';
    const bv   = Math.max(1, Math.floor(CELL / 7));

    ctx.fillStyle = base;
    ctx.fillRect(px, py, CELL, CELL);
    ctx.fillStyle = hi;
    ctx.fillRect(px, py, CELL, bv);
    ctx.fillRect(px, py, bv, CELL);
    ctx.fillStyle = sh;
    ctx.fillRect(px, py + CELL - bv, CELL, bv);
    ctx.fillRect(px + CELL - bv, py, bv, CELL);

    if (cell.flaggedBy !== null) {
      const p = playerById(cell.flaggedBy);
      drawFlag(cx, cy, p ? p.color : '#333');
    }
    return;
  }

  // Opened cell
  if (cell.mine) {
    ctx.fillStyle = '#ffd0d0';
    ctx.fillRect(px, py, CELL, CELL);
    ctx.strokeStyle = '#e8b8b8';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(px + 0.5, py + 0.5, CELL - 1, CELL - 1);
    drawMine(cx, cy);
    return;
  }

  // Normal opened — inset look
  ctx.fillStyle = '#e8ecf8';
  ctx.fillRect(px, py, CELL, CELL);

  // Player color tint
  if (cell.openedBy) {
    const p = playerById(cell.openedBy);
    if (p) {
      ctx.fillStyle = hexAlpha(p.color, 0.12);
      ctx.fillRect(px, py, CELL, CELL);
    }
  }

  // Subtle inset border
  ctx.strokeStyle = '#c8d0e8';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(px + 0.5, py + 0.5, CELL - 1, CELL - 1);

  if (cell.number > 0) {
    ctx.fillStyle = NUM_COLORS[cell.number] || '#333';
    ctx.font = `bold ${Math.max(9, CELL - 4)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(cell.number, cx, cy + 0.5);
  }
}

function drawFlag(cx, cy, color) {
  const r = CELL / 2 - Math.max(2, CELL * 0.15);
  // Shadow
  ctx.shadowColor = hexAlpha(color, 0.4);
  ctx.shadowBlur  = CELL * 0.4;
  ctx.fillStyle   = color;
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.1, cy - r);
  ctx.lineTo(cx + r * 0.9, cy - r * 0.15);
  ctx.lineTo(cx - r * 0.1, cy + r * 0.35);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  // Pole
  ctx.strokeStyle = color;
  ctx.lineWidth   = Math.max(1, CELL * 0.09);
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.1, cy - r);
  ctx.lineTo(cx - r * 0.1, cy + r);
  ctx.stroke();
}

function drawMine(cx, cy) {
  const r = Math.max(3, CELL / 2 - 2);
  ctx.shadowColor = 'rgba(255,0,0,0.45)';
  ctx.shadowBlur  = CELL * 0.6;
  const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
  grad.addColorStop(0, '#ff6655');
  grad.addColorStop(1, '#cc0022');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  // Spikes
  ctx.strokeStyle = '#aa0011';
  ctx.lineWidth = Math.max(1, CELL * 0.09);
  for (let a = 0; a < 8; a++) {
    const angle = (a / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * (r + 1), cy + Math.sin(angle) * (r + 1));
    ctx.lineTo(cx + Math.cos(angle) * (r + r * 0.55), cy + Math.sin(angle) * (r + r * 0.55));
    ctx.stroke();
  }
  // Shine
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.arc(cx - r * 0.3, cy - r * 0.3, r * 0.22, 0, Math.PI * 2);
  ctx.fill();
}

function drawTerritory(player, tSet) {
  ctx.shadowColor = hexAlpha(player.color, 0.55);
  ctx.shadowBlur  = 5;
  ctx.strokeStyle = player.color;
  ctx.lineWidth   = 2.5;
  ctx.lineCap     = 'square';

  ctx.beginPath();
  for (const key of tSet) {
    const comma = key.indexOf(',');
    const x = +key.slice(0, comma), y = +key.slice(comma + 1);
    const px = x * CELL, py = y * CELL;
    if (!tSet.has(`${x},${y - 1}`)) { ctx.moveTo(px, py);        ctx.lineTo(px + CELL, py);        }
    if (!tSet.has(`${x},${y + 1}`)) { ctx.moveTo(px, py + CELL); ctx.lineTo(px + CELL, py + CELL); }
    if (!tSet.has(`${x - 1},${y}`)) { ctx.moveTo(px, py);        ctx.lineTo(px, py + CELL);        }
    if (!tSet.has(`${x + 1},${y}`)) { ctx.moveTo(px + CELL, py); ctx.lineTo(px + CELL, py + CELL); }
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function hexAlpha(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Input ─────────────────────────────────────────────────────────────────────
let leftDown = false, rightDown = false;
let leftCell = null, rightCell = null;
let chordFired = false;

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('mousedown', (e) => {
  const cell = cellAt(e);
  if (!cell) return;

  if (e.button === 0) {
    leftDown = true;
    leftCell = cell;
    if (rightDown) { chordFired = true; send({ type: 'chord', x: cell[0], y: cell[1] }); }
  } else if (e.button === 2) {
    rightDown = true;
    rightCell = cell;
    if (leftDown) { chordFired = true; send({ type: 'chord', x: cell[0], y: cell[1] }); }
  }
});

canvas.addEventListener('mouseup', (e) => {
  if (e.button === 0) {
    if (leftDown && !rightDown && !chordFired && leftCell)
      send({ type: 'open', x: leftCell[0], y: leftCell[1] });
    leftDown = false;
    leftCell = null;
    if (!rightDown) chordFired = false;
  } else if (e.button === 2) {
    if (rightDown && !leftDown && !chordFired && rightCell)
      send({ type: 'flag', x: rightCell[0], y: rightCell[1] });
    rightDown = false;
    rightCell = null;
    if (!leftDown) chordFired = false;
  }
});

function cellAt(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = Math.floor((e.clientX - rect.left) * scaleX / CELL);
  const y = Math.floor((e.clientY - rect.top) * scaleY / CELL);
  if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return null;
  return [x, y];
}

// ── Lobby UI ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const prev_name = localStorage.getItem('previous_name');
  if (prev_name) {
    $('name-input').value = localStorage.getItem('previous_name');
  }
});

$('create-btn').addEventListener('click', () => {
  const name = $('name-input').value.trim();
  if (!name) { $('error-msg').textContent = 'Enter a name.'; return; }
  $('error-msg').textContent = '';
  localStorage.setItem('previous_name', name);
  send({ type: 'create', name });
});

$('join-btn').addEventListener('click', () => {
  const name = $('name-input').value.trim();
  const code = $('code-input').value.trim().toUpperCase();
  if (!name) { $('error-msg').textContent = 'Enter a name.'; return; }
  if (code.length !== 4) { $('error-msg').textContent = 'Enter a 4-character lobby code.'; return; }
  $('error-msg').textContent = '';
  send({ type: 'join', name, code });
});

$('code-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('join-btn').click();
});

$('name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('create-btn').click();
});

$('start-btn').addEventListener('click', () => send({ type: 'start' }));

$('copy-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(myLobbyCode).catch(() => {});
  $('copy-btn').textContent = 'Copied!';
  setTimeout(() => { $('copy-btn').textContent = 'Copy'; }, 1500);
});

// ── Resize ────────────────────────────────────────────────────────────────────
function resizeCanvas() {
  CELL = calcCellSize();
  canvas.width  = GRID_W * CELL;
  canvas.height = GRID_H * CELL;
  renderGrid();
}

window.addEventListener('resize', () => { if (grid) resizeCanvas(); });

// ── Init ──────────────────────────────────────────────────────────────────────
connect();
