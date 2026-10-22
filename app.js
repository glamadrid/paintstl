// PaintSTL — esculpir, pintar y posicionar varias piezas STL en WebXR (Oculus Quest 2) con Three.js
import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
const DEFAULT_MODEL_URL = 'models/spiderman-bust-simplified.stl';
const MODEL_TARGET_SIZE = 0.5; // metros: dimensión máxima del modelo tras auto-escalado
// En VR el origen 'local-floor' queda cerca de donde el Quest 2 empieza a
// rastrear (altura de pie, X/Z≈0) - NO en la posición de la cámara de
// escritorio. A 0.5m de distancia el modelo quedaba demasiado cerca del
// origen real en VR: cualquier giro de cabeza producía un paralaje muy
// exagerado, percibido como que "el modelo persigue la vista". Alejado a
// ~1.1m (distancia de visualización cómoda típica en VR) para que el giro de
// cabeza apenas lo desplace angularmente.
const MODEL_POSITION = new THREE.Vector3(0, 1.2, -1.0); // a la altura del pecho, a distancia cómoda en VR
const PIECE_SPREAD = 0.4; // metros: separación entre piezas nuevas para que no queden apiladas

let BRUSH_RADIUS = 0.06; // metros: radio de influencia del pincel (esculpir/pintar), ajustable con el control "Precisión"
const BRUSH_RADIUS_MIN = 0.01;
const BRUSH_RADIUS_MAX = 0.15;
const BRUSH_RADIUS_STEP = 0.005;
const SCULPT_STRENGTH = 0.05; // metros/segundo de desplazamiento en el centro del pincel
const PAINT_STRENGTH = 6; // velocidad (por segundo) de mezcla hacia el color elegido
const RESIZE_STEP = 1.1; // factor de escalado de la pieza seleccionada por clic/pulsación
const MAX_UNDO = 30; // número máximo de acciones que se pueden deshacer
const SMART_PAINT_DEFAULT_DEGREES = 20; // tolerancia inicial del "Pintado rápido" (ángulo entre caras vecinas)

// ---------------------------------------------------------------------------
// Multijugador (Fase 2: presencia compartida - ver server/realtime-server.js)
// ---------------------------------------------------------------------------
// TODO: cambiar cuando el servidor esté desplegado en un host real (todavía
// solo corre localmente, Fase 1 del plan de implementación).
const MULTIPLAYER_SERVER_URL = 'ws://localhost:8787';
const MULTIPLAYER_ROOM = new URLSearchParams(location.search).get('room') || 'default';
const PRESENCE_SEND_INTERVAL_MS = 100; // ~10 veces/seg - de sobra con interpolación en el receptor
const PEER_AVATAR_LERP_SPEED = 12; // qué tan rápido el avatar visual "alcanza" el último dato recibido

const COLOR_PALETTE = [
  '#3f88c5', '#e63946', '#2a9d8f', '#f4a261',
  '#ffffff', '#1b1b22', '#ffd60a', '#9d4edd',
];

// ---------------------------------------------------------------------------
// Estado global
// ---------------------------------------------------------------------------
let camera, scene, renderer;
let desktopControls;
// Gizmos de Unity (solo escritorio): uno por modo, para poder mostrar los tres
// a la vez en la herramienta "Libre" sin que se pisen entre sí.
let tcMove, tcRotate, tcScale;
let controllers = [];
let lastFrameTime = 0;

const meshes = []; // todas las piezas STL cargadas
let selectedMesh = null; // pieza activa para los botones de tamaño y bloqueo
let selectionHelper = null; // contorno amarillo alrededor de la pieza seleccionada
let pieceCounter = 0;

let currentTool = 'sculpt'; // 'sculpt' | 'paint' | 'smartpaint' | 'move' | 'rotate' | 'scale' | 'free'
const currentColor = new THREE.Color(COLOR_PALETTE[0]);
// "Pintado rápido": ángulo máximo (radianes) entre caras vecinas para que la
// selección por similitud siga creciendo; ajustable desde el control deslizante.
let smartPaintAngleThresholdRad = THREE.MathUtils.degToRad(SMART_PAINT_DEFAULT_DEGREES);

// Deshacer: pila de acciones con el estado "antes" para poder revertir la última.
const undoStack = [];
let activeStroke = null; // { mesh, attribute, before } mientras se esculpe/pinta
let activeTransformSnapshot = null; // { mesh, before } mientras se mueve/rota/escala

// Esculpido/pintura de escritorio (con ratón), independiente de los controles de Oculus.
let isDesktopActing = false;
let desktopSculptDirection = 1;
const mouseNDC = new THREE.Vector2();
let lastHitMouse = null; // { mesh, point, faceIndex } en espacio local de esa pieza
let activeSmartPaintFaces = null; // Set<faceIndex> ya pintadas en el trazo actual de "Pintado rápido"
let brushIndicator; // "sombra" semitransparente que muestra el ancho del pincel antes de usarlo
let vrReticle; // punto brillante que marca exactamente dónde apunta el rayo (mira de precisión)
let hoveredMenuButton = null; // botón del menú VR actualmente señalado por el rayo (para resaltar/háptica)

const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();
const _vertex = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _color = new THREE.Color();
const _deltaQuat = new THREE.Quaternion();
// Reutilizados al calcular normales de cara para "Pintado rápido".
const _pA = new THREE.Vector3();
const _pB = new THREE.Vector3();
const _pC = new THREE.Vector3();
const _edgeCB = new THREE.Vector3();
const _edgeAB = new THREE.Vector3();
// Reutilizados para orientar la sombra del pincel sobre la superficie tocada.
const _worldNormal = new THREE.Vector3();
const _circleUp = new THREE.Vector3(0, 0, 1);
// Reutilizados en los gestos de mano (punto de pellizco, normal de palma, posiciones de controlador).
const _pinchA = new THREE.Vector3();
const _pinchB = new THREE.Vector3();
const _palmWrist = new THREE.Vector3();
const _palmIndex = new THREE.Vector3();
const _palmPinky = new THREE.Vector3();
const _palmA = new THREE.Vector3();
const _palmB = new THREE.Vector3();
const _controllerPos = new THREE.Vector3();
// Dedicados (no reutilizables entre sí) porque se calculan una mano DESPUÉS
// de la otra en el mismo frame y ambos resultados deben seguir vivos a la vez.
const _leftPalmNormal = new THREE.Vector3();
const _rightPalmNormal = new THREE.Vector3();

// Menú de VR: panel 3D flotante (ya no cuelga de la mano - ver gesto "ambas
// palmas" en updateHandGestures), apuntado/usado con el rayo de la mano derecha.
let vrMenuGroup;
let vrMenuHandle; // franja superior del panel: agárrala (pellizco cerca) para reubicarlo
let vrMenuOpen = false;
const vrMenuButtons = [];
const MENU_HANDLE_GRAB_RADIUS = 0.1; // metros: qué tan cerca del asa hay que pellizcar para agarrar el panel

// Zoom con pellizco de ambas manos a la vez (ver updateHandGestures).
const twoHandZoom = { active: false, startDistance: 0, startScale: new THREE.Vector3() };
// "Ambas palmas hacia arriba" sostenido unos ms abre/cierra el menú flotante.
// Si el gesto se dispara con las palmas hacia ABAJO en vez de hacia arriba,
// el signo está invertido - ver el comentario dentro de getPalmNormal().
const PALM_UP_DOT_THRESHOLD = 0.6; // coseno del ángulo máximo respecto a +Y (~53°)
const PALM_GESTURE_HOLD_MS = 500;
const palmGesture = { holdStartTime: 0, armed: true };

// Multijugador (Fase 2): conexión al servidor de tiempo real + avatares de
// los demás usuarios conectados a la misma sala.
let multiplayerSocket = null;
let myPeerId = null;
let lastPresenceSendTime = 0;
const peerAvatars = new Map(); // peerId -> { group, head, left, right, target*, has* }

// Multijugador (Fase 3): piezas compartidas con colocación decidida por el
// servidor (ver server/realtime-server.js) - evita que cada cliente calcule
// su propia posición para una pieza nueva y queden en lugares distintos.
const networkPieceMeshes = new Map(); // pieceId -> mesh ya colocado en la escena
const pendingPieceUploads = new Map(); // requestId -> función que resuelve la promesa de esa subida
const PIECE_UPLOAD_TIMEOUT_MS = 15000; // si el servidor no responde en este tiempo, no se queda colgado para siempre

init();

function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b1b22);

  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 50);
  camera.position.set(0, 1.6, 1.2);

  setupLighting();
  setupGround();
  setupBrushIndicator();
  setupVRReticle();
  loadDefaultModel();

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  renderer.setAnimationLoop(render);
  document.body.appendChild(renderer.domElement);

  // 'hand-tracking' habilita usar las manos sin controles (ver setupControllers).
  document.body.appendChild(VRButton.createButton(renderer, { optionalFeatures: ['hand-tracking'] }));

  // Navegación de cámara al estilo Unity (ver setupCameraNavigation): el
  // botón izquierdo queda libre para las herramientas; los demás se
  // reasignan dinámicamente según los modificadores (Alt/Shift) en cada clic.
  desktopControls = new OrbitControls(camera, renderer.domElement);
  desktopControls.target.set(0, 1.1, -0.5);
  desktopControls.enableDamping = true;
  desktopControls.mouseButtons = {
    LEFT: null,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.PAN,
  };

  // Gizmos de mover/rotar/escalar al estilo Unity (escritorio). Mientras se
  // arrastra un eje, se pausa la órbita de cámara para que no compitan.
  tcMove = new TransformControls(camera, renderer.domElement);
  tcMove.setMode('translate');
  tcRotate = new TransformControls(camera, renderer.domElement);
  tcRotate.setMode('rotate');
  tcScale = new TransformControls(camera, renderer.domElement);
  tcScale.setMode('scale');

  // En la herramienta "Libre" los tres gizmos se muestran a la vez (al estilo
  // del Transform Tool de Unity): se escalan a radios distintos -escalar por
  // dentro, mover en medio, rotar por fuera- para que sus asas no se solapen.
  tcScale.setSize(0.45);
  tcMove.setSize(0.85);
  tcRotate.setSize(1.6);
  // El anillo "XYZE" de rotación libre es una esfera invisible que cubre todo
  // el centro del gizmo; sin desactivarla, capturaría también los clics de
  // mover/escalar. Al quitarla, rotar queda igual que en Unity: solo los
  // anillos de eje (X/Y/Z) y el anillo exterior de pantalla.
  tcRotate.showXYZE = false;

  for (const tc of [tcMove, tcRotate, tcScale]) {
    tc.addEventListener('dragging-changed', (event) => {
      desktopControls.enabled = !event.value;
    });
    tc.addEventListener('objectChange', () => {
      if (selectionHelper) selectionHelper.update();
    });
    tc.addEventListener('mouseDown', () => beginTransformSnapshot(tc.object));
    tc.addEventListener('mouseUp', () => commitTransformSnapshot());
    scene.add(tc.getHelper());
  }

  setupVRMenu();
  setupControllers();
  setupCameraNavigation();
  setupDesktopInteraction();
  setupKeyboardShortcuts();
  setupToolbar();
  setupMultiplayer();

  window.addEventListener('resize', onWindowResize);
}

function setupLighting() {
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x3a3a45, 1.2);
  scene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.8);
  dirLight.position.set(1, 3, 2);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(1024, 1024);
  dirLight.shadow.camera.near = 0.1;
  dirLight.shadow.camera.far = 10;
  dirLight.shadow.camera.left = -2;
  dirLight.shadow.camera.right = 2;
  dirLight.shadow.camera.top = 2;
  dirLight.shadow.camera.bottom = -2;
  scene.add(dirLight);
}

function setupGround() {
  const grid = new THREE.GridHelper(10, 20, 0x8899aa, 0x33363f);
  scene.add(grid);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 10),
    new THREE.ShadowMaterial({ opacity: 0.25 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
}

// Círculo semitransparente que se apoya sobre la superficie bajo el cursor/
// controlador: deja ver el ancho real del pincel (Esculpir/Pintar) antes de
// disparar. Radio unitario en geometría; se reescala cada frame según
// BRUSH_RADIUS (ver updateBrushIndicator).
function setupBrushIndicator() {
  const geometry = new THREE.CircleGeometry(1, 40);
  const material = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.35,
    depthTest: false, // evita z-fighting al apoyarse justo sobre la superficie
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  brushIndicator = new THREE.Mesh(geometry, material);
  brushIndicator.renderOrder = 10;
  brushIndicator.visible = false;
  scene.add(brushIndicator);
}

// Punto brillante que marca con precisión dónde apunta el rayo del control
// (VR), sobre un botón del menú o sobre la pieza - sin esto era difícil
// saber a qué se estaba apuntando antes de disparar el gatillo.
function setupVRReticle() {
  const geometry = new THREE.SphereGeometry(0.008, 12, 8);
  const material = new THREE.MeshBasicMaterial({
    color: 0xffe066,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  });
  vrReticle = new THREE.Mesh(geometry, material);
  vrReticle.renderOrder = 20;
  vrReticle.visible = false;
  scene.add(vrReticle);
}

// ---------------------------------------------------------------------------
// Carga de archivos STL: cada carga añade una pieza nueva (pueden ser varias)
// ---------------------------------------------------------------------------
function loadDefaultModel() {
  const loader = new STLLoader();
  loader.load(
    DEFAULT_MODEL_URL,
    // Slot FIJO (0), no meshes.length: si hay multijugador conectado, la
    // lista de piezas de red (JSON chico) suele llegar ANTES de que termine
    // de bajarse+parsearse este STL (varios MB) - con meshes.length el slot
    // de este modelo dependería de esa carrera y podría coincidir con el de
    // una pieza de red ya colocada (confirmado empíricamente probando Fase 3).
    (geometry) => addMesh(buildPieceMesh(geometry, 'Spiderman Bust', 0)),
    undefined,
    (error) => console.error('No se pudo cargar el STL por defecto:', error)
  );
}

// Si hay conexión multijugador activa, la pieza se sube al servidor (que
// decide su posición y la reparte a todos, incluido quien la subió). Si no
// hay servidor disponible, se mantiene el comportamiento original 100% local
// - el modo un-jugador nunca debe depender de que el multijugador funcione.
function loadSTLFromFile(file) {
  if (multiplayerSocket && multiplayerSocket.readyState === WebSocket.OPEN) {
    return uploadPieceToServer(file);
  }
  return loadSTLFromFileLocal(file);
}

function loadSTLFromFileLocal(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const geometry = new STLLoader().parse(reader.result);
        const pieceName = file.name.replace(/\.stl$/i, '');
        addMesh(buildPieceMesh(geometry, pieceName));
        resolve(true);
      } catch (error) {
        console.error('No se pudo leer el archivo STL:', file.name, error);
        resolve(false);
      }
    };
    reader.onerror = () => {
      console.error('No se pudo leer el archivo STL:', file.name, reader.error);
      resolve(false);
    };
    reader.readAsArrayBuffer(file);
  });
}

// Carga uno o varios STL a la vez: el botón "Cargar STL" ahora permite
// selección múltiple, y "Cargar carpeta" entrega TODOS los archivos de la
// carpeta elegida (incluidas subcarpetas) vía el atributo webkitdirectory -
// de ahí se filtran solo los .stl, el resto se ignora en silencio. Se cargan
// en secuencia (no en paralelo) para que el reparto automático de posición de
// cada pieza nueva (que depende de cuántas piezas ya hay) no se pise entre
// archivos.
async function loadSTLFilesFromList(fileList) {
  const stlFiles = Array.from(fileList).filter((file) => /\.stl$/i.test(file.name));
  if (stlFiles.length === 0) {
    window.alert('No se encontró ningún archivo .stl en esa selección.');
    return;
  }

  let loaded = 0;
  for (const file of stlFiles) {
    const ok = await loadSTLFromFile(file);
    if (ok) loaded += 1;
  }

  setTool('move'); // tras cargar, pasar directo a "posicionarlas"

  const failed = stlFiles.length - loaded;
  if (failed > 0) {
    window.alert('Se cargaron ' + loaded + ' de ' + stlFiles.length + ' pieza(s). ' + failed + ' archivo(s) STL no se pudieron leer.');
  }
}

// Desplazamiento de una pieza según su "slot" (número de orden), en una
// cuadrícula de 3 columnas - compartido entre la colocación local (basada en
// meshes.length) y la colocación de red (basada en el slot que asigna el
// servidor), para que ambas usen exactamente la misma fórmula.
function pieceSlotOffset(slot) {
  return new THREE.Vector3(
    ((slot % 3) - 1) * PIECE_SPREAD,
    0,
    Math.floor(slot / 3) * PIECE_SPREAD
  );
}

function buildPieceMesh(rawGeometry, pieceName, slot) {
  // Centra el modelo en su propio origen y lo escala a un tamaño cómodo para VR,
  // sin importar en qué unidades (mm, cm, in) haya sido exportado el STL.
  rawGeometry.center();
  rawGeometry.computeBoundingBox();

  const size = new THREE.Vector3();
  rawGeometry.boundingBox.getSize(size);
  const maxDimension = Math.max(size.x, size.y, size.z) || 1;
  rawGeometry.scale(
    MODEL_TARGET_SIZE / maxDimension,
    MODEL_TARGET_SIZE / maxDimension,
    MODEL_TARGET_SIZE / maxDimension
  );

  // STLLoader devuelve geometría no indexada (cada triángulo con vértices propios)
  // y un atributo "normal" por FACETA (STL no guarda normales suaves: 3 vértices
  // de un triángulo comparten la misma normal "plana", distinta a la del
  // triángulo vecino). Si se funde con esa normal incluida, mergeVertices() casi
  // nunca considera "iguales" dos vértices que SÍ comparten posición pero
  // pertenecen a triángulos distintos -quedan sin soldar, la malla sigue
  // fragmentada-. Se quita esa normal de faceta ANTES de fundir (para que solo
  // se compare posición) y se recalculan normales suaves después, ya con la
  // topología correctamente conectada.
  rawGeometry.deleteAttribute('normal');
  const geometry = mergeVertices(rawGeometry);
  geometry.computeVertexNormals();

  // Color por vértice: así la malla se puede pintar sin perder la posibilidad
  // de seguir esculpiéndola (ambas herramientas comparten la misma geometría).
  const vertexCount = geometry.attributes.position.count;
  const colors = new Float32Array(vertexCount * 3);
  const baseColor = new THREE.Color(COLOR_PALETTE[0]);
  for (let i = 0; i < vertexCount; i++) {
    colors[i * 3] = baseColor.r;
    colors[i * 3 + 1] = baseColor.g;
    colors[i * 3 + 2] = baseColor.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.6,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);

  // Cada pieza nueva se desplaza un poco para no quedar apilada exactamente
  // sobre la anterior (útil cuando un modelo viene repartido en varias piezas).
  // En piezas de red, addNetworkPiece sobrescribe esta posición con el slot
  // autoritativo que asignó el servidor - este valor es solo el de partida
  // para piezas puramente locales (sin multijugador). 'slot' explícito (ej.
  // el modelo por defecto, siempre 0) evita depender de meshes.length cuando
  // ese conteo puede variar por una carrera con piezas de red entrantes.
  mesh.position.copy(MODEL_POSITION).add(pieceSlotOffset(slot !== undefined ? slot : meshes.length));
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  pieceCounter += 1;
  mesh.userData.name = pieceName || ('Pieza ' + pieceCounter);
  mesh.userData.locked = false;
  mesh.visible = true;
  return mesh;
}

function addMesh(mesh) {
  meshes.push(mesh);
  scene.add(mesh);
  selectMesh(mesh);
}

function deleteMesh(mesh) {
  if (!window.confirm('¿Borrar "' + mesh.userData.name + '"?')) return;

  const index = meshes.indexOf(mesh);
  scene.remove(mesh);
  meshes.splice(index, 1);
  pushUndo({ type: 'delete', mesh, index });

  if (selectedMesh === mesh) {
    selectMesh(meshes[Math.min(index, meshes.length - 1)] || null);
  } else {
    refreshPieceList();
  }
}

// Ocultar la pieza seleccionada también la deselecciona (oculta su gizmo y
// su contorno amarillo); se puede volver a seleccionar en cuanto se muestre.
function setMeshVisible(mesh, visible) {
  mesh.visible = visible;
  if (!visible && selectedMesh === mesh) {
    selectMesh(null);
    return;
  }
  refreshPieceList();
}

function selectMesh(mesh) {
  selectedMesh = mesh;

  if (selectionHelper) {
    scene.remove(selectionHelper);
    selectionHelper.dispose();
    selectionHelper = null;
  }
  if (mesh) {
    selectionHelper = new THREE.BoxHelper(mesh, 0xffd60a);
    scene.add(selectionHelper);
  }

  syncTransformControls();
  refreshPieceList();
  updateToolbarUI();
}

// ---------------------------------------------------------------------------
// Controladores de Oculus Quest 2 (control físico o manos sin control, ver
// 'hand-tracking' en VRButton más arriba)
// ---------------------------------------------------------------------------
function setupControllers() {
  const controllerModelFactory = new XRControllerModelFactory();
  const handModelFactory = new XRHandModelFactory();

  for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController(i);
    const grip = renderer.xr.getControllerGrip(i);
    const hand = renderer.xr.getHand(i);
    controller.userData.isSelecting = false;
    controller.userData.isMoving = false;
    controller.userData.sculptDirection = 1;

    // La mano (izquierda/derecha) solo se conoce cuando el input source conecta;
    // no se puede asumir por el índice del controlador. Tampoco se sabe de
    // antemano si va a conectar un control físico o solo la mano rastreada
    // (hand tracking) - ambos casos llegan aquí con el mismo evento.
    controller.addEventListener('connected', (event) => {
      controller.userData.handedness = event.data.handedness;
      controller.userData.inputSource = event.data; // para háptica (event.data.gamepad)
      controller.userData.hand = hand; // para los gestos de mano (pellizco/palma, ver updateHandGestures)
      if (event.data.handedness === 'right' && controller.children.length === 0) {
        controller.add(buildControllerRay());
      }
    });
    controller.addEventListener('disconnected', (event) => {
      if (controller.userData.inputSource === event.data) controller.userData.inputSource = null;
    });

    controller.addEventListener('selectstart', () => onControllerSelectStart(controller));
    controller.addEventListener('selectend', () => {
      controller.userData.isSelecting = false;
      controller.userData.isMoving = false;
      controller.userData.isRotating = false;
      controller.userData.isDraggingMenu = false;
      commitStroke();
      commitTransformSnapshot();
    });
    controller.addEventListener('squeezestart', () => { controller.userData.sculptDirection = -1; });
    controller.addEventListener('squeezeend', () => { controller.userData.sculptDirection = 1; });

    scene.add(controller);
    controllers.push(controller);

    grip.add(controllerModelFactory.createControllerModel(grip));
    scene.add(grip);

    // Modelo visual de la mano (solo aparece si de verdad conecta hand
    // tracking - XRHandModelFactory no crea nada mientras haya un control
    // físico conectado en ese mismo índice).
    hand.add(handModelFactory.createHandModel(hand, 'mesh'));
    scene.add(hand);
  }
}

function buildControllerRay() {
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -1),
  ]);
  const material = new THREE.LineBasicMaterial({ color: 0xff3b3b });
  const ray = new THREE.Line(geometry, material);
  ray.name = 'tool-ray';
  ray.scale.z = 5;
  return ray;
}

function onControllerSelectStart(controller) {
  if (tryBeginMenuDrag(controller)) return; // cualquier mano puede reubicar el panel por su asa

  if (controller.userData.handedness === 'left') {
    onLeftControllerSelectStart(controller);
    return;
  }
  if (controller.userData.handedness !== 'right') return;

  const menuHit = raycastVRMenu(controller);
  if (menuHit) {
    pulseHaptic(controller, 0.6, 20); // confirmación: más fuerte que el "tick" de hover
    activateMenuAction(menuHit.object.userData.action);
    return; // un clic de menú no empieza también un trazo sobre la malla
  }

  tempMatrix.identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
  const hits = raycaster.intersectObjects(visibleMeshes(), false);
  const anyHit = pickFrontFacingHits(hits, raycaster.ray.direction)[0] || null;
  if (anyHit) {
    selectMesh(anyHit.object);
    pulseHaptic(controller, 0.4, 15); // confirma que el rayo sí tocó una pieza
  }

  controller.userData.lastHit = null;

  if (currentTool === 'move') {
    beginControllerMove(controller, anyHit);
  } else if (currentTool === 'rotate') {
    beginControllerRotate(controller, anyHit);
  } else if (currentTool === 'free') {
    // "Libre": mover y rotar a la vez, como agarrar un objeto real con la mano.
    beginControllerMove(controller, anyHit);
    beginControllerRotate(controller, anyHit);
  } else if (currentTool === 'sculpt' || currentTool === 'paint' || currentTool === 'smartpaint') {
    controller.userData.isSelecting = true;
    controller.userData.smartPaintFaces = new Set();
  }
}

// La mano izquierda NO pasa por el menú/herramienta activa: agarra y rota
// directamente la pieza seleccionada, sin importar qué esté haciendo la
// derecha (esculpir/pintar/mover) - como sujetar una pieza real con una mano
// mientras se trabaja con la otra. Reutiliza el mismo "agarrar y girar la
// mano" que ya usan Rotar/Libre con la derecha (beginControllerRotate).
function onLeftControllerSelectStart(controller) {
  if (selectedMesh && !isLocked(selectedMesh)) {
    beginControllerRotate(controller, { object: selectedMesh });
    pulseHaptic(controller, 0.4, 15);
  }
}

// El asa superior del menú flotante (ver setupVRMenu) se puede agarrar con
// cualquier mano para reubicar el panel completo - independiente de qué tool
// esté activo o de si la mano es la izquierda (rotar) o la derecha (menú/
// herramienta), por eso se revisa ANTES de bifurcar por mano.
function tryBeginMenuDrag(controller) {
  if (!vrMenuOpen || !vrMenuHandle) return false;
  _controllerPos.setFromMatrixPosition(controller.matrixWorld);
  vrMenuHandle.getWorldPosition(_pinchA);
  if (_controllerPos.distanceTo(_pinchA) > MENU_HANDLE_GRAB_RADIUS) return false;

  controller.userData.isDraggingMenu = true;
  controller.userData.menuDragOffset = vrMenuGroup.position.clone().sub(_controllerPos);
  pulseHaptic(controller, 0.5, 15);
  return true;
}

function updateMenuDrag(controller) {
  _controllerPos.setFromMatrixPosition(controller.matrixWorld);
  vrMenuGroup.position.copy(_controllerPos).add(controller.userData.menuDragOffset);
}

// Vibración corta del control derecho (sin efecto si usa hand tracking: las
// manos no tienen gamepad/actuador háptico, el optional chaining lo cubre).
function pulseHaptic(controller, intensity, durationMs) {
  const actuator = controller?.userData?.inputSource?.gamepad?.hapticActuators?.[0];
  if (actuator) actuator.pulse(intensity, durationMs);
}

function raycastVRMenu(controller) {
  if (!vrMenuOpen) return null; // Raycaster no respeta .visible solo: hay que cortar aquí
  tempMatrix.identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
  const hits = raycaster.intersectObjects(vrMenuButtons, false);
  return hits.length > 0 ? hits[0] : null;
}

// Resalta con un ligero aumento de tamaño el botón que el rayo señala en
// este momento (antes de disparar), y coloca la mira de precisión justo
// donde cae el rayo - sobre un botón del menú o sobre la pieza. Se llama una
// vez por frame, solo en VR (ver render()).
function updateVRPointer() {
  const controller = controllers.find((c) => c.userData.handedness === 'right');
  if (!controller || !controller.userData.inputSource) {
    vrReticle.visible = false;
    setHoveredMenuButton(null);
    return;
  }

  const menuHit = raycastVRMenu(controller);
  if (menuHit) {
    setHoveredMenuButton(menuHit.object);
    vrReticle.visible = true;
    vrReticle.position.copy(menuHit.point);
    return;
  }
  setHoveredMenuButton(null);

  tempMatrix.identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
  const hit = pickFrontFacingHits(raycaster.intersectObjects(visibleMeshes(), false), raycaster.ray.direction)[0];
  vrReticle.visible = !!hit;
  if (hit) vrReticle.position.copy(hit.point);
}

function setHoveredMenuButton(button) {
  if (hoveredMenuButton !== button) {
    hoveredMenuButton = button;
    if (button) {
      const controller = controllers.find((c) => c.userData.handedness === 'right');
      pulseHaptic(controller, 0.2, 10); // "tick" ligero al entrar a un botón nuevo
    }
  }
  applyMenuButtonScales();
}

function applyMenuButtonScales() {
  for (const button of vrMenuButtons) {
    const baseScale = button.userData.baseScale || 1;
    button.scale.setScalar(button === hoveredMenuButton ? baseScale * 1.15 : baseScale);
  }
}

// ---------------------------------------------------------------------------
// Gestos de mano (hand tracking): pellizco de ambas manos = zoom; ambas
// palmas hacia arriba (sostenido) = abrir/cerrar el menú flotante. Se llama
// una vez por frame, solo en VR (ver render()).
// ---------------------------------------------------------------------------
function updateHandGestures(time) {
  const leftController = controllers.find((c) => c.userData.handedness === 'left');
  const rightController = controllers.find((c) => c.userData.handedness === 'right');
  updateTwoHandZoom(leftController, rightController);
  updatePalmGesture(leftController?.userData?.hand, rightController?.userData?.hand, time);
}

// Acercar/alejar las dos manos mientras AMBAS pellizcan a la vez escala la
// pieza seleccionada (como el gesto de "pellizcar para hacer zoom" de una
// pantalla táctil, pero con las dos manos en vez de dos dedos).
function updateTwoHandZoom(leftController, rightController) {
  const leftHand = leftController?.userData?.hand;
  const rightHand = rightController?.userData?.hand;
  const bothPinching = !!(leftHand?.inputState?.pinching && rightHand?.inputState?.pinching);

  if (!bothPinching) {
    if (twoHandZoom.active) {
      twoHandZoom.active = false;
      commitTransformSnapshot();
    }
    return;
  }

  if (!selectedMesh || isLocked(selectedMesh)) return;

  _pinchA.setFromMatrixPosition(leftController.matrixWorld);
  _pinchB.setFromMatrixPosition(rightController.matrixWorld);
  const distance = _pinchA.distanceTo(_pinchB);

  if (!twoHandZoom.active) {
    beginTransformSnapshot(selectedMesh);
    twoHandZoom.active = true;
    twoHandZoom.startDistance = distance;
    twoHandZoom.startScale.copy(selectedMesh.scale);
    return;
  }

  const ratio = THREE.MathUtils.clamp(distance / twoHandZoom.startDistance, 0.3, 3);
  selectedMesh.scale.copy(twoHandZoom.startScale).multiplyScalar(ratio);
}

// Normal de la palma (hacia afuera de la mano), estimada a partir de tres
// articulaciones estables (muñeca + base de los metacarpianos de índice y
// meñique) - evita depender de las puntas de los dedos, más propensas a
// perder el rastreo. Escribe el resultado en 'target' (Vector3 propio de
// cada mano - NO reutilizar el mismo vector para ambas manos en el mismo
// frame, ver _leftPalmNormal/_rightPalmNormal). Devuelve null si falta algún
// dato de rastreo (mano no conectada, o joints sin pose válida este frame).
function getPalmNormal(hand, handedness, target) {
  const wrist = hand?.joints?.['wrist'];
  const indexMeta = hand?.joints?.['index-finger-metacarpal'];
  const pinkyMeta = hand?.joints?.['pinky-finger-metacarpal'];
  if (!wrist?.visible || !indexMeta?.visible || !pinkyMeta?.visible) return null;

  wrist.getWorldPosition(_palmWrist);
  indexMeta.getWorldPosition(_palmIndex);
  pinkyMeta.getWorldPosition(_palmPinky);
  _palmA.subVectors(_palmIndex, _palmWrist);
  _palmB.subVectors(_palmPinky, _palmWrist);
  target.crossVectors(_palmA, _palmB).normalize();
  // La anatomía espejada invierte el signo de una mano a la otra; si el
  // gesto termina abriéndose con las palmas hacia ABAJO, cambiar cuál de
  // las dos manos se niega aquí (probar 'right' en vez de 'left').
  if (handedness === 'left') target.negate();
  return target;
}

function updatePalmGesture(leftHand, rightHand, time) {
  const leftNormal = getPalmNormal(leftHand, 'left', _leftPalmNormal);
  const rightNormal = getPalmNormal(rightHand, 'right', _rightPalmNormal);
  const bothPalmsUp = !!(leftNormal && rightNormal && leftNormal.y > PALM_UP_DOT_THRESHOLD && rightNormal.y > PALM_UP_DOT_THRESHOLD);

  if (!bothPalmsUp) {
    palmGesture.holdStartTime = 0;
    palmGesture.armed = true; // hay que bajar las palmas antes de poder disparar de nuevo
    return;
  }
  if (!palmGesture.armed) return;
  if (palmGesture.holdStartTime === 0) {
    palmGesture.holdStartTime = time;
    return;
  }
  if (time - palmGesture.holdStartTime >= PALM_GESTURE_HOLD_MS) {
    palmGesture.armed = false;
    toggleVRMenu();
  }
}

function toggleVRMenu() {
  vrMenuOpen = !vrMenuOpen;
  vrMenuGroup.visible = vrMenuOpen;
  if (vrMenuOpen && !vrMenuGroup.userData.everPositioned) {
    positionVRMenuInFrontOfUser();
    vrMenuGroup.userData.everPositioned = true;
  }
  const leftController = controllers.find((c) => c.userData.handedness === 'left');
  const rightController = controllers.find((c) => c.userData.handedness === 'right');
  pulseHaptic(leftController, 0.4, 20);
  pulseHaptic(rightController, 0.4, 20);
}

// Posición inicial del panel la PRIMERA vez que se abre: a media distancia
// cómoda delante de la cabeza, orientado como estaba la cabeza EN ESE
// INSTANTE (una foto fija, no sigue la vista después - si siguiera la
// cámara cada frame tendría exactamente el mismo problema de "me persigue"
// que ya se corrigió para el modelo principal).
function positionVRMenuInFrontOfUser() {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  vrMenuGroup.position.copy(camera.position).addScaledVector(forward, 0.5);
  vrMenuGroup.position.y -= 0.15;
  vrMenuGroup.quaternion.copy(camera.quaternion);
}


// ---------------------------------------------------------------------------
// Navegación de cámara al estilo Unity 3D (ver README para la lista completa):
//  - Clic derecho + arrastrar: Pan (la cámara y el punto de referencia se
//    desplazan juntos, sin rotar).
//  - Shift (o Ctrl/Cmd) + clic derecho + arrastrar: Órbita alrededor del punto
//    de referencia -lo resuelve OrbitControls solo: intercambia Pan<->Órbita
//    con esos modificadores en cualquier botón que tenga uno de los dos
//    asignado, sin código propio-.
//  - Alt + clic izquierdo + arrastrar: Órbita, sin soltar la herramienta
//    activa (igual que "Alt+clic izquierdo" en Unity).
//  - Alt + clic derecho + arrastrar: Zoom (igual que "Alt+clic derecho" en
//    Unity).
//  - Clic central + arrastrar: Pan (atajo "sea cual sea la herramienta",
//    como el botón central en Unity).
//  - Rueda del ratón: Zoom (sin cambios, independiente de todo lo anterior).
// Los botones LEFT/RIGHT de OrbitControls no soportan re-mapeo dinámico por
// sí solos (se leen una sola vez por cada pointerdown); se reescriben AQUÍ en
// cada pointerdown, ANTES de que OrbitControls (y el manejador de
// herramientas de abajo) procesen el evento -un listener en fase de captura
// sobre window es el único punto con orden garantizado, sea cual sea el
// orden en que se crearon los demás listeners sobre el canvas-.
function setupCameraNavigation() {
  window.addEventListener('pointerdown', (event) => {
    if (renderer.xr.isPresenting) return;
    desktopControls.mouseButtons.LEFT = event.altKey ? THREE.MOUSE.ROTATE : null;
    desktopControls.mouseButtons.RIGHT = event.altKey ? THREE.MOUSE.DOLLY : THREE.MOUSE.PAN;
  }, { capture: true });
}

// ---------------------------------------------------------------------------
// Versión de escritorio: usar la herramienta activa con el ratón
// ---------------------------------------------------------------------------
function setupDesktopInteraction() {
  const canvas = renderer.domElement;
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || renderer.xr.isPresenting) return; // solo clic izquierdo, fuera de VR
    if (event.altKey) return; // Alt+clic izquierdo es órbita de cámara (ver setupCameraNavigation), no la herramienta
    updateMouseNDC(event);

    const isTransformTool = currentTool === 'move' || currentTool === 'rotate' || currentTool === 'scale' || currentTool === 'free';
    if (isTransformTool) {
      // Si algún gizmo ya capturó este clic (arrastrando un eje), no tocar la selección.
      if (!isAnyGizmoAxisActive()) selectPieceUnderPointer();
      return;
    }

    selectPieceUnderPointer(); // un clic con cualquier herramienta también selecciona la pieza
    isDesktopActing = true;
    desktopSculptDirection = event.shiftKey ? -1 : 1; // Shift + clic = hundir al esculpir
    lastHitMouse = null;
    activeSmartPaintFaces = new Set();
  });

  window.addEventListener('pointerup', (event) => {
    if (event.button !== 0) return;
    isDesktopActing = false;
    commitStroke();
  });

  canvas.addEventListener('pointermove', updateMouseNDC);
}

function isAnyGizmoAxisActive() {
  return tcMove.axis !== null || tcRotate.axis !== null || tcScale.axis !== null;
}

function selectPieceUnderPointer() {
  raycaster.setFromCamera(mouseNDC, camera);
  const hits = raycaster.intersectObjects(visibleMeshes(), false);
  const anyHit = pickFrontFacingHits(hits, raycaster.ray.direction)[0] || null;
  if (anyHit) selectMesh(anyHit.object);
}

function setupKeyboardShortcuts() {
  // Atajos al estilo Unity: W mover, E rotar, R escalar, Y herramienta Libre,
  // F encuadrar la pieza seleccionada, Ctrl+Z deshacer.
  window.addEventListener('keydown', (event) => {
    if (renderer.xr.isPresenting) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undo();
      return;
    }

    const key = event.key.toLowerCase();
    if (key === 'w') setTool('move');
    else if (key === 'e') setTool('rotate');
    else if (key === 'r') setTool('scale');
    else if (key === 'y') setTool('free');
    else if (key === 'f') focusOnSelection();
  });
}

// "F" al estilo Unity (Edit > Frame Selected): centra el punto de referencia
// de la órbita en la pieza seleccionada y ajusta la distancia para encuadrarla
// completa, conservando el ángulo de vista actual (no reorienta la cámara).
function focusOnSelection() {
  if (!selectedMesh) return;

  const box = new THREE.Box3().setFromObject(selectedMesh);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2 || 0.1;

  const viewDirection = new THREE.Vector3().subVectors(camera.position, desktopControls.target).normalize();
  const fitDistance = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2)) * 1.4; // margen para no pegarla al borde

  desktopControls.target.copy(center);
  camera.position.copy(center).addScaledVector(viewDirection, fitDistance);
  desktopControls.update();
}

function updateMouseNDC(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouseNDC.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouseNDC.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  if (currentTool === 'free') updateFreeGizmoPriority();
}

// En la herramienta "Libre" los tres gizmos están activos a la vez. Sus asas
// VISIBLES no se solapan (escalar/mover/rotar ocupan radios distintos), pero
// sus zonas de clic invisibles sí -mover y escalar arrancan ambas desde el
// centro del objeto, y los anillos de rotar se proyectan en 2D sobre esa zona
// según el ángulo de cámara-. Sin arbitraje, un solo clic podría arrancar dos
// arrastres a la vez (p. ej. mover Y escalar el mismo eje). Por eso, en cada
// movimiento del ratón (antes de soltar el clic) se decide qué gizmo "gana"
// -el asa más pequeña/específica tiene prioridad: escalar > mover > rotar- y
// se deshabilitan los otros dos mientras no haya ya un arrastre en curso.
function updateFreeGizmoPriority() {
  const anyDragging = tcScale.dragging || tcMove.dragging || tcRotate.dragging;
  if (anyDragging) return;

  tcScale.pointerHover(mouseNDC);
  tcMove.pointerHover(mouseNDC);
  tcRotate.pointerHover(mouseNDC);

  const winner = tcScale.axis ? tcScale : tcMove.axis ? tcMove : tcRotate.axis ? tcRotate : null;
  tcScale.enabled = winner === tcScale || winner === null;
  tcMove.enabled = winner === tcMove || winner === null;
  tcRotate.enabled = winner === tcRotate || winner === null;
}

function applyBrushFromMouse(deltaSeconds) {
  if (meshes.length === 0 || deltaSeconds <= 0) return;

  raycaster.setFromCamera(mouseNDC, camera);
  const hits = raycaster.intersectObjects(visibleMeshes(), false);
  const hit = pickActionableHit(hits, raycaster.ray.direction);

  if (hit) {
    lastHitMouse = { mesh: hit.object, point: hit.object.worldToLocal(hit.point.clone()), faceIndex: hit.faceIndex };
  } else if (!lastHitMouse) {
    return; // el rayo nunca ha tocado una pieza utilizable en este trazo
  }

  applyToolAt(lastHitMouse.mesh, lastHitMouse.point, desktopSculptDirection, deltaSeconds, lastHitMouse.faceIndex, activeSmartPaintFaces);
}

// Recoloca y muestra la "sombra" del pincel sobre lo que haya justo debajo
// del cursor (escritorio) o del rayo del controlador derecho (VR), SIN
// necesidad de tener el gatillo/clic presionado -es una vista previa, no
// una acción-. Se oculta fuera de Esculpir/Pintar o si el rayo no toca nada.
function updateBrushIndicator() {
  const isBrushTool = currentTool === 'sculpt' || currentTool === 'paint';
  if (!isBrushTool || meshes.length === 0) {
    brushIndicator.visible = false;
    return;
  }

  let hit = null;
  if (renderer.xr.isPresenting) {
    const controller = controllers.find((c) => c.userData.handedness === 'right');
    if (controller) {
      tempMatrix.identity().extractRotation(controller.matrixWorld);
      raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
      raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
      hit = pickActionableHit(raycaster.intersectObjects(visibleMeshes(), false), raycaster.ray.direction);
    }
  } else {
    raycaster.setFromCamera(mouseNDC, camera);
    hit = pickActionableHit(raycaster.intersectObjects(visibleMeshes(), false), raycaster.ray.direction);
  }

  if (!hit) {
    brushIndicator.visible = false;
    return;
  }

  _worldNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
  brushIndicator.visible = true;
  brushIndicator.scale.setScalar(BRUSH_RADIUS);
  brushIndicator.position.copy(hit.point).addScaledVector(_worldNormal, 0.0015);
  brushIndicator.quaternion.setFromUnitVectors(_circleUp, _worldNormal);
}

// Las piezas ocultas (ojo cerrado en la lista) quedan fuera de todo
// raycasting: no se pueden seleccionar ni esculpir/pintar/mover mientras
// estén ocultas, con ratón, controlador o lápiz de VR.
function visibleMeshes() {
  return meshes.filter((mesh) => mesh.visible);
}

// Con material DoubleSide, un rayo puede tocar tanto la cara cercana como la
// lejana (la "de adentro") de cada pieza; nos quedamos solo con las que miran
// hacia la cámara/rayo, ya ordenadas de la más cercana a la más lejana.
function pickFrontFacingHits(hits, rayDirection) {
  return hits.filter((hit) => {
    const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    return worldNormal.dot(rayDirection) < 0;
  });
}

// De los impactos frontales, el primero cuya pieza no esté bloqueada. Así
// una pieza bloqueada "deja pasar" el rayo hacia lo que haya detrás, en vez
// de bloquear también lo que está más allá.
function pickActionableHit(hits, rayDirection) {
  const frontHits = pickFrontFacingHits(hits, rayDirection);
  return frontHits.find((hit) => !isLocked(hit.object)) || null;
}

// ---------------------------------------------------------------------------
// Bucle de render
// ---------------------------------------------------------------------------
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function render(time) {
  const deltaSeconds = lastFrameTime ? (time - lastFrameTime) / 1000 : 0;
  lastFrameTime = time;

  if (!renderer.xr.isPresenting) {
    desktopControls.update();
    if (isDesktopActing) {
      applyBrushFromMouse(deltaSeconds);
    }
  }

  for (const controller of controllers) {
    if (controller.userData.isMoving) updateControllerMove(controller);
    if (controller.userData.isRotating) updateControllerRotate(controller);
    if (controller.userData.isDraggingMenu) updateMenuDrag(controller);
    if (controller.userData.handedness === 'right' && controller.userData.isSelecting) {
      applyBrushFromController(controller, deltaSeconds);
    }
  }

  if (renderer.xr.isPresenting) {
    updateVRPointer();
    updateHandGestures(time);
  }
  updateBrushIndicator();
  if (selectionHelper) selectionHelper.update();
  sendPresence(time);
  updatePeerAvatars(deltaSeconds);

  renderer.render(scene, camera);
}

function applyBrushFromController(controller, deltaSeconds) {
  if (meshes.length === 0 || deltaSeconds <= 0) return;

  // Rayo hacia adelante (-Z local) desde el controlador derecho.
  tempMatrix.identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

  const hits = raycaster.intersectObjects(visibleMeshes(), false);
  const hit = pickActionableHit(hits, raycaster.ray.direction);

  if (hit) {
    controller.userData.lastHit = { mesh: hit.object, point: hit.object.worldToLocal(hit.point.clone()), faceIndex: hit.faceIndex };
  } else if (!controller.userData.lastHit) {
    return; // el rayo nunca ha tocado una pieza utilizable en este trazo
  }

  applyToolAt(controller.userData.lastHit.mesh, controller.userData.lastHit.point, controller.userData.sculptDirection, deltaSeconds, controller.userData.lastHit.faceIndex, controller.userData.smartPaintFaces);
}

function applyToolAt(mesh, centerLocal, direction, deltaSeconds, faceIndex, filledFaces) {
  if (currentTool === 'paint') {
    beginStrokeIfNeeded(mesh, 'color');
    paintVerticesNear(mesh, centerLocal, deltaSeconds);
  } else if (currentTool === 'sculpt') {
    beginStrokeIfNeeded(mesh, 'position');
    displaceVerticesNear(mesh, centerLocal, direction, deltaSeconds);
  } else if (currentTool === 'smartpaint') {
    applySmartPaint(mesh, faceIndex, filledFaces);
  }
}

function beginControllerMove(controller, hit) {
  if (!hit || isLocked(hit.object)) return;

  beginTransformSnapshot(hit.object);
  const controllerPos = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
  controller.userData.moveMesh = hit.object;
  controller.userData.moveOffset = hit.object.position.clone().sub(controllerPos);
  controller.userData.isMoving = true;
}

function updateControllerMove(controller) {
  const controllerPos = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
  controller.userData.moveMesh.position.copy(controllerPos).add(controller.userData.moveOffset);
}

// Rotar en VR no usa un gizmo (no hay forma natural de arrastrar ejes 2D con
// un controlador apuntando en 3D); en vez de eso, la pieza gira exactamente
// lo mismo que el controlador desde que se empezó a sujetar - "agarrar y girar
// la mano", igual que se manipularía un objeto real.
function beginControllerRotate(controller, hit) {
  if (!hit || isLocked(hit.object)) return;

  beginTransformSnapshot(hit.object);
  controller.userData.rotateMesh = hit.object;
  controller.userData.rotateStartControllerQuat = controller.quaternion.clone();
  controller.userData.rotateStartMeshQuat = hit.object.quaternion.clone();
  controller.userData.isRotating = true;
}

function updateControllerRotate(controller) {
  _deltaQuat.copy(controller.quaternion).multiply(controller.userData.rotateStartControllerQuat.clone().invert());
  controller.userData.rotateMesh.quaternion.copy(_deltaQuat).multiply(controller.userData.rotateStartMeshQuat);
}

function displaceVerticesNear(mesh, centerLocal, direction, deltaSeconds) {
  const geometry = mesh.geometry;
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const step = SCULPT_STRENGTH * deltaSeconds * direction;

  for (let i = 0; i < position.count; i++) {
    _vertex.fromBufferAttribute(position, i);
    const distance = _vertex.distanceTo(centerLocal);
    if (distance >= BRUSH_RADIUS) continue;

    // Caída suave (smoothstep) para que el pincel deforme de forma fluida,
    // en vez de un borde duro en el límite del radio de influencia.
    const t = 1 - distance / BRUSH_RADIUS;
    const falloff = t * t * (3 - 2 * t);

    _normal.fromBufferAttribute(normal, i);
    _vertex.addScaledVector(_normal, step * falloff);
    position.setXYZ(i, _vertex.x, _vertex.y, _vertex.z);
  }

  position.needsUpdate = true;
  geometry.computeVertexNormals(); // recalcula las normales para que el sombreado siga la nueva forma
  geometry.computeBoundingSphere(); // mantiene el raycasting correcto tras deformar la malla
}

function paintVerticesNear(mesh, centerLocal, deltaSeconds) {
  const geometry = mesh.geometry;
  const position = geometry.attributes.position;
  const color = geometry.attributes.color;
  const mixAmount = Math.min(1, PAINT_STRENGTH * deltaSeconds);

  for (let i = 0; i < position.count; i++) {
    _vertex.fromBufferAttribute(position, i);
    const distance = _vertex.distanceTo(centerLocal);
    if (distance >= BRUSH_RADIUS) continue;

    const t = 1 - distance / BRUSH_RADIUS;
    const falloff = t * t * (3 - 2 * t);

    _color.fromBufferAttribute(color, i);
    _color.lerp(currentColor, mixAmount * falloff);
    color.setXYZ(i, _color.r, _color.g, _color.b);
  }

  color.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// "Pintado rápido": tocas un punto (p. ej. un ojo) y se selecciona+pinta de
// una vez toda la superficie conectada con una normal parecida, deteniéndose
// sola al llegar a un borde/arista (donde la normal cambia de golpe).
// ---------------------------------------------------------------------------

// La conectividad entre caras (qué triángulos son vecinos) depende solo de la
// topología del índice, que no cambia al esculpir — se calcula una vez por
// pieza y se guarda en userData. Las normales de cara, en cambio, sí dependen
// de las posiciones actuales de los vértices, así que se recalculan cada uso.
function getFaceAdjacency(mesh) {
  if (!mesh.userData.faceAdjacency) {
    mesh.userData.faceAdjacency = buildFaceAdjacency(mesh.geometry);
  }
  return mesh.userData.faceAdjacency;
}

function buildFaceAdjacency(geometry) {
  const index = geometry.index;
  if (!index) return { neighbors: [], faceCount: 0 };

  const faceCount = index.count / 3;
  const edgeFaces = new Map(); // "menorÍndice_mayorÍndice" -> [caras que comparten esa arista]

  const addEdge = (a, b, faceIndex) => {
    const key = a < b ? a + '_' + b : b + '_' + a;
    let faces = edgeFaces.get(key);
    if (!faces) { faces = []; edgeFaces.set(key, faces); }
    faces.push(faceIndex);
  };

  for (let f = 0; f < faceCount; f++) {
    const ia = index.getX(f * 3), ib = index.getX(f * 3 + 1), ic = index.getX(f * 3 + 2);
    addEdge(ia, ib, f);
    addEdge(ib, ic, f);
    addEdge(ic, ia, f);
  }

  const neighbors = Array.from({ length: faceCount }, () => []);
  for (const faces of edgeFaces.values()) {
    // Una arista compartida por exactamente 2 caras las vuelve vecinas; en
    // los bordes abiertos de la malla una arista solo tiene 1 cara (sin vecino).
    if (faces.length === 2) {
      neighbors[faces[0]].push(faces[1]);
      neighbors[faces[1]].push(faces[0]);
    }
  }

  return { neighbors, faceCount };
}

// Normal real de cada triángulo (no la suavizada por vértice) — necesaria
// para detectar aristas marcadas con precisión. Misma fórmula que usa
// internamente BufferGeometry.computeVertexNormals(), para quedar consistentes.
function computeFaceNormals(geometry) {
  const index = geometry.index;
  const position = geometry.attributes.position;
  const faceCount = index.count / 3;
  const normals = new Array(faceCount);

  for (let f = 0; f < faceCount; f++) {
    const ia = index.getX(f * 3), ib = index.getX(f * 3 + 1), ic = index.getX(f * 3 + 2);
    _pA.fromBufferAttribute(position, ia);
    _pB.fromBufferAttribute(position, ib);
    _pC.fromBufferAttribute(position, ic);
    _edgeCB.subVectors(_pC, _pB);
    _edgeAB.subVectors(_pA, _pB);
    normals[f] = _edgeCB.clone().cross(_edgeAB).normalize();
  }

  return normals;
}

// Expande la selección desde la cara tocada hacia sus vecinas mientras el
// ángulo entre normales de caras consecutivas no supere el umbral — así sigue
// una superficie curva con normalidad, pero se detiene seca en una arista viva.
function floodFillSimilarFaces(mesh, startFaceIndex, angleThresholdRad) {
  const { neighbors, faceCount } = getFaceAdjacency(mesh);
  if (startFaceIndex == null || startFaceIndex >= faceCount) return [];

  const faceNormals = computeFaceNormals(mesh.geometry);
  const cosThreshold = Math.cos(angleThresholdRad);

  const visited = new Uint8Array(faceCount);
  const stack = [startFaceIndex];
  visited[startFaceIndex] = 1;
  const result = [startFaceIndex];

  while (stack.length > 0) {
    const f = stack.pop();
    const normalF = faceNormals[f];
    for (const n of neighbors[f]) {
      if (visited[n]) continue;
      if (normalF.dot(faceNormals[n]) >= cosThreshold) {
        visited[n] = 1;
        result.push(n);
        stack.push(n);
      }
    }
  }

  return result;
}

function paintFaces(mesh, faceIndices, color) {
  const index = mesh.geometry.index;
  const colorAttr = mesh.geometry.attributes.color;

  for (const f of faceIndices) {
    colorAttr.setXYZ(index.getX(f * 3), color.r, color.g, color.b);
    colorAttr.setXYZ(index.getX(f * 3 + 1), color.r, color.g, color.b);
    colorAttr.setXYZ(index.getX(f * 3 + 2), color.r, color.g, color.b);
  }

  colorAttr.needsUpdate = true;
}

// filledFaces evita rehacer el flood-fill si el rayo sigue sobre una cara que
// ya quedó pintada en este mismo trazo (p. ej. al mantener el gatillo/clic
// quieto, o al arrastrar dentro de la misma región ya seleccionada).
function applySmartPaint(mesh, faceIndex, filledFaces) {
  if (faceIndex == null || !filledFaces || filledFaces.has(faceIndex)) return;

  beginStrokeIfNeeded(mesh, 'color');
  const faces = floodFillSimilarFaces(mesh, faceIndex, smartPaintAngleThresholdRad);
  paintFaces(mesh, faces, currentColor);
  for (const f of faces) filledFaces.add(f);
}
// ---------------------------------------------------------------------------
function pushUndo(action) {
  undoStack.push(action);
  if (undoStack.length > MAX_UNDO) {
    const evicted = undoStack.shift();
    if (evicted.type === 'delete') {
      evicted.mesh.geometry.dispose();
      evicted.mesh.material.dispose();
    }
  }
  updateUndoButton();
}

function undo() {
  const action = undoStack.pop();
  if (!action) return;

  if (action.type === 'geometry') {
    const attr = action.mesh.geometry.attributes[action.attribute];
    attr.array.set(action.before);
    attr.needsUpdate = true;
    if (action.attribute === 'position') {
      action.mesh.geometry.computeVertexNormals();
      action.mesh.geometry.computeBoundingSphere();
    }
    selectMesh(action.mesh);
  } else if (action.type === 'transform') {
    action.mesh.position.copy(action.before.position);
    action.mesh.quaternion.copy(action.before.quaternion);
    action.mesh.scale.copy(action.before.scale);
    selectMesh(action.mesh);
  } else if (action.type === 'delete') {
    meshes.splice(action.index, 0, action.mesh);
    scene.add(action.mesh);
    selectMesh(action.mesh);
  }

  updateUndoButton();
}

function beginStrokeIfNeeded(mesh, attribute) {
  if (activeStroke) return; // ya se tomó una instantánea para este trazo
  activeStroke = { mesh, attribute, before: mesh.geometry.attributes[attribute].array.slice() };
}

function commitStroke() {
  if (!activeStroke) return;
  const { mesh, attribute, before } = activeStroke;
  pushUndo({ type: 'geometry', mesh, attribute, before, after: mesh.geometry.attributes[attribute].array.slice() });
  activeStroke = null;
}

function beginTransformSnapshot(mesh) {
  if (activeTransformSnapshot && activeTransformSnapshot.mesh === mesh) return; // ya se tomó
  activeTransformSnapshot = {
    mesh,
    before: { position: mesh.position.clone(), quaternion: mesh.quaternion.clone(), scale: mesh.scale.clone() },
  };
  lockNetworkPiece(mesh); // avisa a los demás "la estoy usando" (Fase 4, no-op si no es pieza de red)
}

function commitTransformSnapshot() {
  if (!activeTransformSnapshot) return;
  const { mesh, before } = activeTransformSnapshot;
  const after = { position: mesh.position.clone(), quaternion: mesh.quaternion.clone(), scale: mesh.scale.clone() };
  pushUndo({ type: 'transform', mesh, before, after });
  activeTransformSnapshot = null;
  sendPieceTransform(mesh, after);
  unlockNetworkPiece(mesh);
}

function updateUndoButton() {
  const button = document.getElementById('undo-btn');
  if (button) button.disabled = undoStack.length === 0;
}

// ---------------------------------------------------------------------------
// Herramientas: selección de modo, color, tamaño y bloqueos (escritorio + VR)
// ---------------------------------------------------------------------------
function setTool(tool) {
  currentTool = tool;
  syncTransformControls();
  updateToolbarUI();
  updateVRMenuHighlight();
}

function setColor(hex) {
  currentColor.set(hex);
  updateToolbarUI();
  updateVRMenuHighlight();
}

// Envuelto en begin/commit igual que los demás transforms - de regalo queda
// deshacer-capaz (antes no lo era) y sincronizado en red (Fase 4), sin
// lógica nueva: es un cambio instantáneo, el "arrastre" dura un solo tick.
function scaleModel(factor) {
  if (!selectedMesh || isLocked(selectedMesh)) return;
  beginTransformSnapshot(selectedMesh);
  selectedMesh.scale.multiplyScalar(factor);
  commitTransformSnapshot();
}

// Bloqueo MANUAL (el candado de la lista de piezas) - persistente hasta que
// el usuario lo cambie a mano. Distinto del bloqueo automático de red
// (userData.networkLockedBy, ver isLocked) que solo dura mientras OTRO
// usuario está arrastrando/rotando/escalando esa pieza en este momento.
function toggleLock(mesh) {
  mesh.userData.locked = !mesh.userData.locked;
  if (mesh === selectedMesh) syncTransformControls();
  refreshPieceList();
}

// Una pieza se considera bloqueada si el usuario la bloqueó a mano O si
// alguien más la tiene agarrada ahora mismo en la red (ver Fase 4).
function isLocked(mesh) {
  return !!(mesh.userData.locked || mesh.userData.networkLockedBy);
}

// Adjunta/separa los tres gizmos de Unity según la herramienta activa, la
// pieza seleccionada y si está bloqueada. En "Libre" los tres se muestran a
// la vez. El bloqueo es único por pieza (ya no hay bloqueos separados por
// mover/rotar/escalar/pintar/esculpir): bloqueada = no se puede editar nada.
function syncTransformControls() {
  // Siempre se parte de los tres gizmos habilitados; el arbitraje de "Libre"
  // (updateFreeGizmoPriority) los deshabilita/rehabilita solo durante el hover
  // en esa herramienta concreta, nunca debe quedar "pegado" al cambiar de
  // herramienta o de pieza seleccionada.
  tcMove.enabled = true;
  tcRotate.enabled = true;
  tcScale.enabled = true;

  const canEdit = !!(selectedMesh && selectedMesh.visible && !isLocked(selectedMesh));
  const slots = [
    { tc: tcMove, tool: 'move' },
    { tc: tcRotate, tool: 'rotate' },
    { tc: tcScale, tool: 'scale' },
  ];

  for (const { tc, tool } of slots) {
    const wantsThisGizmo = currentTool === tool || currentTool === 'free';
    if (wantsThisGizmo && canEdit) {
      tc.attach(selectedMesh);
    } else {
      tc.detach();
    }
  }
}

function activateMenuAction(action) {
  if (action.startsWith('tool:')) {
    setTool(action.slice(5));
  } else if (action.startsWith('color:')) {
    setColor(action.slice(6));
  } else if (action === 'zoom:in') {
    scaleModel(RESIZE_STEP);
  } else if (action === 'zoom:out') {
    scaleModel(1 / RESIZE_STEP);
  } else if (action === 'undo') {
    undo();
  }
}

// ---------------------------------------------------------------------------
// Barra de herramientas de escritorio (HTML)
// ---------------------------------------------------------------------------
function setupToolbar() {
  document.querySelectorAll('.tool-btn[data-tool]').forEach((button) => {
    button.addEventListener('click', () => setTool(button.dataset.tool));
  });

  const palette = document.getElementById('color-palette');
  const colorPicker = document.getElementById('color-picker');
  COLOR_PALETTE.forEach((hex) => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'color-swatch';
    swatch.style.background = hex;
    swatch.dataset.color = hex;
    swatch.title = hex;
    swatch.addEventListener('click', () => setColor(hex));
    palette.insertBefore(swatch, colorPicker);
  });

  colorPicker.addEventListener('input', (event) => setColor(event.target.value));

  const precisionSlider = document.getElementById('precision-slider');
  const precisionValue = document.getElementById('precision-value');
  precisionSlider.addEventListener('input', (event) => {
    const raw = Number(event.target.value);
    if (currentTool === 'smartpaint') {
      smartPaintAngleThresholdRad = THREE.MathUtils.degToRad(raw);
      precisionValue.textContent = raw + '°';
    } else {
      BRUSH_RADIUS = raw;
      precisionValue.textContent = (raw * 100).toFixed(1) + ' cm';
    }
  });

  document.getElementById('resize-in').addEventListener('click', () => scaleModel(RESIZE_STEP));
  document.getElementById('resize-out').addEventListener('click', () => scaleModel(1 / RESIZE_STEP));

  document.getElementById('stl-file-input').addEventListener('change', (event) => {
    const files = event.target.files;
    if (files.length > 0) loadSTLFilesFromList(files);
    event.target.value = ''; // permite volver a cargar el mismo archivo
  });

  document.getElementById('stl-folder-input').addEventListener('change', (event) => {
    const files = event.target.files;
    if (files.length > 0) loadSTLFilesFromList(files);
    event.target.value = '';
  });

  document.getElementById('undo-btn').addEventListener('click', undo);

  updateToolbarUI();
  updateUndoButton();
  refreshPieceList();
}

// Lista de piezas (barra de escritorio): cada fila se puede seleccionar
// (clic en cualquier parte que no sea un botón) y trae sus propios botones
// de ver/ocultar (👁️), bloquear/desbloquear (🔓/🔒) y borrar (🗑️) — reemplaza
// al antiguo desplegable + botón de borrar + fila de bloqueos independientes.
function refreshPieceList() {
  const container = document.getElementById('piece-list');
  container.innerHTML = '';

  if (meshes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'piece-list-empty';
    empty.textContent = 'Todavía no hay piezas cargadas.';
    container.appendChild(empty);
    return;
  }

  meshes.forEach((mesh) => {
    const row = document.createElement('div');
    row.className = 'piece-row';
    row.classList.toggle('active', mesh === selectedMesh);
    row.classList.toggle('hidden-piece', !mesh.visible);
    row.title = 'Seleccionar ' + mesh.userData.name;
    row.addEventListener('click', () => selectMesh(mesh));

    const name = document.createElement('span');
    name.className = 'piece-row-name';
    name.textContent = mesh.userData.name;
    row.appendChild(name);

    const visibilityBtn = document.createElement('button');
    visibilityBtn.type = 'button';
    visibilityBtn.className = 'piece-row-icon-btn';
    visibilityBtn.classList.toggle('is-hidden', !mesh.visible);
    visibilityBtn.textContent = '👁️';
    visibilityBtn.title = mesh.visible ? 'Ocultar pieza' : 'Mostrar pieza';
    visibilityBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      setMeshVisible(mesh, !mesh.visible);
    });
    row.appendChild(visibilityBtn);

    const lockBtn = document.createElement('button');
    lockBtn.type = 'button';
    lockBtn.className = 'piece-row-icon-btn';
    if (mesh.userData.networkLockedBy) {
      // Alguien más la está editando ahora mismo - no tiene sentido dejar
      // tocar el candado MANUAL mientras tanto, sería confuso.
      lockBtn.textContent = '🔒';
      lockBtn.title = 'Otra persona la está editando ahora mismo';
      lockBtn.disabled = true;
    } else {
      lockBtn.textContent = mesh.userData.locked ? '🔒' : '🔓';
      lockBtn.title = mesh.userData.locked ? 'Desbloquear pieza' : 'Bloquear pieza';
    }
    lockBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleLock(mesh);
    });
    row.appendChild(lockBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'piece-row-icon-btn danger';
    deleteBtn.textContent = '🗑️';
    deleteBtn.title = 'Borrar pieza';
    deleteBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteMesh(mesh);
    });
    row.appendChild(deleteBtn);

    container.appendChild(row);
  });
}

function updateToolbarUI() {
  document.querySelectorAll('.tool-btn[data-tool]').forEach((button) => {
    button.classList.toggle('active', button.dataset.tool === currentTool);
  });
  const showPalette = currentTool === 'paint' || currentTool === 'smartpaint';
  document.getElementById('color-palette').classList.toggle('hidden', !showPalette);
  document.querySelectorAll('.color-swatch').forEach((swatch) => {
    swatch.classList.toggle('active', swatch.dataset.color.toLowerCase() === '#' + currentColor.getHexString());
  });

  // El control "Precisión" es compartido: en "Pintado rápido" ajusta la
  // tolerancia angular de la selección; en Esculpir/Pintar ajusta el ancho
  // del pincel (ver también updateBrushIndicator, que dibuja su sombra).
  const precisionSlider = document.getElementById('precision-slider');
  const precisionValue = document.getElementById('precision-value');
  const isSmartPaint = currentTool === 'smartpaint';
  const isBrushTool = currentTool === 'paint' || currentTool === 'sculpt';
  document.getElementById('precision-options').classList.toggle('hidden', !isSmartPaint && !isBrushTool);

  if (isSmartPaint) {
    precisionSlider.min = '2';
    precisionSlider.max = '60';
    precisionSlider.step = '1';
    precisionSlider.title = 'Ángulo máximo entre caras vecinas para seguir seleccionando (más alto = cubre más superficie)';
    const degrees = Math.round(THREE.MathUtils.radToDeg(smartPaintAngleThresholdRad));
    precisionSlider.value = String(degrees);
    precisionValue.textContent = degrees + '°';
  } else if (isBrushTool) {
    precisionSlider.min = String(BRUSH_RADIUS_MIN);
    precisionSlider.max = String(BRUSH_RADIUS_MAX);
    precisionSlider.step = String(BRUSH_RADIUS_STEP);
    precisionSlider.title = 'Ancho del pincel: radio de influencia al esculpir o pintar (se ve como una sombra sobre la pieza)';
    precisionSlider.value = String(BRUSH_RADIUS);
    precisionValue.textContent = (BRUSH_RADIUS * 100).toFixed(1) + ' cm';
  }
}

// ---------------------------------------------------------------------------
// Menú de VR: panel 3D con herramientas, paleta de colores y tamaño
// ---------------------------------------------------------------------------
function setupVRMenu() {
  vrMenuGroup = new THREE.Group();
  vrMenuGroup.visible = false; // oculto hasta el gesto de "ambas palmas" (ver updateHandGestures)
  vrMenuGroup.userData.everPositioned = false;

  const panelBg = new THREE.Mesh(
    new THREE.PlaneGeometry(0.18, 0.50),
    new THREE.MeshBasicMaterial({ color: 0x15151c, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
  );
  panelBg.position.z = -0.001;
  vrMenuGroup.add(panelBg);

  // Franja superior: pellizca cerca de aquí (con cualquier mano) para
  // arrastrar y reubicar el panel completo (ver tryBeginMenuDrag).
  vrMenuHandle = new THREE.Mesh(
    new THREE.PlaneGeometry(0.18, 0.03),
    new THREE.MeshBasicMaterial({ color: 0x3f88c5, side: THREE.DoubleSide })
  );
  vrMenuHandle.position.set(0, 0.235, 0);
  vrMenuGroup.add(vrMenuHandle);

  const tools = [
    { action: 'tool:sculpt', label: 'Esculpir' },
    { action: 'tool:paint', label: 'Pintar' },
    { action: 'tool:smartpaint', label: 'Rápido' },
    { action: 'tool:move', label: 'Mover' },
    { action: 'tool:rotate', label: 'Rotar' },
    { action: 'tool:free', label: 'Libre' },
  ];
  tools.forEach((toolDef, i) => {
    const button = createMenuButton(toolDef.label, 0.15, 0.034, '#3a3a45');
    button.userData.action = toolDef.action;
    button.position.set(0, 0.2 - i * 0.038, 0);
    vrMenuGroup.add(button);
    vrMenuButtons.push(button);
  });

  COLOR_PALETTE.forEach((hex, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const swatch = createColorSwatch(hex, 0.024);
    swatch.userData.action = 'color:' + hex;
    swatch.position.set(-0.048 + col * 0.03, -0.033 - row * 0.03, 0);
    vrMenuGroup.add(swatch);
    vrMenuButtons.push(swatch);
  });

  // Estos botones cambian el tamaño de la pieza seleccionada (no hay cámara
  // controlable por software en VR: la sigue el propio headset).
  const resizeUp = createMenuButton('+', 0.06, 0.034, '#2a9d8f');
  resizeUp.userData.action = 'zoom:in';
  resizeUp.position.set(-0.04, -0.133, 0);
  vrMenuGroup.add(resizeUp);
  vrMenuButtons.push(resizeUp);

  const resizeDown = createMenuButton('-', 0.06, 0.034, '#e63946');
  resizeDown.userData.action = 'zoom:out';
  resizeDown.position.set(0.04, -0.133, 0);
  vrMenuGroup.add(resizeDown);
  vrMenuButtons.push(resizeDown);

  const undoButton = createMenuButton('Deshacer', 0.15, 0.036, '#3a3a45');
  undoButton.userData.action = 'undo';
  undoButton.position.set(0, -0.193, 0);
  vrMenuGroup.add(undoButton);
  vrMenuButtons.push(undoButton);

  scene.add(vrMenuGroup);
  updateVRMenuHighlight();
}

function createMenuButton(label, width, height, bgColor) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.MeshBasicMaterial({ map: texture });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  mesh.userData.canvas = canvas;
  mesh.userData.ctx = ctx;
  mesh.userData.label = label;
  mesh.userData.baseScale = 1;

  paintMenuButtonCanvas(mesh, bgColor);
  return mesh;
}

function paintMenuButtonCanvas(button, bgColor) {
  const { canvas, ctx, label } = button.userData;
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 48px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, canvas.width / 2, canvas.height / 2);
  button.material.map.needsUpdate = true;
}

function createColorSwatch(hex, diameter) {
  const material = new THREE.MeshBasicMaterial({ color: hex });
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(diameter / 2, 16), material);
  mesh.userData.baseScale = 1;
  return mesh;
}

function updateVRMenuHighlight() {
  for (const button of vrMenuButtons) {
    const action = button.userData.action;
    if (action.startsWith('tool:')) {
      const isActive = action === 'tool:' + currentTool;
      paintMenuButtonCanvas(button, isActive ? '#3f88c5' : '#3a3a45');
    } else if (action.startsWith('color:')) {
      const isActive = action.slice(6).toLowerCase() === '#' + currentColor.getHexString();
      button.userData.baseScale = isActive ? 1.35 : 1;
    }
  }
  applyMenuButtonScales(); // sin esto el resaltado de "activo" no se vería hasta el próximo hover
}

// ---------------------------------------------------------------------------
// Multijugador (Fase 2): presencia compartida (cabeza + manos de cada
// usuario conectado a la misma sala). El servidor (server/realtime-server.js)
// solo retransmite - toda la interpretación pasa aquí.
// ---------------------------------------------------------------------------
function setupMultiplayer() {
  connectMultiplayerSocket();
}

function connectMultiplayerSocket() {
  const url = MULTIPLAYER_SERVER_URL + '?room=' + encodeURIComponent(MULTIPLAYER_ROOM);
  let socket;
  try {
    socket = new WebSocket(url);
  } catch (error) {
    console.warn('Multijugador no disponible (no se pudo crear el WebSocket):', error.message);
    return;
  }

  socket.addEventListener('open', () => {
    console.log('Multijugador: conectado a la sala "' + MULTIPLAYER_ROOM + '"');
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleMultiplayerMessage(message);
  });

  // El multijugador es un añadido, no debe bloquear nada si el servidor no
  // está corriendo (ej. todavía no desplegado - ver Fase 1 del plan):
  // reintento simple e indefinido cada 2s, sin afectar el resto de la app.
  socket.addEventListener('close', () => {
    multiplayerSocket = null;
    setTimeout(connectMultiplayerSocket, 2000);
  });
  socket.addEventListener('error', () => {}); // 'close' se dispara igual después; ahí se reintenta

  multiplayerSocket = socket;
}

function handleMultiplayerMessage(message) {
  if (message.type === 'welcome') {
    myPeerId = message.id;
  } else if (message.type === 'relay' && message.payload?.type === 'presence') {
    updatePeerPresence(message.from, message.payload);
  } else if (message.type === 'peer-left') {
    removePeerAvatar(message.id);
  } else if (message.type === 'piece-added') {
    addNetworkPiece(message);
    const finish = pendingPieceUploads.get(message.requestId);
    if (finish) finish(true);
  } else if (message.type === 'piece-list') {
    for (const piece of message.pieces) addNetworkPiece(piece);
  } else if (message.type === 'piece-transform') {
    applyNetworkTransform(message);
  } else if (message.type === 'piece-locked') {
    setNetworkLock(message.pieceId, message.by);
  } else if (message.type === 'piece-unlocked') {
    setNetworkLock(message.pieceId, null);
  }
}

// Sube un archivo STL al servidor en vez de colocarlo localmente - la pieza
// solo aparece en pantalla cuando llega la respuesta 'piece-added' (ver
// handleMultiplayerMessage), igual para quien la subió que para los demás,
// así todos quedan de acuerdo en dónde está. Con tiempo límite: si el
// servidor no responde, no deja la carga de archivos colgada para siempre.
function uploadPieceToServer(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const requestId = crypto.randomUUID();
      let settled = false;
      const timeoutId = setTimeout(() => {
        console.warn('Subida de "' + file.name + '" al servidor multijugador agotó el tiempo de espera.');
        finish(false);
      }, PIECE_UPLOAD_TIMEOUT_MS);

      function finish(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        pendingPieceUploads.delete(requestId);
        resolve(result);
      }

      pendingPieceUploads.set(requestId, finish);
      try {
        multiplayerSocket.send(JSON.stringify({
          type: 'add-piece',
          requestId,
          name: file.name.replace(/\.stl$/i, ''),
          fileBase64: arrayBufferToBase64(reader.result),
        }));
      } catch (error) {
        console.error('No se pudo enviar la pieza al servidor:', error.message);
        finish(false);
      }
    };
    reader.onerror = () => resolve(false);
    reader.readAsArrayBuffer(file);
  });
}

// Crea en la escena una pieza que llegó del servidor (recién agregada por
// alguien, o parte del historial de la sala al conectarse) - la posición la
// decide el slot que asignó el servidor, nunca un cálculo local. Si ya la
// habían movido antes de que esta pestaña se conectara, se usa esa posición
// guardada en vez del slot original (ver 'position' en el servidor).
function addNetworkPiece(piece) {
  if (networkPieceMeshes.has(piece.id)) return; // ya existe (ej. piece-list repetido tras reconectar)

  let geometry;
  try {
    geometry = new STLLoader().parse(base64ToArrayBuffer(piece.fileBase64));
  } catch (error) {
    console.error('No se pudo leer la pieza recibida de la red:', piece.name, error);
    return;
  }

  const mesh = buildPieceMesh(geometry, piece.name);
  if (piece.position) {
    mesh.position.fromArray(piece.position);
    mesh.quaternion.fromArray(piece.quaternion);
    mesh.scale.fromArray(piece.scale);
  } else {
    mesh.position.copy(MODEL_POSITION).add(pieceSlotOffset(piece.slot));
  }
  mesh.userData.networkId = piece.id;
  mesh.userData.networkLockedBy = piece.lockedBy || null;
  networkPieceMeshes.set(piece.id, mesh);
  addMesh(mesh);
}

// Aplica el transform final que otra persona le dio a una pieza de red -
// nunca se recibe de vuelta la propia (ver sendPieceTransform/el servidor).
function applyNetworkTransform(message) {
  const mesh = networkPieceMeshes.get(message.pieceId);
  if (!mesh) return;
  mesh.position.fromArray(message.position);
  mesh.quaternion.fromArray(message.quaternion);
  mesh.scale.fromArray(message.scale);
  if (selectedMesh === mesh && selectionHelper) selectionHelper.update();
}

function setNetworkLock(pieceId, byPeerId) {
  const mesh = networkPieceMeshes.get(pieceId);
  if (!mesh) return;
  mesh.userData.networkLockedBy = byPeerId;
  if (selectedMesh === mesh) syncTransformControls(); // suelta el gizmo si alguien más acaba de tomarla
  refreshPieceList();
}

// Las tres funciones de abajo son no-op silencioso si la pieza no es de red
// (sin networkId, ej. el modelo por defecto) o si no hay conexión activa -
// el bloqueo/transform en red es un AÑADIDO, nunca un requisito para poder
// editar localmente.
function lockNetworkPiece(mesh) {
  if (!mesh.userData.networkId || !multiplayerSocket || multiplayerSocket.readyState !== WebSocket.OPEN) return;
  multiplayerSocket.send(JSON.stringify({ type: 'lock-piece', pieceId: mesh.userData.networkId }));
}

function unlockNetworkPiece(mesh) {
  if (!mesh.userData.networkId || !multiplayerSocket || multiplayerSocket.readyState !== WebSocket.OPEN) return;
  multiplayerSocket.send(JSON.stringify({ type: 'unlock-piece', pieceId: mesh.userData.networkId }));
}

function sendPieceTransform(mesh, transform) {
  if (!mesh.userData.networkId || !multiplayerSocket || multiplayerSocket.readyState !== WebSocket.OPEN) return;
  multiplayerSocket.send(JSON.stringify({
    type: 'transform',
    pieceId: mesh.userData.networkId,
    position: transform.position.toArray(),
    quaternion: transform.quaternion.toArray(),
    scale: transform.scale.toArray(),
  }));
}

// atob/btoa trabajan con strings, no con bytes crudos - y pasar un
// Uint8Array grande entero a String.fromCharCode.apply revienta con
// "Maximum call stack size exceeded" (cada byte es un argumento de la
// llamada) - por eso se arma en trozos de 32KB.
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Manda la posición/orientación de cabeza (+ manos, si hay sesión XR activa)
// a los demás. Llamado cada frame desde render(), pero se autolimita a
// PRESENCE_SEND_INTERVAL_MS - no hace falta más frecuencia para que se vea
// fluido del otro lado gracias a la interpolación en updatePeerAvatars().
function sendPresence(time) {
  if (!multiplayerSocket || multiplayerSocket.readyState !== WebSocket.OPEN) return;
  if (time - lastPresenceSendTime < PRESENCE_SEND_INTERVAL_MS) return;
  lastPresenceSendTime = time;

  const presence = {
    type: 'presence',
    head: { position: camera.position.toArray(), quaternion: camera.quaternion.toArray() },
    left: null,
    right: null,
  };

  if (renderer.xr.isPresenting) {
    const leftController = controllers.find((c) => c.userData.handedness === 'left');
    const rightController = controllers.find((c) => c.userData.handedness === 'right');
    if (leftController) presence.left = controllerPose(leftController);
    if (rightController) presence.right = controllerPose(rightController);
  }

  multiplayerSocket.send(JSON.stringify(presence));
}

function controllerPose(controller) {
  _controllerPos.setFromMatrixPosition(controller.matrixWorld);
  return { position: _controllerPos.toArray(), quaternion: controller.quaternion.toArray() };
}

function updatePeerPresence(peerId, presence) {
  let avatar = peerAvatars.get(peerId);
  if (!avatar) {
    avatar = createPeerAvatar();
    peerAvatars.set(peerId, avatar);
  }

  avatar.targetHead.position.fromArray(presence.head.position);
  avatar.targetHead.quaternion.fromArray(presence.head.quaternion);

  avatar.hasLeft = !!presence.left;
  if (presence.left) {
    avatar.targetLeft.position.fromArray(presence.left.position);
    avatar.targetLeft.quaternion.fromArray(presence.left.quaternion);
  }
  avatar.left.visible = avatar.hasLeft;

  avatar.hasRight = !!presence.right;
  if (presence.right) {
    avatar.targetRight.position.fromArray(presence.right.position);
    avatar.targetRight.quaternion.fromArray(presence.right.quaternion);
  }
  avatar.right.visible = avatar.hasRight;
}

// Representación mínima de otro usuario: una esfera para la cabeza y dos más
// chicas para las manos (ocultas hasta que ese usuario entre en VR y reporte
// datos de control/mano). Material propio por avatar (no compartido entre
// usuarios) para poder liberarlo de forma segura en removePeerAvatar sin
// afectar los avatares de los demás.
function createPeerAvatar() {
  const material = new THREE.MeshBasicMaterial({ color: 0x7fd1ff, transparent: true, opacity: 0.75 });
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), material);
  const left = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), material);
  const right = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), material);
  left.visible = false;
  right.visible = false;

  const group = new THREE.Group();
  group.add(head, left, right);
  scene.add(group);

  return {
    group,
    head,
    left,
    right,
    targetHead: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
    targetLeft: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
    targetRight: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
    hasLeft: false,
    hasRight: false,
  };
}

function removePeerAvatar(peerId) {
  const avatar = peerAvatars.get(peerId);
  if (!avatar) return;
  scene.remove(avatar.group);
  avatar.head.geometry.dispose();
  avatar.left.geometry.dispose();
  avatar.right.geometry.dispose();
  avatar.head.material.dispose(); // compartido por los 3 meshes de ESTE avatar, basta una vez
  peerAvatars.delete(peerId);
}

// Suaviza cada avatar hacia el último dato recibido (en vez de "saltar" a la
// nueva posición) para disimular el jitter de red - llamado cada frame.
function updatePeerAvatars(deltaSeconds) {
  if (peerAvatars.size === 0) return;
  const lerpFactor = Math.min(1, PEER_AVATAR_LERP_SPEED * deltaSeconds);
  for (const avatar of peerAvatars.values()) {
    avatar.head.position.lerp(avatar.targetHead.position, lerpFactor);
    avatar.head.quaternion.slerp(avatar.targetHead.quaternion, lerpFactor);
    if (avatar.hasLeft) {
      avatar.left.position.lerp(avatar.targetLeft.position, lerpFactor);
      avatar.left.quaternion.slerp(avatar.targetLeft.quaternion, lerpFactor);
    }
    if (avatar.hasRight) {
      avatar.right.position.lerp(avatar.targetRight.position, lerpFactor);
      avatar.right.quaternion.slerp(avatar.targetRight.quaternion, lerpFactor);
    }
  }
}


