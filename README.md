# PaintSTL — Escultura de modelos STL en VR (Oculus Quest 2)

Aplicación WebXR + Three.js para afinar y esculpir archivos STL directamente
en realidad virtual, usando los controladores de Oculus Quest 2.

## Estructura

```
index.html   → página y import map (Three.js se carga desde CDN, sin npm install)
app.js       → escena, carga del STL, controladores WebXR y lógica de esculpido
server.js    → servidor estático en Node.js (sin dependencias)
models/default.stl          → modelo STL por defecto (esfera procedural)
scripts/generate-default-stl.js → script que generó ese STL (opcional, regenerable)
```

## Cómo ejecutarlo

Con Node.js instalado:

```bash
npm start
```

o directamente:

```bash
node server.js
```

También puedes usar Python si lo prefieres:

```bash
python -m http.server 8000
```

La consola mostrará algo como:

```
Local:    http://localhost:8000
Red LAN:  http://192.168.1.12:8000  <- usa esta URL en el navegador del Quest 2
```

## Probarlo en el navegador de escritorio

Abre `http://localhost:8000`. La versión de escritorio es independiente de la
de Oculus: puedes esculpir el modelo con el ratón sin necesidad de ponerte el
headset (ver controles abajo).

## Probarlo en el Oculus Quest 2 (importante)

WebXR solo funciona en un "contexto seguro": HTTPS, o `http://localhost`.
Como el Quest 2 es un dispositivo aparte que accede por la red local
(`http://<IP-de-tu-PC>:8000`), ese origen **no** se considera seguro por
defecto y el botón "ENTER VR" no aparecerá. Para habilitarlo:

1. En el navegador del Quest 2, ve a `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.
2. Añade la URL "Red LAN" que imprime el servidor (ej. `http://192.168.1.12:8000`).
3. Habilita el flag y reinicia el navegador.
4. Entra a esa misma URL y pulsa "ENTER VR".

Alternativa sin tocar flags: exponer el servidor local vía un túnel HTTPS
(por ejemplo ngrok) y usar esa URL `https://...` en el Quest.

## Herramientas

## Pintado rápido (varita mágica)

Es una forma de pintar regiones enteras de un solo toque, en vez de pasar el
pincel vértice a vértice. Al tocar un punto de la pieza (p. ej. un ojo, o
cualquier zona con un borde o arista cerca), la herramienta:

1. Mira la cara (triángulo) exacta que tocaste.
2. Va expandiendo la selección hacia las caras vecinas mientras su normal
   (hacia dónde "miran") sea parecida a la de la cara anterior.
3. Se detiene sola al llegar a un borde/arista marcada, donde la normal
   cambia de golpe — ahí termina la selección.
4. Pinta de inmediato todas las caras seleccionadas con el color elegido en
   la paleta.

El control **"Precisión"** (grados) ajusta qué tan distinta puede ser la
normal entre dos caras vecinas para seguir considerándolas "la misma
 superficie": con un valor bajo (p. ej. 5°) solo avanza por zonas casi
perfectamente planas; con uno alto (p. ej. 45°) sigue superficies más
curvas/abultadas antes de detenerse. Puedes mantener pulsado y arrastrar
para pintar varias regiones similares en un solo gesto (cada una se rellena
la primera vez que el puntero la toca; pasar de nuevo por una zona ya
pintada en el mismo trazo no hace nada extra). Todo el trazo (una o varias
regiones) es un solo paso para "Deshacer".

En un modelo totalmente liso y sin aristas (como la esfera de ejemplo) no
hay ningún borde que detenga la selección, así que un solo toque pinta la
pieza entera — es el comportamiento correcto, no un error: esta
herramienta brilla en modelos con bordes/esquinas reales (caras, piezas
mecánicas con facetas, letras, etc.), donde cada región queda limitada de
forma natural.

Disponible también en VR (botón "Rápido" del menú de la mano izquierda);
la precisión se comparte con la de escritorio (no hay control deslizante
dentro del visor todavía, se ajusta desde la barra de escritorio).

## Precisión del pincel (Esculpir / Pintar)

El mismo control **"Precisión"** de la barra de herramientas sirve para otra
cosa al usar "Esculpir" o "Pintar": en vez de un ángulo, ajusta el **ancho
del pincel** (de 1 a 15 cm) — el radio de influencia alrededor del punto
señalado que ya usaban ambas herramientas, antes fijo y ahora regulable en
vivo.

Mientras apuntas con cualquiera de las dos herramientas (sin necesidad de
hacer clic todavía), aparece una **sombra semitransparente** apoyada sobre
la superficie señalada, del tamaño exacto del pincel — así se ve de
antemano exactamente qué zona se va a ver afectada antes de "disparar"
(clic en escritorio, gatillo en VR). La sombra desaparece al cambiar a
cualquier otra herramienta.

Hay seis herramientas, seleccionables con un botón (igual en escritorio y VR,
salvo "Escalar" que en VR se maneja desde los botones +/- del menú en vez de
con una herramienta aparte):

- **Esculpir:** empuja los vértices hacia afuera a lo largo de su normal,
  dentro del radio de influencia del pincel (ver "Precisión del pincel" más
  abajo) alrededor del punto señalado.
- **Pintar:** mezcla el color elegido en la paleta sobre los vértices dentro
  de ese mismo radio (la malla usa color por vértice, así que se puede
  pintar y seguir esculpiendo sin perder nada).
- **Pintado rápido:** toca una parte (p. ej. un ojo) y pinta de una vez toda
  la superficie similar de alrededor, deteniéndose sola en el borde/arista
  más cercano (ver sección propia más abajo).
- **Mover / Rotar / Escalar:** control de transformación al estilo Unity (ver
  siguiente sección).
- **Libre:** combina mover + rotar + escalar a la vez, como el "Transform
  Tool" de Unity (ver siguiente sección).

Un clic (o el gatillo en VR), con cualquier herramienta, también selecciona
la pieza apuntada — o puedes seleccionarla directamente en la **lista de
piezas** de la barra de herramientas (ver más abajo). Esa es la pieza sobre
la que actúan los botones de tamaño, y solo al seleccionarla aparecen sus
gizmos (se resalta además con un contorno amarillo en la escena).

## Control de transformación al estilo Unity (Mover / Rotar / Escalar)

En escritorio, estas tres herramientas muestran un **gizmo 3D** sobre la
pieza seleccionada — las mismas flechas/anillos/cubos de ejes con colores
por eje (rojo=X, verde=Y, azul=Z) que el Move/Rotate/Scale Tool de Unity.
Arrastra un eje para transformar solo en esa dirección, o el centro para
hacerlo libremente/de forma uniforme. Mientras se arrastra el gizmo, la
órbita de cámara se pausa automáticamente para que no compitan.

**Atajos de teclado (idénticos a Unity):** `W` Mover · `E` Rotar · `R` Escalar · `Y` Libre.

En VR no hay forma natural de arrastrar un gizmo 2D con un controlador
apuntando en 3D, así que cada herramienta se adapta a una interacción más
propia de VR:

- **Mover:** igual que antes — sujeta el gatillo sobre la pieza y arrastra la
  mano; la pieza sigue al controlador.
- **Rotar:** sujeta el gatillo sobre la pieza y gira la muñeca — la pieza
  rota exactamente lo mismo que el controlador desde que la agarraste
  ("agarrar y girar", como mover un objeto real).
- **Escalar:** no es una herramienta con gatillo; se controla con los
  botones +/- del menú de la mano izquierda, igual que en escritorio.

## Libre: mover + rotar + escalar a la vez

"Libre" (atajo `Y`) es el equivalente al **Transform Tool** combinado de
Unity: deja transformar una pieza de cualquiera de las tres formas sin tener
que cambiar de herramienta cada vez.

En **escritorio** se muestran los tres gizmos encima de la pieza a la vez,
cada uno a un radio distinto para que no se tapen visualmente — escalar por
dentro, mover en el medio, rotar por fuera (como en la imagen del Transform
Tool de Unity). Sus zonas de clic invisibles sí se solapan un poco cerca del
centro (es una limitación de cómo están construidos estos gizmos), así que la
aplicación arbitra automáticamente cuál de los tres "gana" un clic ambiguo,
dando prioridad al asa más pequeña/específica (escalar > mover > rotar) —en
la práctica, arrastrar cualquiera de los tres solo mueve/rota/escala, nunca
más de una cosa a la vez.

En **VR** no existen gizmos; "Libre" sujeta el gatillo sobre la pieza y mueve
y rota al mismo tiempo mientras mantienes la mano cerrada (combina los
gestos de "Mover" y "Rotar" en un solo agarre, igual que sujetar un objeto
real con la mano). El tamaño no cambia con "Libre" en VR; usa los botones
+/- del menú para eso, igual que con las otras herramientas.

## Varias piezas STL a la vez

Un modelo que viene repartido en varias piezas se puede montar completo:
cada vez que cargas uno o varios archivos con **"Cargar STL"** (o una
carpeta entera con **"📁 Cargar carpeta"**, ver sección siguiente) se
añaden como piezas independientes (no reemplazan a las anteriores),
separadas un poco entre sí para que sea fácil distinguirlas y agarrarlas.

## Lista de objetos importados (ver, bloquear, borrar)

La barra de herramientas incluye una lista con **todas** las piezas
cargadas ("Pieza 1", "Pieza 2", ...). Haz clic en cualquier parte de una
fila para seleccionar esa pieza — es el equivalente, desde la lista, a
apuntarla y hacer clic en la escena; **solo al seleccionarla así aparecen
sus gizmos** de Mover/Rotar/Escalar/Libre. Cada fila tiene tres botones
propios:

- **👁️ Ver/ocultar:** oculta la pieza por completo (deja de renderizarse y
  deja de poder seleccionarse o verse afectada por cualquier herramienta —
  esculpir, pintar, mover, rotar, escalar — mientras esté oculta). Si la
  pieza oculta era la seleccionada, se deselecciona (su gizmo y su contorno
  amarillo desaparecen con ella). Vuelve a pulsar el ojo para mostrarla de
  nuevo; no queda seleccionada automáticamente, haz clic en la fila para
  retomarla.
- **🔓/🔒 Bloquear/desbloquear:** una pieza bloqueada no se puede mover,
  rotar, escalar, esculpir ni pintar (un único bloqueo por pieza, ya no hay
  bloqueos separados por tipo de cambio). Al bloquear la pieza seleccionada
  sus gizmos desaparecen de inmediato. Una pieza bloqueada "deja pasar" el
  rayo/clic hacia lo que haya detrás en vez de bloquear también esa otra
  pieza, y sigue pudiéndose seleccionar (para poder desbloquearla).
- **🗑️ Borrar:** elimina esa pieza (pide confirmación). Se puede deshacer
  con Ctrl+Z o el botón "↶ Deshacer" (ver sección "Deshacer cambios" más
  abajo).

Ni el bloqueo ni el estado oculto/visible se guardan al recargar la página
(solo duran la sesión actual). Por ahora la lista solo existe en la barra de
escritorio: en VR puedes seleccionar/usar las piezas con el gatillo y se
respeta cualquier bloqueo u ocultamiento ya aplicado desde escritorio, pero
no hay forma de cambiarlos desde el propio visor todavía.

## Controles en VR (Oculus Quest 2)

- **Gatillo derecho (mantener presionado):** usa la herramienta activa y
  selecciona la pieza apuntada (esculpir/pintar funcionan como pincel;
  mover/rotar/libre siguen a la mano mientras se mantiene presionado).
- **Grip derecho (mantener) + gatillo:** con "Esculpir", invierte la
  dirección y hunde la malla en vez de inflarla. (Solo con mando físico; no
  disponible usando las manos sin controles, ver más abajo.)
- **Menú (mano izquierda):** panel 3D con los 6 botones de herramienta
  (Esculpir/Pintar/Rápido/Mover/Rotar/Libre), la paleta de colores, dos
  botones +/- que cambian el tamaño de la pieza seleccionada, y un botón
  "Deshacer" (no hay cámara controlable por software en VR: la sigue el
  propio headset). Apúntalo y pulsa el gatillo derecho para usarlo, igual
  que con las piezas.
- **Controlador izquierdo:** sostiene el menú; sin otra función asignada.
- **Mira de precisión:** un punto amarillo marca exactamente dónde cae el
  rayo del control derecho (sobre un botón del menú o sobre una pieza),
  antes de disparar el gatillo. El botón del menú señalado se agranda
  levemente y el control vibra un poco (háptica) al pasar sobre uno nuevo,
  y vibra más fuerte al confirmarlo con el gatillo.
- **Manos sin control (hand tracking):** si sueltas los controles físicos,
  el Quest 2 detecta tus manos automáticamente (sin activar nada aparte de
  tener la función habilitada por el sistema) y se ve un modelo 3D de la
  mano. El gesto de "pellizco" (pulgar + índice) hace de gatillo: sirve para
  esculpir, pintar, pintado rápido, mover, rotar y seleccionar piezas/menú,
  igual que con el mando físico. Limitación conocida: sin grip físico no hay
  forma de invertir la dirección al esculpir (siempre infla, nunca hunde) ni
  de usar "Libre" tan cómodamente como con mando - usa un mando físico para
  esas dos cosas si las necesitas.

### Gestos con manos (solo hand tracking, sin mando físico)

- **Mano izquierda: agarrar y rotar directamente.** Con una pieza
  seleccionada, pellizca con la mano izquierda en cualquier momento (sin
  pasar por el menú ni cambiar de herramienta) y gírala como si sujetaras el
  objeto real; suelta el pellizco para terminar. Funciona a la vez que la
  mano derecha usa cualquier otra herramienta (esculpir, pintar, etc.) -
  pensado para sujetar la pieza con una mano mientras se trabaja con la otra.
- **Pellizco con ambas manos a la vez: zoom.** Con una pieza seleccionada,
  pellizca con las DOS manos y acércalas/aléjalas entre sí para achicar/
  agrandar la pieza (como el gesto de "pellizcar para zoom" de una pantalla
  táctil, pero con las dos manos en vez de dos dedos).
- **Ambas palmas hacia arriba (sostenido ~0.5s): abre/cierra un menú
  flotante** independiente del panel de la muñeca - aparece "flotando" frente
  a ti la primera vez, y se puede **reubicar manualmente**: pellizca cerca de
  la franja azul de arriba (con cualquier mano) y arrástralo a donde quieras,
  suelta para soltarlo. Útil si prefieres el menú en un punto fijo del
  espacio en vez de pegado a la muñeca.
  - Nota: la detección de "palma hacia arriba" es nueva y puede necesitar
    ajuste fino (ángulo/mano) según cómo responda en la práctica - avisa si
    el gesto no se dispara, o se dispara con las palmas hacia abajo en vez
    de hacia arriba.

## Controles en escritorio (ratón)

Versión aparte de la de Oculus, con una barra de herramientas en pantalla:

- **Clic izquierdo (mantener):** usa la herramienta activa (esculpir, pintar,
  o el gizmo de mover/rotar/escalar) y selecciona la pieza apuntada.
- **Shift + clic izquierdo (mantener):** con "Esculpir", hunde la malla en
  vez de inflarla.
- **W / E / R / Y:** atajos de teclado para Mover / Rotar / Escalar / Libre
  (como en Unity).
- **F:** encuadra la cámara en la pieza seleccionada (ver "Navegación de
  cámara" más abajo).
- **Ctrl+Z (o Cmd+Z en Mac):** deshace el último cambio (ver siguiente sección).
- **Botones +/- ("Tamaño de la pieza"):** agrandan/encogen la pieza
  seleccionada, alternativa rápida al gizmo de escalar. La rueda del ratón
  sigue haciendo zoom de cámara aparte.
- **Paleta de colores:** aparece al elegir "Pintar"; incluye 8 colores y un
  selector de color personalizado.

## Navegación de cámara (estilo Unity)

El clic izquierdo queda reservado para las herramientas, así que la cámara
se controla con el resto de botones y combinaciones, calcadas del esquema
de Unity (Alt+clic, clic central, etc.) en la medida en que tienen sentido
fuera del editor de Unity:

| Gesto | Acción |
| --- | --- |
| **Clic derecho + arrastrar** | **Paneo** — la cámara y el punto de referencia se desplazan juntos, sin rotar. |
| **Shift (o Ctrl/Cmd) + clic derecho + arrastrar** | **Órbita** alrededor del punto de referencia. |
| **Alt + clic izquierdo + arrastrar** | **Órbita**, igual que "Alt+clic izquierdo" en Unity — sin soltar la herramienta activa (puedes seguir esculpiendo/pintando justo después, sin cambiar de modo). |
| **Alt + clic derecho + arrastrar** | **Zoom**, igual que "Alt+clic derecho" en Unity. |
| **Clic central + arrastrar** | **Paneo** — atajo "funciona siempre", igual que el botón central en Unity. |
| **Rueda del ratón** | **Zoom** (independiente de todo lo anterior). |
| **F** | **Encuadrar** la pieza seleccionada: centra el punto de referencia en ella y ajusta la distancia para que quepa completa, conservando el ángulo de vista actual (como "Edit > Frame Selected" / tecla F en Unity). |

Por qué el mapeo no es 100% idéntico al de Unity: por defecto, Unity usa el
**clic derecho solo** para mirar alrededor en primera persona y volar con
WASDQE mientras se mantiene presionado ("Flythrough mode") — pero W/E/R ya
están ocupados aquí como atajos de Mover/Rotar/Escalar, así que ese modo no
se implementó (entraría en conflicto directo). En su lugar, el clic derecho
solo hace **paneo**, un gesto igual de útil y sin conflictos de teclado.
Tampoco se implementó "Shift+F" (bloquear la vista para seguir a la pieza
seleccionada aunque se mueva) ni las teclas de flecha para "caminar" por la
escena — ambas existen en Unity pero no se consideraron esenciales para
esta app.

## Deshacer cambios (Ctrl+Z)

La aplicación guarda un historial de hasta 30 acciones, deshacibles con
**Ctrl+Z**, el botón **"↶ Deshacer"** de la barra de herramientas, o el botón
"Deshacer" del menú de VR. Cada pulsación revierte un paso:

- **Esculpir / Pintar / Pintado rápido:** cada trazo de pincel completo
  (desde que se presiona el gatillo/clic hasta que se suelta) es un paso,
  aunque de en medio haya rellenado varias regiones con "Pintado rápido";
  deshacerlo restaura las posiciones o colores de los vértices a como
  estaban antes de ese trazo.
- **Mover / Rotar / Escalar / Libre:** cada arrastre del gizmo (o cada
  "agarre" completo en VR) es un paso; deshacerlo restaura la posición,
  rotación y escala previas de la pieza.
- **Borrar pieza:** también es deshacible; la pieza reaparece en la escena,
  en la lista de piezas y vuelve a quedar seleccionada.

Lo que **no** se puede deshacer: cargar una pieza nueva con "Cargar STL",
bloquear/desbloquear una pieza, ni ocultarla/mostrarla. El botón de deshacer
aparece deshabilitado cuando no hay ningún cambio pendiente de revertir.

## Cargar y posicionar tus propios STL

El botón **"Cargar STL"** de la barra de herramientas abre un selector de
archivos locales (no requiere servidor adicional) y permite elegir **uno o
varios archivos a la vez** (Ctrl/Cmd+clic o Shift+clic en el selector). El
botón **"📁 Cargar carpeta"** hace lo mismo pero con una carpeta entera:
carga automáticamente **todos** los archivos `.stl` que encuentre dentro,
incluidas las subcarpetas — cualquier otro tipo de archivo que haya mezclado
ahí se ignora en silencio. Útil para montar de una sola vez un modelo que
viene repartido en muchas piezas (p. ej. una carpeta con "ojo_izquierdo.stl",
"ojo_derecho.stl", "nariz.stl", ...).

Al cargar, cada archivo:

1. Se añade como pieza nueva (las que ya había cargadas se conservan), con
   el nombre tomado del propio archivo (sin la extensión `.stl`) en vez del
   genérico "Pieza N" — más fácil de identificar en la lista cuando cargas
   varias a la vez. Se centra/reescala automáticamente para verse cómoda en
   la escena, sin importar en qué unidades (mm, cm, in) fue exportada.
2. Si se cargaron varios archivos (o una carpeta) de una vez, se procesan
   en secuencia y recién al terminar todos la herramienta cambia sola a
   "Mover", con la última pieza cargada seleccionada — así puedes
   arrastrarlas a la posición que prefieras antes de esculpir o pintar.

Si ningún archivo de la selección/carpeta es un `.stl` válido, se avisa con
un mensaje en vez de no hacer nada visible; si algunos fallan al leerse (p.
ej. un STL corrupto) entre varios que sí cargaron bien, se avisa cuántos de
cuántos se cargaron correctamente.

Esta carga de archivos es solo de escritorio (abrir un selector de archivos
no es práctico dentro de una sesión de VR inmersiva); una vez posicionadas,
las piezas son las mismas que verás al entrar en VR, y la herramienta "Mover"
también funciona allí para reajustarlas.

## Cambiar el modelo por defecto (sin usar el botón de carga)

Sustituye `models/default.stl` por cualquier otro archivo STL (binario o
ASCII) y recarga la página. Para regenerar la esfera de ejemplo:

```bash
npm run generate-default-stl
```
