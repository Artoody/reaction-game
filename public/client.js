const socket = io();
const $ = id => document.getElementById(id);

let me = null;
let room = null;

const home = $('home');
const roomView = $('room');

function showError(msg) {
  $('error').textContent = msg;
  $('error2').textContent = msg;
  if (msg) setTimeout(() => showError(''), 3500);
}

function getName() {
  const name = $('name').value.trim();
  if (!name) {
    showError('Please type your name first.');
    $('name').focus();
    return null;
  }
  localStorage.setItem('gl-name', name);
  return name;
}

$('name').value = localStorage.getItem('gl-name') || '';

$('create').onclick = () => {
  const name = getName();
  if (name) socket.emit('create', name);
};

$('join').onclick = () => {
  const name = getName();
  if (!name) return;
  const code = $('code').value.trim();
  if (code.length !== 4) return showError('Room codes have 4 letters.');
  socket.emit('join', { code, name });
};

$('code').addEventListener('keydown', e => { if (e.key === 'Enter') $('join').click(); });
$('name').addEventListener('keydown', e => { if (e.key === 'Enter') $('create').click(); });

$('copy').onclick = () => {
  if (!room) return;
  const text = room.code;
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
    .then(() => flash($('copy'), 'Copied!'))
    .catch(() => flash($('copy'), text));
};

function flash(el, text) {
  const old = el.textContent;
  el.textContent = text;
  setTimeout(() => (el.textContent = old), 1200);
}

$('start').onclick = () => socket.emit('start');
$('next').onclick = () => socket.emit('next');
$('rounds').onchange = e => socket.emit('setRounds', Number(e.target.value));

function press() {
  if (room && (room.state === 'waiting' || room.state === 'go')) socket.emit('press');
}

// Pointer-down is faster than click, which matters in a reaction game.
$('pad').addEventListener('pointerdown', e => { e.preventDefault(); press(); });
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !e.repeat && document.activeElement.tagName !== 'SELECT') {
    e.preventDefault();
    press();
  }
});

socket.on('joined', data => {
  me = data.you;
  home.classList.add('hidden');
  roomView.classList.remove('hidden');
});

socket.on('problem', showError);
socket.on('room', r => { room = r; render(); });

function ordinal(n) {
  return ['1st', '2nd', '3rd', '4th', '5th'][n - 1] || n + 'th';
}

function render() {
  $('roomCode').textContent = room.code;
  const isHost = room.hostId === me;
  const inLobby = room.state === 'lobby';
  const resultOf = id => (room.results || []).find(r => r.id === id);
  const names = ids => room.players.filter(p => ids.includes(p.id)).map(p => p.name).join(' & ');

  // Round badge
  $('roundBadge').textContent = inLobby ? '' : `Round ${room.round} of ${room.rounds}`;

  // Scoreboard (sorted by score once the game has started)
  const list = room.players.slice();
  if (!inLobby) list.sort((a, b) => b.score - a.score);
  const topScore = list.length ? list[0].score : 0;

  const ul = $('players');
  ul.innerHTML = '';
  list.forEach((p, i) => {
    const res = resultOf(p.id);
    const li = document.createElement('li');
    li.className = 'player'
      + (!inLobby && topScore > 0 && p.score === topScore ? ' first' : '')
      + (room.state === 'waiting' && p.out ? ' out' : '');

    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = inLobby ? '' : (room.state === 'gameover' && room.championIds.includes(p.id) ? '🏆' : i + 1);

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color;

    const info = document.createElement('span');
    info.className = 'info';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.name;
    if (p.id === me) name.insertAdjacentHTML('beforeend', '<span class="tag">you</span>');
    if (p.id === room.hostId) name.insertAdjacentHTML('beforeend', '<span class="tag">host</span>');
    info.append(name);

    const chip = document.createElement('span');
    chip.className = 'chip';
    if (room.state === 'waiting') {
      if (p.out) { chip.textContent = 'Too early'; chip.classList.add('bad'); }
    } else if (room.state === 'go') {
      if (room.pressedIds.includes(p.id)) { chip.textContent = 'Pressed'; chip.classList.add('good'); }
    } else if (res) {
      if (res.status === 'ok') { chip.textContent = `${ordinal(res.place)} · ${res.ms} ms · +${res.points}`; chip.classList.add('good'); }
      else if (res.status === 'early') { chip.textContent = 'Too early · +0'; chip.classList.add('bad'); }
      else { chip.textContent = 'No press · +0'; chip.classList.add('bad'); }
    }
    if (chip.textContent) info.append(chip);

    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = inLobby ? '' : p.score;

    li.append(rank, dot, info, score);
    ul.append(li);
  });

  // Settings (rounds)
  $('rounds').value = String(room.rounds);
  $('rounds').disabled = !isHost || !(inLobby || room.state === 'gameover');
  $('settings').classList.toggle('hidden', !(inLobby || room.state === 'gameover'));

  // Buttons + pad
  const pad = $('pad');
  const padText = $('padText');
  const padSub = $('padSub');
  const startBtn = $('start');
  const nextBtn = $('next');
  const hint = $('hint');

  startBtn.classList.add('hidden');
  nextBtn.classList.add('hidden');
  pad.className = 'pad hidden';

  const mine = room.players.find(p => p.id === me);
  const myRes = resultOf(me);

  if (inLobby) {
    hint.textContent = room.players.length < 2
      ? 'Share the code with friends. You need 2 to 5 players.'
      : `${room.players.length}/5 players ready.`;
    if (isHost) {
      startBtn.classList.remove('hidden');
      startBtn.textContent = 'Start game';
      startBtn.disabled = room.players.length < 2;
      startBtn.style.opacity = room.players.length < 2 ? .5 : 1;
    } else {
      hint.textContent += ' Waiting for the host to start.';
    }
    return;
  }

  pad.classList.remove('hidden');
  hint.textContent = '1st place gets 5 points, 2nd gets 4, and so on.';

  if (room.state === 'waiting') {
    if (mine && mine.out) {
      pad.className = 'pad done';
      padText.textContent = 'Too early!';
      padSub.textContent = "You're out this round.";
    } else {
      pad.className = 'pad wait';
      padText.textContent = 'Wait for green...';
      padSub.textContent = "Don't press yet!";
    }
  } else if (room.state === 'go') {
    if (room.pressedIds.includes(me)) {
      pad.className = 'pad got';
      padText.textContent = 'Got it!';
      padSub.textContent = 'Waiting for the others...';
    } else {
      pad.className = 'pad go';
      padText.textContent = 'PRESS!';
      padSub.textContent = 'You have 1 second';
    }
  } else {
    // result or gameover
    if (myRes && myRes.status === 'ok') {
      pad.className = myRes.place === 1 ? 'pad win' : 'pad done';
      padText.textContent = `You came ${ordinal(myRes.place)}!`;
      padSub.textContent = `${myRes.ms} ms · +${myRes.points} points`;
    } else if (myRes && myRes.status === 'early') {
      pad.className = 'pad done';
      padText.textContent = 'Too early!';
      padSub.textContent = '+0 points';
    } else {
      pad.className = 'pad done';
      padText.textContent = 'Too slow!';
      padSub.textContent = 'You did not press in time. +0 points';
    }

    if (room.state === 'result') {
      if (isHost) nextBtn.classList.remove('hidden');
      else hint.textContent = 'Waiting for the host to start the next round.';
    } else {
      const champs = names(room.championIds);
      const iWon = room.championIds.includes(me);
      pad.className = iWon ? 'pad win' : 'pad done';
      padText.textContent = iWon ? 'You won the game!' : `${champs} won!`;
      padSub.textContent = `Final score: ${mine ? mine.score : 0} points`;
      hint.textContent = isHost ? 'Pick the rounds and play again.' : 'Waiting for the host to play again.';
      if (isHost) {
        startBtn.classList.remove('hidden');
        startBtn.textContent = 'Play again';
        startBtn.disabled = false;
        startBtn.style.opacity = 1;
      }
    }
  }
}
