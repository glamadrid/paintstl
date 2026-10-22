// Servidor de tiempo real (WebSocket) para sesiones multijugador de PaintSTL.
// Fase 1: transporte por "sala" (room). Fase 2 añadió identidad por conexión
// (necesaria para presencia: cada cliente debe saber de QUIÉN es cada
// actualización que recibe) - el contenido del mensaje en sí sigue sin
// interpretarse aquí, solo se envuelve con quién lo mandó.
'use strict';

const { WebSocketServer } = require('ws');
const crypto = require('crypto');

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
  ws.id = crypto.randomUUID();
  ws.roomId = roomId;
  room.add(ws);

  ws.send(JSON.stringify({ type: 'welcome', id: ws.id }));
  console.log(`+ ${ws.id} se unió a la sala "${roomId}" (${room.size} en la sala)`);

  ws.on('message', (data) => {
    let payload;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      return; // mensaje no es JSON válido, se ignora
    }
    const envelope = JSON.stringify({ type: 'relay', from: ws.id, payload });
    for (const peer of room) {
      if (peer !== ws && peer.readyState === peer.OPEN) {
        peer.send(envelope);
      }
    }
  });

  ws.on('close', () => {
    room.delete(ws);
    console.log(`- ${ws.id} salió de la sala "${roomId}" (${room.size} restantes)`);
    const leftMessage = JSON.stringify({ type: 'peer-left', id: ws.id });
    for (const peer of room) {
      if (peer.readyState === peer.OPEN) peer.send(leftMessage);
    }
    if (room.size === 0) rooms.delete(roomId);
  });

  ws.on('error', (err) => {
    console.error('Error en conexión WebSocket:', err.message);
  });
});

console.log(`Servidor de tiempo real de PaintSTL escuchando en puerto ${PORT}`);
