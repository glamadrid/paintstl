// Genera un STL binario (una esfera UV) como modelo por defecto para esculpir.
// Uso: node scripts/generate-default-stl.js
'use strict';

const fs = require('fs');
const path = require('path');

const RADIUS = 0.25;
const WIDTH_SEGMENTS = 48;
const HEIGHT_SEGMENTS = 32;
const OUTPUT_PATH = path.join(__dirname, '..', 'models', 'default.stl');

// Triangulación UV estándar de una esfera (igual que THREE.SphereGeometry):
// una cuadrícula de anillos/columnas, con las dos filas polares colapsadas a
// un único triángulo por celda para evitar triángulos degenerados.
function buildSphereTriangles(radius, widthSegments, heightSegments) {
  const grid = [];
  const vertices = [];
  let index = 0;

  for (let iy = 0; iy <= heightSegments; iy++) {
    const row = [];
    const v = iy / heightSegments;
    for (let ix = 0; ix <= widthSegments; ix++) {
      const u = ix / widthSegments;
      const x = -radius * Math.cos(u * Math.PI * 2) * Math.sin(v * Math.PI);
      const y = radius * Math.cos(v * Math.PI);
      const z = radius * Math.sin(u * Math.PI * 2) * Math.sin(v * Math.PI);
      vertices.push([x, y, z]);
      row.push(index++);
    }
    grid.push(row);
  }

  const triangles = [];
  for (let iy = 0; iy < heightSegments; iy++) {
    for (let ix = 0; ix < widthSegments; ix++) {
      const a = grid[iy][ix + 1];
      const b = grid[iy][ix];
      const c = grid[iy + 1][ix];
      const d = grid[iy + 1][ix + 1];

      if (iy !== 0) triangles.push([vertices[a], vertices[b], vertices[d]]);
      if (iy !== heightSegments - 1) triangles.push([vertices[b], vertices[c], vertices[d]]);
    }
  }
  return triangles;
}

function faceNormal(v0, v1, v2) {
  const ax = v1[0] - v0[0], ay = v1[1] - v0[1], az = v1[2] - v0[2];
  const bx = v2[0] - v0[0], by = v2[1] - v0[1], bz = v2[2] - v0[2];
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function writeBinarySTL(triangles, outputPath) {
  const HEADER_SIZE = 80;
  const COUNT_SIZE = 4;
  const TRIANGLE_SIZE = 50; // 12 bytes normal + 36 bytes vértices + 2 bytes attr
  const buffer = Buffer.alloc(HEADER_SIZE + COUNT_SIZE + TRIANGLE_SIZE * triangles.length);

  buffer.write('PaintSTL default sculpting sphere', 0, 'ascii');
  buffer.writeUInt32LE(triangles.length, HEADER_SIZE);

  let offset = HEADER_SIZE + COUNT_SIZE;
  for (const [v0, v1, v2] of triangles) {
    const [nx, ny, nz] = faceNormal(v0, v1, v2);
    buffer.writeFloatLE(nx, offset); offset += 4;
    buffer.writeFloatLE(ny, offset); offset += 4;
    buffer.writeFloatLE(nz, offset); offset += 4;

    for (const v of [v0, v1, v2]) {
      buffer.writeFloatLE(v[0], offset); offset += 4;
      buffer.writeFloatLE(v[1], offset); offset += 4;
      buffer.writeFloatLE(v[2], offset); offset += 4;
    }

    buffer.writeUInt16LE(0, offset); offset += 2;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  console.log(`Escritos ${triangles.length} triángulos en ${outputPath}`);
}

const triangles = buildSphereTriangles(RADIUS, WIDTH_SEGMENTS, HEIGHT_SEGMENTS);
writeBinarySTL(triangles, OUTPUT_PATH);
