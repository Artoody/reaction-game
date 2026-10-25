const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const MAX_PLAYERS = 5;
const ROUND_OPTIONS = [3, 5, 10];
const DEFAULT_ROUNDS = 5;
const GO_WINDOW = 1000;      // everyone has 1 second after the light turns green
const GRACE = 200;           // small extra time on the server to cover network delay
const POINTS = [5, 4, 3, 2, 1]; // points for 1st, 2nd, 3rd... place
const COLORS = ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#b05cff'];
const rooms = new Map();

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 14) || 'Player';
}

function publicState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    round: room.round,
    rounds: room.rounds,
    goWindow: GO_WINDOW,
    pressedIds: Object.keys(room.presses),
    results: room.results,
    championIds: room.championIds,
    players: room.players.map(p => ({
      id: p.id, name: p.name, score: p.score, color: p.color, out: p.out
    }))
  };
}

function broadcast(room) {
  io.to(room.code).emit('room', publicState(room));
}

function startRound(room) {
  clearTimeout(room.timer);
  room.state = 'waiting';
  room.round += 1;
  room.presses = {};
  room.results = null;
  room.players.forEach(p => (p.out = false));
  broadcast(room);

  const delay = 2000 + Math.random() * 4500;
  room.timer = setTimeout(() => {
    room.state = 'go';
    room.goTime = Date.now();
    broadcast(room);
    room.timer = setTimeout(() => finishRound(room), GO_WINDOW + GRACE);
  }, delay);
}

function finishRound(room) {
  clearTimeout(room.timer);

  const pressed = room.players
    .filter(p => room.presses[p.id] !== undefined)
    .sort((a, b) => room.presses[a.id] - room.presses[b.id]);

  const results = pressed.map((p, i) => {
    const points = POINTS[i] || 0;
    p.score += points;
    return { id: p.id, status: 'ok', ms: room.presses[p.id], place: i + 1, points };
  });

  room.players
    .filter(p => room.presses[p.id] === undefined)
    .forEach(p => results.push({
      id: p.id, status: p.out ? 'early' : 'miss', ms: null, place: null, points: 0
    }));

  room.results = results;

  if (room.round >= room.rounds) {
    room.state = 'gameover';
    const best = Math.max(...room.players.map(p => p.score));
    room.championIds = room.players.filter(p => p.score === best).map(p => p.id);
  } else {
    room.state = 'result';
  }
  broadcast(room);
}

// End the round early when nobody else can still press.
function checkRoundDone(room) {
  if (room.state === 'waiting') {
    if (room.players.length > 0 && room.players.every(p => p.out)) finishRound(room);
  } else if (room.state === 'go') {
    const active = room.players.filter(p => !p.out);
    if (active.every(p => room.presses[p.id] !== undefined)) finishRound(room);
  }
}

io.on('connection', socket => {
  let room = null;

  function enter(r, name) {
    const player = {
      id: socket.id,
      name: cleanName(name),
      score: 0,
      out: false,
      color: COLORS.find(c => !r.players.some(p => p.color === c)) || COLORS[0]
    };
    r.players.push(player);
    room = r;
    socket.join(r.code);
    socket.emit('joined', { code: r.code, you: socket.id });
    broadcast(r);
  }

  socket.on('create', name => {
    const r = {
      code: makeCode(), hostId: socket.id, players: [], state: 'lobby',
      round: 0, rounds: DEFAULT_ROUNDS, presses: {}, results: null,
      championIds: [], timer: null, goTime: 0
    };
    rooms.set(r.code, r);
    enter(r, name);
  });

  socket.on('join', ({ code, name }) => {
    const r = rooms.get(String(code || '').trim().toUpperCase());
    if (!r) return socket.emit('problem', 'Room not found. Check the code.');
    if (r.players.length >= MAX_PLAYERS) return socket.emit('problem', 'This room is full (5 players max).');
    if (r.state !== 'lobby' && r.state !== 'gameover') return socket.emit('problem', 'A game is in progress. Try again when it ends.');
    enter(r, name);
  });

  socket.on('setRounds', n => {
    if (!room || room.hostId !== socket.id) return;
    if (room.state !== 'lobby' && room.state !== 'gameover') return;
    if (ROUND_OPTIONS.includes(Number(n))) {
      room.rounds = Number(n);
      broadcast(room);
    }
  });

  socket.on('start', () => {
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 2) return socket.emit('problem', 'You need at least 2 players.');
    if (room.state === 'lobby' || room.state === 'gameover') {
      room.players.forEach(p => (p.score = 0));
      room.round = 0;
      room.championIds = [];
      startRound(room);
    }
  });

  socket.on('next', () => {
    if (!room || room.hostId !== socket.id || room.state !== 'result') return;
    startRound(room);
  });

  socket.on('press', () => {
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.out) return;

    if (room.state === 'waiting') {
      player.out = true; // pressed before green
      broadcast(room);
      checkRoundDone(room);
    } else if (room.state === 'go') {
      if (room.presses[player.id] !== undefined) return; // only your first press counts
      room.presses[player.id] = Date.now() - room.goTime;
      broadcast(room);
      checkRoundDone(room);
    }
  });

  socket.on('disconnect', () => {
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) {
      clearTimeout(room.timer);
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === socket.id) room.hostId = room.players[0].id;
    if (room.players.length < 2 && room.state !== 'lobby' && room.state !== 'gameover') {
      clearTimeout(room.timer);
      room.state = 'lobby';
      room.round = 0;
      room.results = null;
      room.presses = {};
      room.players.forEach(p => { p.score = 0; p.out = false; });
      broadcast(room);
      return;
    }
    broadcast(room);
    checkRoundDone(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Green Light running on http://localhost:${PORT}`));
