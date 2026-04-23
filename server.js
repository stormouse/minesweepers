const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const GRID_W = 48;
const GRID_H = 30;
const MINE_COUNT = Math.floor(GRID_W * GRID_H * 0.17);
const TERRITORY_R = 2;
const PLAYER_COLORS = ['#ff1744', '#2979ff', '#00c853', '#ff6d00'];
const MAX_PLAYERS = 4;

const lobbies = new Map();
const clientMeta = new Map(); // ws -> { lobbyCode, playerId }

// --- HTTP: serve public/ ---
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const safePath = req.url === '/' ? '/index.html' : req.url.replace(/\.\./g, '');
  const filePath = path.join(__dirname, 'public', safePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
});

// --- WebSocket ---
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, msg);
  });
  ws.on('close', () => handleDisconnect(ws));
});

// --- Utilities ---
function uid() { return Math.random().toString(36).slice(2, 10); }

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (lobbies.has(code));
  return code;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(lobby, msg) {
  for (const p of lobby.players.values()) send(p.ws, msg);
}

// --- Grid ---
function makeGrid() {
  return Array.from({ length: GRID_H }, () =>
    Array.from({ length: GRID_W }, () => ({ mine: false, opened: false, flaggedBy: null, openedBy: null, number: 0 }))
  );
}

function neighbors(x, y) {
  const out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && nx < GRID_W && ny >= 0 && ny < GRID_H) out.push([nx, ny]);
  }
  return out;
}

function placeMines(grid, excludeSet) {
  const candidates = [];
  for (let y = 0; y < GRID_H; y++)
    for (let x = 0; x < GRID_W; x++)
      if (!excludeSet.has(`${x},${y}`)) candidates.push([x, y]);

  for (let i = 0; i < MINE_COUNT && i < candidates.length; i++) {
    const j = i + Math.floor(Math.random() * (candidates.length - i));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    const [mx, my] = candidates[i];
    grid[my][mx].mine = true;
  }

  for (let y = 0; y < GRID_H; y++)
    for (let x = 0; x < GRID_W; x++)
      if (!grid[y][x].mine)
        grid[y][x].number = neighbors(x, y).filter(([nx, ny]) => grid[ny][nx].mine).length;
}

// --- Territory ---
// Expands player.territory (Set of "x,y") to include all cells within TERRITORY_R of (x,y)
function expandTerritory(lobby, player, x, y) {
  for (let dy = -TERRITORY_R; dy <= TERRITORY_R; dy++)
    for (let dx = -TERRITORY_R; dx <= TERRITORY_R; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < GRID_W && ny >= 0 && ny < GRID_H && !isClaimed(lobby, nx, ny, player.id))
        player.territory.add(`${nx},${ny}`);
    }
}

function inTerritory(t, x, y) {
  return t !== null && t.has(`${x},${y}`);
}

// Returns true if (x,y) falls inside any active player's territory other than excludeId
function isClaimed(lobby, x, y, excludeId) {
  for (const p of lobby.players.values()) {
    if (p.id === excludeId || p.eliminated) continue;
    if (inTerritory(p.territory, x, y)) return true;
  }
  return false;
}

// --- Game actions ---
function doOpen(lobby, player, startX, startY) {
  const grid = lobby.grid;
  const changed = [];
  const queue = [[startX, startY]];
  const queued = new Set([`${startX},${startY}`]);

  while (queue.length) {
    const [cx, cy] = queue.shift();
    const cell = grid[cy][cx];
    if (cell.opened || cell.flaggedBy !== null) continue;

    cell.opened = true;
    cell.openedBy = player.id;
    player.openedSet.add(`${cx},${cy}`);
    expandTerritory(lobby, player, cx, cy);
    changed.push([cx, cy]);

    if (cell.mine) {
      player.eliminated = true;
      player.territory = null;
      break;
    }

    if (cell.number === 0) {
      for (const [nx, ny] of neighbors(cx, cy)) {
        const key = `${nx},${ny}`;
        if (queued.has(key)) continue;
        queued.add(key);
        const nc = grid[ny][nx];
        if (nc.opened || nc.flaggedBy !== null) continue;
        if (isClaimed(lobby, nx, ny, player.id)) continue;
        queue.push([nx, ny]);
      }
    }
  }

  return changed;
}

function doFlag(lobby, player, x, y) {
  const cell = lobby.grid[y][x];
  if (cell.opened) return false;
  if (cell.flaggedBy === player.id) { cell.flaggedBy = null; return true; }
  if (cell.flaggedBy === null) { cell.flaggedBy = player.id; return true; }
  return false;
}

function doChord(lobby, player, x, y) {
  const grid = lobby.grid;
  const cell = grid[y][x];
  if (!cell.opened || cell.number === 0) return [];
  const ns = neighbors(x, y);
  const flagCount = ns.filter(([nx, ny]) => grid[ny][nx].flaggedBy !== null).length;
  if (flagCount !== cell.number) return [];

  const changed = [];
  for (const [nx, ny] of ns) {
    const nc = grid[ny][nx];
    if (!nc.opened && nc.flaggedBy === null && inTerritory(player.territory, nx, ny)) {
      changed.push(...doOpen(lobby, player, nx, ny));
    }
  }
  return changed;
}

function checkWin(lobby) {
  const active = [...lobby.players.values()].filter(p => !p.eliminated);
  if (active.length === 0) return 'eliminated';

  for (let y = 0; y < GRID_H; y++)
    for (let x = 0; x < GRID_W; x++) {
      const c = lobby.grid[y][x];
      if (c.flaggedBy !== null && !c.mine) {
        const flagger = lobby.players.get(c.flaggedBy);
        if (!flagger || !flagger.eliminated) return null;
      }
      if (c.mine && !c.opened && c.flaggedBy === null) {
        if (active.some(p => inTerritory(p.territory, x, y))) return null;
      }
    }
  return 'cleared';
}

function endGame(lobby, reason) {
  lobby.phase = 'over';

  // Calculate scores
  const scores = {};
  for (const p of lobby.players.values()) {
    const area = p.territory ? p.territory.size : 0;
    let correctFlags = 0;
    for (let y = 0; y < GRID_H; y++)
      for (let x = 0; x < GRID_W; x++) {
        const c = lobby.grid[y][x];
        if (c.flaggedBy === p.id && c.mine) correctFlags++;
      }
    scores[p.id] = area + correctFlags * 2;
  }

  // Collect mine positions
  const mines = [];
  for (let y = 0; y < GRID_H; y++)
    for (let x = 0; x < GRID_W; x++)
      if (lobby.grid[y][x].mine) mines.push({ x, y });

  broadcast(lobby, { type: 'game_over', reason, scores, mines, players: serializePlayers(lobby) });
}

// --- Serialization ---
function serializeCell(cell) {
  return { opened: cell.opened, number: cell.opened ? cell.number : 0, flaggedBy: cell.flaggedBy, openedBy: cell.openedBy };
}

function serializePlayers(lobby) {
  return [...lobby.players.values()].map(p => ({
    id: p.id, name: p.name, color: p.color, isHost: p.isHost,
    eliminated: p.eliminated, territory: p.territory ? [...p.territory] : null, openedCount: p.openedSet.size,
  }));
}

// --- Message handlers ---
function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create': return onCreate(ws, msg);
    case 'join':   return onJoin(ws, msg);
    case 'start':  return onStart(ws);
    case 'open':   return onOpen(ws, msg);
    case 'flag':   return onFlag(ws, msg);
    case 'chord':  return onChord(ws, msg);
  }
}

function makePlayer(ws, name, color, isHost) {
  return {
    ws, id: uid(), name, color, isHost,
    eliminated: false,
    openedSet: new Set(),
    territory: new Set(),
  };
}

function onCreate(ws, { name }) {
  name = (name || '').trim().slice(0, 16);
  if (!name) return;
  const code = genCode();
  const player = makePlayer(ws, name, PLAYER_COLORS[0], true);
  const lobby = { code, phase: 'lobby', players: new Map([[player.id, player]]), grid: null };
  lobbies.set(code, lobby);
  clientMeta.set(ws, { lobbyCode: code, playerId: player.id });
  send(ws, { type: 'lobby_state', code, you: player.id, players: serializePlayers(lobby) });
}

function onJoin(ws, { name, code }) {
  name = (name || '').trim().slice(0, 16);
  code = (code || '').trim().toUpperCase();
  if (!name || !code) return;
  const lobby = lobbies.get(code);
  if (!lobby) { send(ws, { type: 'error', message: 'Lobby not found.' }); return; }
  if (lobby.phase !== 'lobby') { send(ws, { type: 'error', message: 'Game already started.' }); return; }
  if (lobby.players.size >= MAX_PLAYERS) { send(ws, { type: 'error', message: 'Lobby is full.' }); return; }

  const player = makePlayer(ws, name, PLAYER_COLORS[lobby.players.size], false);
  lobby.players.set(player.id, player);
  clientMeta.set(ws, { lobbyCode: code, playerId: player.id });

  send(ws, { type: 'lobby_state', code, you: player.id, players: serializePlayers(lobby) });
  broadcast(lobby, { type: 'players_update', players: serializePlayers(lobby) });
}

function onStart(ws) {
  const meta = clientMeta.get(ws);
  if (!meta) return;
  const lobby = lobbies.get(meta.lobbyCode);
  if (!lobby || lobby.phase !== 'lobby') return;
  const player = lobby.players.get(meta.playerId);
  if (!player || !player.isHost) return;

  lobby.phase = 'game';
  lobby.grid = makeGrid();

  const players = [...lobby.players.values()];
  const startPos = [
    [Math.floor(GRID_W * 0.15), Math.floor(GRID_H * 0.2)],
    [Math.floor(GRID_W * 0.85), Math.floor(GRID_H * 0.8)],
    [Math.floor(GRID_W * 0.85), Math.floor(GRID_H * 0.2)],
    [Math.floor(GRID_W * 0.15), Math.floor(GRID_H * 0.8)],
  ].slice(0, players.length);

  // Exclude 5x5 area around each start from mines
  const excludeSet = new Set();
  startPos.forEach(([sx, sy]) => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = sx + dx, ny = sy + dy;
      if (nx >= 0 && nx < GRID_W && ny >= 0 && ny < GRID_H) excludeSet.add(`${nx},${ny}`);
    }
  });
  placeMines(lobby.grid, excludeSet);

  // Pre-initialize territories so flood fills respect each other from the start
  players.forEach((p, i) => expandTerritory(lobby, p, startPos[i][0], startPos[i][1]));

  // Open starting squares (flood fill may expand territory)
  const allChanged = [];
  players.forEach((p, i) => allChanged.push(...doOpen(lobby, p, startPos[i][0], startPos[i][1])));

  // Build full grid snapshot (no mine positions)
  const gridSnapshot = Array.from({ length: GRID_H }, (_, y) =>
    Array.from({ length: GRID_W }, (_, x) => serializeCell(lobby.grid[y][x]))
  );

  broadcast(lobby, { type: 'game_start', grid: gridSnapshot, players: serializePlayers(lobby) });
}

function getContext(ws) {
  const meta = clientMeta.get(ws);
  if (!meta) return null;
  const lobby = lobbies.get(meta.lobbyCode);
  if (!lobby || lobby.phase !== 'game') return null;
  const player = lobby.players.get(meta.playerId);
  if (!player || player.eliminated) return null;
  return { lobby, player };
}

function broadcastUpdate(lobby, changedCoords) {
  const cells = changedCoords.map(([x, y]) => ({ x, y, ...serializeCell(lobby.grid[y][x]) }));
  broadcast(lobby, { type: 'update', cells, players: serializePlayers(lobby) });
}

function onOpen(ws, { x, y }) {
  const ctx = getContext(ws);
  if (!ctx) return;
  const { lobby, player } = ctx;
  if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;
  if (!inTerritory(player.territory, x, y)) return;
  if (lobby.grid[y][x].opened) return;

  const changed = doOpen(lobby, player, x, y);
  if (!changed.length) return;

  // If player hit a mine, mark the cell as mine in the update so client knows
  const extra = {};
  if (player.eliminated) {
    const mineCell = changed.find(([cx, cy]) => lobby.grid[cy][cx].mine);
    if (mineCell) extra.explodedAt = { x: mineCell[0], y: mineCell[1] };
  }

  const cells = changed.map(([cx, cy]) => {
    const c = { x: cx, y: cy, ...serializeCell(lobby.grid[cy][cx]) };
    if (player.eliminated && lobby.grid[cy][cx].mine) c.mine = true;
    return c;
  });
  broadcast(lobby, { type: 'update', cells, players: serializePlayers(lobby) });

  const win = checkWin(lobby);
  if (win) endGame(lobby, win);
}

function onFlag(ws, { x, y }) {
  const ctx = getContext(ws);
  if (!ctx) return;
  const { lobby, player } = ctx;
  if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;
  if (!inTerritory(player.territory, x, y)) return;

  if (!doFlag(lobby, player, x, y)) return;
  broadcastUpdate(lobby, [[x, y]]);

  const win = checkWin(lobby);
  if (win) endGame(lobby, win);
}

function onChord(ws, { x, y }) {
  const ctx = getContext(ws);
  if (!ctx) return;
  const { lobby, player } = ctx;
  if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;
  if (!inTerritory(player.territory, x, y)) return;

  const changed = doChord(lobby, player, x, y);
  if (!changed.length) return;

  const cells = changed.map(([cx, cy]) => {
    const c = { x: cx, y: cy, ...serializeCell(lobby.grid[cy][cx]) };
    if (player.eliminated && lobby.grid[cy][cx].mine) c.mine = true;
    return c;
  });
  broadcast(lobby, { type: 'update', cells, players: serializePlayers(lobby) });

  const win = checkWin(lobby);
  if (win) endGame(lobby, win);
}

function handleDisconnect(ws) {
  const meta = clientMeta.get(ws);
  if (!meta) return;
  clientMeta.delete(ws);
  const lobby = lobbies.get(meta.lobbyCode);
  if (!lobby) return;
  const player = lobby.players.get(meta.playerId);
  if (!player) return;

  if (lobby.phase === 'lobby') {
    lobby.players.delete(meta.playerId);
    if (lobby.players.size === 0) { lobbies.delete(meta.lobbyCode); return; }
    if (player.isHost) lobby.players.values().next().value.isHost = true;
    broadcast(lobby, { type: 'players_update', players: serializePlayers(lobby) });
  } else if (lobby.phase === 'game') {
    player.eliminated = true;
    player.territory = null;
    broadcast(lobby, { type: 'update', cells: [], players: serializePlayers(lobby) });
    const win = checkWin(lobby);
    if (win) endGame(lobby, win);
  }
}

server.listen(3000, () => console.log('Minesweepers running → http://localhost:3000'));
