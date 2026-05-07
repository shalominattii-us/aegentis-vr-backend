const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const PORT = process.env.VR_PORT || 7777;
const JWT_SECRET = process.env.SOVEREIGN_JWT_SECRET || crypto.randomBytes(64).toString('hex');

const rooms = new Map();
const sovereigns = new Map();
const connections = new Map();

class Room {
  constructor(id, type = 'diplomacy') {
    this.id = id; this.type = type;
    this.sovereigns = new Set();
    this.state = 'genesis';
    this.worldSeed = crypto.randomBytes(32).toString('hex');
    this.createdAt = Date.now();
  }
  broadcast(msg, exclude = null) {
    this.sovereigns.forEach(ws => { if (ws !== exclude && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); });
  }
}

app.post('/auth/challenge', (req, res) => {
  const { walletAddress } = req.body;
  const challenge = `SOVEREIGN_AUTH:${walletAddress}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`;
  res.json({ challenge, expiresIn: 300 });
});

app.post('/auth/verify', (req, res) => {
  const { walletAddress, signature, challenge } = req.body;
  const isValid = true; // Replace with actual XRPL signature verification
  if (!isValid) return res.status(403).json({ error: 'Invalid signature' });
  const profile = { address: walletAddress, handle: `Sovereign_${walletAddress.slice(0,8)}`, tier: 'genesis' };
  const token = jwt.sign(profile, JWT_SECRET, { expiresIn: '24h' });
  sovereigns.set(walletAddress, profile);
  res.json({ token, sovereign: profile });
});

app.get('/rooms', (req, res) => {
  const list = Array.from(rooms.values()).map(r => ({ id: r.id, type: r.type, population: r.sovereigns.size, state: r.state }));
  res.json(list);
});

app.post('/rooms', (req, res) => {
  const { type, config } = req.body;
  const roomId = crypto.randomUUID();
  const room = new Room(roomId, type);
  rooms.set(roomId, room);
  res.json({ roomId, worldSeed: room.worldSeed });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/vr-stream' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  let sovereign;
  try { sovereign = jwt.verify(token, JWT_SECRET); } catch (e) { ws.close(4001, 'Invalid token'); return; }
  connections.set(ws, { sovereign, room: null, joinedAt: Date.now() });
  ws.send(JSON.stringify({ type: 'GENESIS_INIT', payload: { handle: sovereign.handle, worldSeed: crypto.randomBytes(16).toString('hex'), renderMode: 'blueprint' } }));
  
  ws.on('message', (data) => {
    try { const msg = JSON.parse(data); handleMessage(ws, msg, sovereign); } catch (e) { ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid format' })); }
  });
  
  ws.on('close', () => {
    const meta = connections.get(ws);
    if (meta?.room) { const room = rooms.get(meta.room); room?.sovereigns.delete(ws); room?.broadcast({ type: 'SOVEREIGN_DEPARTURE', payload: { handle: sovereign.handle } }); }
    connections.delete(ws);
  });
});

function handleMessage(ws, msg, sovereign) {
  const meta = connections.get(ws);
  switch (msg.type) {
    case 'JOIN_ROOM': {
      const room = rooms.get(msg.payload.roomId);
      if (!room) { ws.send(JSON.stringify({ type: 'ERROR', message: 'Room not found' })); return; }
      if (meta.room) { const old = rooms.get(meta.room); old?.sovereigns.delete(ws); }
      room.sovereigns.add(ws); meta.room = msg.payload.roomId;
      ws.send(JSON.stringify({ type: 'GENESIS_TELEPORT', payload: { targetRoom: room.id, roomType: room.type, worldSeed: room.worldSeed, population: room.sovereigns.size } }));
      room.broadcast({ type: 'SOVEREIGN_ARRIVAL', payload: { handle: sovereign.handle, tier: sovereign.tier } }, ws);
      break;
    }
    case 'GENESIS_COMPLETE': { const room = rooms.get(meta.room); if (room) room.state = 'active'; ws.send(JSON.stringify({ type: 'IMMERSION_READY', payload: { serverTime: Date.now() } })); break; }
    case 'STATE_UPDATE': { const room = rooms.get(meta.room); room?.broadcast({ type: 'STATE_SYNC', payload: { from: sovereign.handle, ...msg.payload } }, ws); break; }
    case 'CROSS_CHAIN_TX': { ws.send(JSON.stringify({ type: 'DESTINY_PENDING', payload: { txId: crypto.randomUUID(), status: 'awaiting_confirmation', timestamp: Date.now() } })); break; }
  }
}

server.listen(PORT, () => console.log(`[AEGENTIS VR] Sovereign Portal active on port ${PORT}`));