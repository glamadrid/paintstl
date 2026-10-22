// Servidor de tiempo real (WebSocket) para sesiones multijugador de PaintSTL.
// Fase 1 del plan: solo transporte por "sala" (room) - retransmite mensajes
// crudos entre quienes están en la misma sala, sin interpretar su contenido.
// La lógica de qué significa cada mensaje (presencia, piezas, transforms,
// pinceladas) se agrega en fases posteriores sobre esta misma base.
'use strict';

const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8787;

// roomId -> Set de conexiones de esa sala
const rooms = new Map();

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Set();
    rooms.set(roomId, room);
  }
  return room;
}

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room') || 'default';
  const room = getRoom(roomId);
  room.add(ws);
  ws.roomId = roomId;

  console.log(`+ Cliente conectado a la sala "${roomId}" (${room.size} en la sala)`);

  ws.on('message', (data) => {
    // Relay puro: reenvía el mensaje tal cual a los demás de la misma sala.
    for (const peer of room) {
      if (peer !== ws && peer.readyState === peer.OPEN) {
        peer.send(data);
      }
    }
  });

  ws.on('close', () => {
    room.delete(ws);
    console.log(`- Cliente salió de la sala "${roomId}" (${room.size} restantes)`);
    if (room.size === 0) rooms.delete(roomId);
  });

  ws.on('error', (err) => {
    console.error('Error en conexión WebSocket:', err.message);
  });
});

console.log(`Servidor de tiempo real de PaintSTL escuchando en puerto ${PORT}`);
