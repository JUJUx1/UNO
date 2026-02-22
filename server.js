// ================================================================
//  UNO Multiplayer — Socket.io Server
//  Deploy on Render.com (free tier)
//  Start command: node server.js
//  Build command: npm install
// ================================================================

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 10000,
  pingTimeout:  25000,
});

// ── Health check (keeps Render free tier alive with UptimeRobot) ──
app.get('/', (_req, res) => res.send('UNO Server OK'));

// ================================================================
//  In-memory state
// ================================================================
const rooms = {};
// rooms[code] = {
//   code, hostId,
//   players: [ { id, name, avatar, uid, isHost } ],
//   settings: { cards:7, stacking:false },
//   game: null | { deck, hands, discardPile, discardTop,
//                  currentColor, currentValue,
//                  turnOrder, currentTurnIdx, direction,
//                  handCounts, finishOrder, unoFlags, active }
// }

// ================================================================
//  Helpers
// ================================================================
function genCode() {
  const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += ch[Math.floor(Math.random() * ch.length)];
  return c;
}

function buildDeck() {
  const COLS  = ['red','yellow','green','blue'];
  const NUMS  = ['0','1','2','3','4','5','6','7','8','9'];
  const SPEC  = ['skip','reverse','draw2'];
  const d = [];
  for (const c of COLS) {
    d.push({ color:c, value:'0' });
    for (const n of NUMS.slice(1)) { d.push({color:c,value:n}); d.push({color:c,value:n}); }
    for (const s of SPEC)          { d.push({color:c,value:s}); d.push({color:c,value:s}); }
  }
  for (const w of ['wild','wild_draw4']) for (let i=0;i<4;i++) d.push({color:'wild',value:w});
  return d;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

function getRoom(code)   { return rooms[code]; }
function getName(room, id) {
  const p = room.players.find(p => p.id === id);
  return p ? p.name : '???';
}

function rebuildCounts(game) {
  game.handCounts = {};
  for (const [pid, h] of Object.entries(game.hands)) game.handCounts[pid] = h.length;
}

function advTurn(game) {
  game.currentTurnIdx = ((game.currentTurnIdx + game.direction) + game.turnOrder.length) % game.turnOrder.length;
}
function getCurrentId(game) { return game.turnOrder[game.currentTurnIdx]; }

function canPlay(game, card) {
  if (card.color === 'wild') return true;
  return card.color === game.currentColor || card.value === game.currentValue;
}

function drawD(game, n=1) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (game.deck.length === 0) {
      if (!game.discardPile || game.discardPile.length <= 1) break;
      const top  = game.discardTop;
      const rest = game.discardPile.filter(c => c !== top);
      game.deck  = shuffle(rest);
      game.discardPile = [top];
      game.discardTop  = top;
      io.to(game._code).emit('chat', { name:null, text:'🔀 Deck reshuffled!', system:true });
      if (game.deck.length === 0) break;
    }
    out.push(game.deck.pop());
  }
  return out;
}

// ================================================================
//  Broadcast helpers
// ================================================================
function broadcastState(room) {
  const g = room.game;
  const state = {
    currentTurnIdx : g.currentTurnIdx,
    direction      : g.direction,
    currentColor   : g.currentColor,
    currentValue   : g.currentValue,
    discardTop     : g.discardTop,
    deckCount      : g.deck.length,
    handCounts     : g.handCounts,
    turnOrder      : g.turnOrder,
    finishOrder    : g.finishOrder,
    unoFlags       : g.unoFlags,
  };
  io.to(room.code).emit('game_state', state);
}

function broadcastHands(room) {
  const g = room.game;
  for (const [pid, hand] of Object.entries(g.hands)) {
    io.to(pid).emit('your_hand', { hand });
  }
}

// ================================================================
//  Core game logic
// ================================================================
function handlePlay(room, fromId, card, chosenColor) {
  const g = room.game;
  if (!g || !g.active)        return;
  if (getCurrentId(g) !== fromId) return;

  const hand = g.hands[fromId];
  if (!hand) return;
  const idx = hand.findIndex(c => c.color === card.color && c.value === card.value);
  if (idx === -1)         return;
  if (!canPlay(g, card)) return;

  const calledUno = g.unoFlags[fromId] === true;

  hand.splice(idx, 1);
  g.discardTop = card;
  g.discardPile.push(card);
  g.currentValue = card.value;
  if (card.color !== 'wild') g.currentColor = card.color;

  let bannerMsg = '';

  switch (card.value) {
    case 'skip': {
      advTurn(g);
      const skipped = getCurrentId(g);
      bannerMsg = `⊘ ${getName(room, skipped)} skipped!`;
      advTurn(g);
      break;
    }
    case 'reverse': {
      g.direction *= -1;
      if (g.turnOrder.length === 2) {
        advTurn(g); advTurn(g);
        bannerMsg = `↺ ${getName(room, fromId)} goes again!`;
      } else {
        advTurn(g);
        bannerMsg = `↺ Direction reversed!`;
      }
      break;
    }
    case 'draw2': {
      advTurn(g);
      const victim = getCurrentId(g);
      g.hands[victim].push(...drawD(g, 2));
      bannerMsg = `+2 → ${getName(room, victim)} draws 2!`;
      advTurn(g);
      break;
    }
    case 'wild': {
      g.currentColor = chosenColor || 'red';
      advTurn(g);
      bannerMsg = `✦ ${getName(room, fromId)} chose ${g.currentColor}`;
      break;
    }
    case 'wild_draw4': {
      g.currentColor = chosenColor || 'red';
      advTurn(g);
      const v4 = getCurrentId(g);
      g.hands[v4].push(...drawD(g, 4));
      bannerMsg = `+4 → ${getName(room, v4)} draws 4! Color: ${g.currentColor}`;
      advTurn(g);
      break;
    }
    default:
      advTurn(g);
      break;
  }

  if (bannerMsg) io.to(room.code).emit('action_banner', { msg: bannerMsg });

  // UNO penalty
  if (hand.length === 1 && !calledUno) {
    setTimeout(() => {
      if (!g.active) return;
      if (g.hands[fromId] && g.hands[fromId].length === 1) {
        g.hands[fromId].push(...drawD(g, 2));
        io.to(room.code).emit('chat', { name:null, text:`${getName(room,fromId)} forgot UNO! +2 🤦`, system:true });
        rebuildCounts(g);
        broadcastState(room);
        broadcastHands(room);
      }
    }, 1500);
  } else if (hand.length === 1 && calledUno) {
    g.unoFlags[fromId] = false;
  }

  // Win check
  if (hand.length === 0) {
    g.finishOrder.push(fromId);
    delete g.hands[fromId];
    const rem = g.turnOrder.filter(id => g.hands[id] && g.hands[id].length > 0);
    if (rem.length <= 1) {
      if (rem.length === 1) g.finishOrder.push(rem[0]);
      rebuildCounts(g);
      endGame(room);
      return;
    }
    const ti = g.turnOrder.indexOf(fromId);
    if (ti !== -1) {
      g.turnOrder.splice(ti, 1);
      if (ti < g.currentTurnIdx) g.currentTurnIdx--;
      else if (g.currentTurnIdx >= g.turnOrder.length) g.currentTurnIdx = 0;
    }
    io.to(room.code).emit('chat', { name:null, text:`${getName(room,fromId)} finished! 🎉`, system:true });
  }

  rebuildCounts(g);
  broadcastState(room);
  broadcastHands(room);
}

function handleDraw(room, fromId) {
  const g = room.game;
  if (!g || !g.active) return;
  if (getCurrentId(g) !== fromId) return;

  const drawn = drawD(g, 1);
  if (!drawn.length) {
    const remaining = g.turnOrder.filter(id => g.hands[id]);
    remaining.sort((a,b) => (g.hands[a]||[]).length - (g.hands[b]||[]).length);
    for (const pid of remaining) if (!g.finishOrder.includes(pid)) g.finishOrder.push(pid);
    rebuildCounts(g);
    endGame(room);
    return;
  }
  if (!g.hands[fromId]) g.hands[fromId] = [];
  g.hands[fromId].push(...drawn);
  g.unoFlags[fromId] = false;
  advTurn(g);
  rebuildCounts(g);
  broadcastState(room);
  broadcastHands(room);
}

function endGame(room) {
  const g = room.game;
  g.active = false;
  io.to(room.code).emit('game_over', { finishOrder: g.finishOrder });
}

function startGame(room) {
  const settings = room.settings;
  const deck = shuffle(buildDeck());
  const turnOrder = shuffle(room.players.map(p => p.id));
  const hands = {};
  for (const pid of turnOrder) hands[pid] = [];

  const cards = settings.cards || 7;
  for (const pid of turnOrder) {
    for (let i = 0; i < cards; i++) hands[pid].push(deck.pop());
  }

  // First card — no wilds
  let start;
  do {
    start = deck.pop();
    if (start.color === 'wild' || start.value === 'wild_draw4') deck.unshift(start);
  } while (start.color === 'wild' || start.value === 'wild_draw4');

  const game = {
    _code        : room.code,
    deck,
    hands,
    discardPile  : [start],
    discardTop   : start,
    currentColor : start.color,
    currentValue : start.value,
    turnOrder,
    currentTurnIdx: 0,
    direction    : 1,
    handCounts   : {},
    finishOrder  : [],
    unoFlags     : {},
    active       : true,
  };

  // First card effects
  if (start.value === 'skip')  { advTurn(game); }
  else if (start.value === 'draw2') { game.hands[getCurrentId(game)].push(...drawD(game,2)); advTurn(game); }

  rebuildCounts(game);
  room.game = game;

  // Send each player their personalised start packet
  for (const pid of turnOrder) {
    io.to(pid).emit('game_start', {
      settings       : room.settings,
      turnOrder,
      currentTurnIdx : game.currentTurnIdx,
      direction      : game.direction,
      currentColor   : game.currentColor,
      currentValue   : game.currentValue,
      discardTop     : start,
      deckCount      : game.deck.length,
      hand           : game.hands[pid],
      handCounts     : game.handCounts,
      players        : room.players,
    });
  }

  io.to(room.code).emit('chat', { name:null, text:'Game started! Good luck! 🃏', system:true });
}

// ================================================================
//  Socket.io connection
// ================================================================
io.on('connection', socket => {
  let currentRoom = null;
  let currentUid  = null;

  // ── CREATE ROOM ──
  socket.on('create_room', ({ name, avatar, uid }) => {
    let code;
    do { code = genCode(); } while (rooms[code]);

    const player = { id:socket.id, name, avatar, uid, isHost:true };
    rooms[code] = {
      code,
      hostId   : socket.id,
      players  : [player],
      settings : { cards:7, stacking:false },
      game     : null,
      rematchVotes: new Set(),
    };

    currentRoom = code;
    currentUid  = uid;
    socket.join(code);

    socket.emit('room_created', { code, players: rooms[code].players, settings: rooms[code].settings });
  });

  // ── JOIN ROOM ──
  socket.on('join_room', ({ code, name, avatar, uid }) => {
    const room = getRoom(code);
    if (!room) { socket.emit('error_msg', { msg:'Room not found!' }); return; }

    if (room.game && room.game.active) {
      // Check if this uid was in the game — rejoin
      const existing = room.players.find(p => p.uid === uid);
      if (!existing) { socket.emit('error_msg', { msg:'Game in progress' }); return; }

      // Remap socket id
      const oldId = existing.id;
      existing.id = socket.id;
      const g = room.game;
      if (g.hands[oldId]) { g.hands[socket.id] = g.hands[oldId]; delete g.hands[oldId]; }
      const oti = g.turnOrder.indexOf(oldId);
      if (oti !== -1) g.turnOrder[oti] = socket.id;
      rebuildCounts(g);

      currentRoom = code;
      currentUid  = uid;
      socket.join(code);

      socket.emit('game_rejoin', {
        hand           : g.hands[socket.id] || [],
        turnOrder      : g.turnOrder,
        currentTurnIdx : g.currentTurnIdx,
        direction      : g.direction,
        currentColor   : g.currentColor,
        currentValue   : g.currentValue,
        discardTop     : g.discardTop,
        deckCount      : g.deck.length,
        handCounts     : g.handCounts,
        players        : room.players,
        settings       : room.settings,
      });

      socket.to(code).emit('player_rejoined', { player: existing });
      io.to(code).emit('chat', { name:null, text:`${existing.name} reconnected 🔄`, system:true });
      broadcastState(room);
      return;
    }

    const player = { id:socket.id, name, avatar, uid, isHost:false };
    room.players.push(player);
    currentRoom = code;
    currentUid  = uid;
    socket.join(code);

    socket.emit('lobby_state', { players:room.players, settings:room.settings, code });
    socket.to(code).emit('player_joined', { player });
    io.to(code).emit('chat', { name:null, text:`${name} joined 👋`, system:true });
  });

  // ── UPDATE SETTINGS (host only) ──
  socket.on('update_settings', ({ cards, stacking }) => {
    const room = getRoom(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    room.settings = { cards, stacking };
    io.to(currentRoom).emit('settings_updated', room.settings);
  });

  // ── START GAME (host only) ──
  socket.on('start_game', () => {
    const room = getRoom(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 2) { socket.emit('error_msg', { msg:'Need at least 2 players!' }); return; }
    startGame(room);
  });

  // ── PLAY CARD ──
  socket.on('play_card', ({ card, chosenColor }) => {
    const room = getRoom(currentRoom);
    if (!room) return;
    handlePlay(room, socket.id, card, chosenColor);
  });

  // ── DRAW CARD ──
  socket.on('draw_card', () => {
    const room = getRoom(currentRoom);
    if (!room) return;
    handleDraw(room, socket.id);
  });

  // ── CALL UNO ──
  socket.on('call_uno', () => {
    const room = getRoom(currentRoom);
    if (!room || !room.game || !room.game.active) return;
    room.game.unoFlags[socket.id] = true;
    io.to(currentRoom).emit('uno_called', { id:socket.id });
    broadcastState(room);
  });

  // ── CHAT ──
  socket.on('chat', ({ name, text }) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('chat', { name, text, system:false });
  });

  // ── REACTION ──
  socket.on('reaction', ({ emoji, name }) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('reaction', { emoji, name });
  });

  // ── REMATCH VOTE ──
  socket.on('rematch_vote', () => {
    const room = getRoom(currentRoom);
    if (!room) return;
    if (!room.rematchVotes) room.rematchVotes = new Set();
    room.rematchVotes.add(socket.id);
    const votes = [...room.rematchVotes];
    io.to(currentRoom).emit('rematch_count', { votes, total: room.players.length });
    if (room.rematchVotes.size >= room.players.length) {
      room.rematchVotes = new Set();
      io.to(currentRoom).emit('rematch_go');
      startGame(room);
    }
  });

  // ── LEAVE / DISCONNECT ──
  function handleLeave() {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room) return;

    const leaving = room.players.find(p => p.id === socket.id);
    if (!leaving) return;

    room.players = room.players.filter(p => p.id !== socket.id);
    socket.to(currentRoom).emit('player_left', { id: socket.id });
    io.to(currentRoom).emit('chat', { name:null, text:`${leaving.name} left`, system:true });

    if (room.game && room.game.active) {
      const g = room.game;
      const ti = g.turnOrder.indexOf(socket.id);
      if (ti !== -1) {
        g.turnOrder.splice(ti, 1);
        if (ti < g.currentTurnIdx) g.currentTurnIdx--;
        else if (g.currentTurnIdx >= g.turnOrder.length) g.currentTurnIdx = 0;
        delete g.hands[socket.id];
        delete g.handCounts[socket.id];
      }
      if (g.turnOrder.length <= 1) {
        if (g.turnOrder.length === 1) g.finishOrder.push(g.turnOrder[0]);
        rebuildCounts(g);
        endGame(room);
      } else {
        rebuildCounts(g);
        broadcastState(room);
      }
    }

    // If host left, assign new host
    if (room.hostId === socket.id && room.players.length > 0) {
      room.hostId = room.players[0].id;
      room.players[0].isHost = true;
      io.to(currentRoom).emit('new_host', { id: room.hostId });
    }

    // Clean up empty rooms
    if (room.players.length === 0) delete rooms[currentRoom];
    currentRoom = null;
  }

  socket.on('leave_room', handleLeave);
  socket.on('disconnect', handleLeave);
});

// ================================================================
//  Start server
// ================================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`UNO server running on port ${PORT}`));
