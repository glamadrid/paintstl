// Servidor de tiempo real (WebSocket) para sesiones multijugador de PaintSTL.
// Fase 1: transporte por "sala" (room). Fase 2: identidad por conexión (para
// presencia). Fase 3: el servidor pasa a ser DUEÑO de la lista de piezas de
// cada sala - decide la posición (slot) de cada pieza nueva y la guarda en
// memoria para poder mandarla completa a quien se una después. Todo lo demás
// (ej. 'presence') sigue siendo un relay puro, sin interpretar.
'use strict';

const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8787;

// roomId -> { connections: Set<ws>, pieces: Map<pieceId, pieza>, nextSlot }
const rooms = new Map();

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    // El slot 0 lo ocupa siempre el modelo por defecto que cada cliente carga
    // localmente al arrancar (ver loadDefaultModel en app.js, no pasa por la
    // red) - los slots en red empiezan en 1 para no superponerse con él.
    room = { connections: new Set(), pieces: new Map(), nextSlot: 1 };
    rooms.set(roomId, room);
  }
  return room;
}

// Deliberadamente NO se borran las salas cuando quedan vacías: si la única
// persona conectada simplemente recarga la página, la reconexión llega unos
// milisegundos después de que la vieja se cierre - borrar la sala en ese
// instante perdería todas las piezas ya agregadas. Para un proyecto de este
// tamaño, mantener unas pocas salas en memoria indefinidamente no es un
// problema real.

function broadcastToRoom(room, message, exclude) {
  const data = JSON.stringify(message);
  for (const peer of room.connections) {
    if (peer !== exclude && peer.readyState === peer.OPEN) peer.send(data);
  }
}

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room') || 'default';
  const room = getRoom(roomId);
  ws.id = crypto.randomUUID();
  ws.roomId = roomId;
  room.connections.add(ws);

  ws.send(JSON.stringify({ type: 'welcome', id: ws.id }));
  // Pone al día al recién llegado con TODAS las piezas ya agregadas por
  // otros antes de que él se conectara.
  ws.send(JSON.stringify({ type: 'piece-list', pieces: [...room.pieces.values()] }));
  console.log(`+ ${ws.id} se unió a la sala "${roomId}" (${room.connections.size} en la sala, ${room.pieces.size} pieza(s) ya registradas)`);

  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return; // mensaje no es JSON válido, se ignora
    }

    if (message.type === 'add-piece') {
      const piece = {
        id: crypto.randomUUID(),
        name: message.name,
        fileBase64: message.fileBase64,
        slot: room.nextSlot++,
      };
      room.pieces.set(piece.id, piece);
      // Se manda a TODOS, incluido quien la subió - nadie coloca la pieza
      // por su cuenta, todos esperan la respuesta autoritativa del servidor.
      broadcastToRoom(room, { type: 'piece-added', requestId: message.requestId, ...piece }, null);
      console.log(`  + pieza "${piece.name}" agregada a la sala "${roomId}" (slot ${piece.slot})`);
      return;
    }

    // Cualquier otro tipo de mensaje (ej. 'presence') sigue siendo relay
    // puro, igual que en Fases 1-2.
    broadcastToRoom(room, { type: 'relay', from: ws.id, payload: message }, ws);
  });

  ws.on('close', () => {
    room.connections.delete(ws);
    console.log(`- ${ws.id} salió de la sala "${roomId}" (${room.connections.size} restantes)`);
    broadcastToRoom(room, { type: 'peer-left', id: ws.id }, null);
  });

  ws.on('error', (err) => {
    console.error('Error en conexión WebSocket:', err.message);
  });
});

console.log(`Servidor de tiempo real de PaintSTL escuchando en puerto ${PORT}`);


console.log(`Servidor de tiempo real de PaintSTL escuchando en puerto ${PORT}`);
