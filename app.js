'use strict';

const { solids, makeNet, dot, sub, cross, rotate, unit, mean, bounds, edgeKey, pairs, clamp } = Geometry;
const byId = id => document.getElementById(id);
const ui = {
  shape: byId('shape'), type: byId('net-type'), picker: byId('net-picker'),
  observe: byId('observe'), net: byId('net'), showObserve: byId('show-observe'), showNet: byId('show-net'),
  solid: byId('solid-view'), sketch: byId('sketch-view'), fold: byId('fold-view'), preview: byId('net-preview'),
  hiddenEdges: byId('hidden-edges'), resetView: byId('reset-view'), fullscreen: byId('fullscreen'),
  resetNet: byId('reset-net'), resetNetView: byId('reset-net-view'), next: byId('net-next'), previewBlock: byId('preview-block'),
  status: byId('fold-status'), progress: byId('fold-progress'), hint: byId('net-hint'),
};
const nextLabel = ui.next.querySelector('span');

const AXIS_X = [1, 0, 0], AXIS_Y = [0, 1, 0], AXIS_Z = [0, 0, 1];
const INK = '#192846', HIDDEN = '#536685', BLUE = '#002fa7';
const BOX_CAMERA = [0.46, -1, 0.38];
const faceFrames = new Map([solids.tetra, solids.octa, solids.dodeca, solids.icosa].map(solid => {
  const { ids, normal } = solid.faces[0];
  const center = mean(ids.map(id => solid.vertices[id]));
  const up = unit(sub(solid.vertices[ids[0]], center));
  const right = cross(up, normal);
  return [solid, point => [dot(point, right), dot(point, up), dot(point, normal)]];
}));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const selectedTypes = new Map();
let mode = 'observe', shape = solids[ui.shape.value];
let yaw = 0, pitch = 0;
let net, amounts, foldedCount, unfolding, movingFace = null;
let hitPolygons = [], hovered = false, animationId = 0, renderId = 0;
let netViewOffset = [0, 0], renderedNetAngles = [0, 0], manualNetAngles = null;

function prepare(canvas) {
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return null;
  const ratio = Math.min(devicePixelRatio || 1, 3);
  const pixels = [Math.round(width * ratio), Math.round(height * ratio)];
  if (canvas.width !== pixels[0]) canvas.width = pixels[0];
  if (canvas.height !== pixels[1]) canvas.height = pixels[1];
  const ctx = canvas.getContext('2d');
  ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  return { ctx, width, height };
}

function line(ctx, a, b, color, width, dash = []) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
}

function fill(ctx, points, color) {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (const point of points.slice(1)) ctx.lineTo(point[0], point[1]);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function screenMapper(polygons, width, height, padding, shift, maxScale = Infinity) {
  const { left, right, bottom, top } = bounds(polygons);
  const scale = Math.min((width - padding * 2) / (right - left), (height - padding * 2) / (top - bottom), maxScale);
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  return ([x, y]) => [width / 2 + (x - centerX) * scale, height / 2 + shift - (y - centerY) * scale];
}

function observationView() {
  const faceFrame = faceFrames.get(shape);
  if (faceFrame) {
    return {
      rotatePoint: point => rotate(rotate(faceFrame(point), AXIS_Y, yaw), AXIS_X, pitch),
      project: ([x, y]) => [x, y],
      camera: AXIS_Z,
      light: [-0.35, 0.62, 0.68],
    };
  }
  return {
    rotatePoint: point => rotate(rotate(point, AXIS_Z, yaw), AXIS_X, pitch),
    project: ([x, y, z]) => [x + BOX_CAMERA[0] * y, z + BOX_CAMERA[2] * y],
    camera: BOX_CAMERA,
    light: [0.18, -0.34, 0.92],
  };
}

function drawObservation(canvas, isSketch) {
  const surface = prepare(canvas);
  if (!surface) return;
  const { ctx, width, height } = surface;
  const { rotatePoint, project, camera, light } = observationView();
  const coordinates = shape.vertices.map(point => project(rotatePoint(point)));
  const maxDiameter = Math.max(...shape.vertices.map(point => Math.hypot(...point))) * 2;
  const margin = Math.max(15, Math.min(width, height) * 0.13);
  const fit = screenMapper([coordinates], width, height, margin, 10, Math.min(width, height) * 0.76 / maxDiameter);
  const projected = coordinates.map(fit);
  const normals = shape.faces.map(face => rotatePoint(face.normal));
  const facing = normals.map(normal => dot(normal, camera) > 1e-7);
  const visible = edge => edge.faces.some(i => facing[i]);

  if (!isSketch) {
    shape.faces.forEach((face, i) => {
      if (!facing[i]) return;
      const brightness = clamp(dot(normals[i], light), -0.9, 1);
      fill(ctx, face.ids.map(id => projected[id]), `hsl(220 82% ${clamp(68 + 23 * brightness, 43, 91)}%)`);
    });
  }
  if (isSketch && ui.hiddenEdges.checked) {
    shape.edges.filter(edge => !visible(edge)).forEach(({ a, b }) => line(ctx, projected[a], projected[b], HIDDEN, 1.8, [5, 6]));
  }
  shape.edges.filter(visible).forEach(({ a, b }) => line(ctx, projected[a], projected[b], INK, isSketch ? 2.4 : 2.1));
}

function nextFace() {
  return net.foldOrder[unfolding ? foldedCount - 1 : foldedCount] ?? null;
}

function polygonAt(faces, x, y) {
  for (let index = faces.length - 1; index >= 0; index--) {
    const { i, points } = faces[index];
    let inside = false;
    for (const [[ax, ay], [bx, by]] of pairs(points)) {
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    }
    if (inside) return i;
  }
  return null;
}

function reachableFace(faces, target) {
  const { points } = faces.find(face => face.i === target);
  const center = mean(points);
  const samples = [center, ...points.map(point => mean([point, center]))];
  return samples.some(([x, y]) => [[x, y], [x - 3, y], [x + 3, y], [x, y - 3], [x, y + 3]]
    .every(([px, py]) => polygonAt(faces, px, py) === target));
}

function drawNet(canvas, preview = false) {
  const surface = prepare(canvas);
  if (!surface || !net) return;
  const { ctx, width, height } = surface;
  const total = net.foldOrder.length;
  const remaining = net.foldOrder.reduce((sum, i) => sum + amounts[i], 0);
  const fraction = 1 - remaining / total;
  const closed = !preview && remaining < 1e-6;
  const flat = preview || fraction < 1e-6;
  const view = ui.fold.getBoundingClientRect();
  const flatBounds = bounds(net.flat);
  const flatWidth = flatBounds.right - flatBounds.left;
  const flatHeight = flatBounds.top - flatBounds.bottom;
  const wider = view.width > view.height;
  const turn = (flatHeight > flatWidth && wider) || (flatWidth > flatHeight && !wider);
  const tilt = preview ? 0 : Math.min(1, fraction * 4) * (0.42 + fraction * 0.28);
  const model = flat ? net.flat : net.polygons(amounts);
  const padding = preview ? 7 : Math.min(62, Math.max(23, Math.min(width, height) * 0.125));
  const maxDiameter = Math.max(...shape.vertices.map(point => Math.hypot(...point))) * 2;
  const scaleLimit = preview ? Infinity : Math.min(width, height) * (0.68 + 0.09 * fraction) / maxDiameter;
  const highlight = movingFace ?? (unfolding ? null : nextFace());
  function projectedFaces([pitchAngle, yawAngle]) {
    const polygons = model.map(face => face.map(point => {
      const aligned = turn ? [-point[1], point[0], point[2]] : point;
      return rotate(rotate(aligned, AXIS_X, pitchAngle), AXIS_Y, yawAngle);
    }));
    const fit = screenMapper(polygons, width, height, padding, preview ? 0 : 22, scaleLimit);
    return polygons.map((poly, i) => ({ i, points: poly.map(fit), depth: mean(poly)[2], normal: cross(sub(poly[1], poly[0]), sub(poly[2], poly[0])) }))
      .filter(face => !closed || face.normal[2] > 1e-7).sort((a, b) => a.depth - b.depth);
  }

  const offset = preview || flat ? [0, 0] : netViewOffset;
  const autoAngles = ([dp, dy]) => [-tilt + dp, -0.67 * tilt + dy];
  let angles = preview ? [0, 0] : manualNetAngles ?? autoAngles(offset);
  let shown = projectedFaces(angles);
  if (!flat && !manualNetAngles && movingFace === null && highlight !== null && !reachableFace(shown, highlight)) {
    // Keep the next panel in reach when a previously folded face covers it.
    const alternatives = [0.35, 0.7, 1.1, 1.65].flatMap(distance => [
      [distance, 0], [-distance, 0], [0, distance], [0, -distance],
      [distance, distance], [-distance, distance], [distance, -distance], [-distance, -distance],
    ]);
    for (const candidate of alternatives) {
      const adjustedAngles = autoAngles(candidate);
      const adjusted = projectedFaces(adjustedAngles);
      if (!reachableFace(adjusted, highlight)) continue;
      shown = adjusted;
      angles = adjustedAngles;
      netViewOffset = candidate;
      break;
    }
  }

  for (const face of shown) {
    const { i, points, normal } = face;
    const color = i === highlight ? (hovered && !preview ? '#3467e5' : '#4d78e8') :
      flat ? (i === net.root ? '#c5d6fc' : '#e7efff') :
        `hsl(220 79% ${clamp(79 + 13 * normal[2] / Math.hypot(...normal), 66, 93)}%)`;
    fill(ctx, points, color);
    if (flat) continue;
    pairs(shape.faces[i].ids).forEach(([a, b], j) => {
      const hingeFace = net.creaseFaces.get(edgeKey(a, b));
      const dashed = hingeFace !== undefined && amounts[hingeFace] > 0.999;
      line(ctx, points[j], points[(j + 1) % points.length], i === highlight ? BLUE : INK, i === highlight ? 2.3 : 1.6, dashed ? [5, 5] : []);
    });
  }

  if (flat) {
    const drawn = new Set();
    shown.forEach(({ i, points }) => pairs(shape.faces[i].ids).forEach(([a, b], j) => {
      const edge = edgeKey(a, b);
      const crease = net.creaseFaces.has(edge);
      if (crease && drawn.has(edge)) return;
      if (crease) drawn.add(edge);
      const dash = crease ? (preview ? [3, 3] : [6, 5]) : [];
      line(ctx, points[j], points[(j + 1) % points.length], crease ? '#485e8d' : INK, preview ? 1.1 : 2, dash);
    }));
  }
  if (!preview) {
    hitPolygons = shown;
    renderedNetAngles = angles;
  }
}

function draw() {
  renderId = 0;
  if (mode === 'observe') {
    drawObservation(ui.solid, false);
    drawObservation(ui.sketch, true);
  } else {
    drawNet(ui.fold);
    drawNet(ui.preview, true);
  }
}

function scheduleDraw() {
  if (!renderId) renderId = requestAnimationFrame(draw);
}

function setInitialAngle() {
  yaw = 0;
  // A slight tilt reveals a second face of the tetrahedron.
  pitch = shape === solids.tetra ? -28 * Math.PI / 180 : 0;
  scheduleDraw();
}

function updateShape() {
  shape = solids[ui.shape.value];
  byId('shape-name').textContent = shape.name;
  byId('face-count').textContent = shape.faces.length;
  byId('edge-count').textContent = shape.edges.length;
  byId('vertex-count').textContent = shape.vertices.length;
  ui.solid.setAttribute('aria-label', `${shape.name} 입체 모형`);
  ui.sketch.setAttribute('aria-label', `${shape.name}의 겨냥도`);
  ui.fold.setAttribute('aria-label', `${shape.name}의 면을 차례대로 펼치고 접는 그림`);
  const recipes = NET_RECIPES[ui.shape.value];
  ui.type.replaceChildren(...recipes.map((_, i) => new Option(`유형 ${i + 1}`, i)));
  ui.type.value = selectedTypes.get(ui.shape.value) ?? 0;
  setInitialAngle();
}

function syncNetControls() {
  const total = net.foldOrder.length;
  const busy = movingFace !== null;
  const atStart = unfolding && foldedCount === total;
  const flat = !unfolding && foldedCount === 0 && !busy;
  const complete = !unfolding && foldedCount === total;
  const count = unfolding ? total - foldedCount : foldedCount;
  ui.progress.max = total;
  ui.progress.value = flat ? total : count;
  ui.progress.setAttribute('aria-label', unfolding || flat ? '펼치기 진행' : '접기 진행');
  const status = flat ? '전개도 완성!' : complete ? `${shape.name} 완성!` : `${total}개 중 ${count}개 ${unfolding ? '펼침' : '접음'}`;
  if (ui.status.textContent !== status) ui.status.textContent = status;
  ui.next.setAttribute('aria-disabled', String(busy || complete));
  nextLabel.textContent = atStart ? '첫 면 펼치기' : unfolding ? '다음 면 펼치기' : '다음 면 접기';
  ui.resetNet.disabled = atStart && !busy;
  ui.previewBlock.hidden = unfolding;
  ui.fold.dataset.actionable = 'false';
  ui.hint.textContent = atStart ? '도형을 눌러 펼치고, 드래그해 돌려 보세요.' :
    unfolding ? '도형을 눌러 다음 면을 펼쳐 보세요.' :
    complete ? '완성된 도형을 드래그해 돌려 보세요.' : '파란 면을 눌러 접어 보세요.';
}

function animate(duration, update, done) {
  cancelAnimationFrame(animationId);
  if (reduceMotion.matches) {
    update(1);
    done();
    scheduleDraw();
    return;
  }
  const start = performance.now();
  function frame(now) {
    const progress = clamp((now - start) / duration, 0, 1);
    update(progress);
    if (progress < 1) animationId = requestAnimationFrame(frame);
    else done();
    scheduleDraw();
  }
  animationId = requestAnimationFrame(frame);
}

function resetNet() {
  cancelAnimationFrame(animationId);
  amounts = shape.faces.map(() => 0);
  foldedCount = net.foldOrder.length;
  unfolding = true;
  movingFace = null;
  hovered = false;
  resetNetAngle();
  hitPolygons = [];
  syncNetControls();
  scheduleDraw();
}

function chooseNet() {
  net = makeNet(shape, ...NET_RECIPES[ui.shape.value][Number(ui.type.value)]);
  resetNet();
}

function advanceNet() {
  const i = nextFace();
  if (movingFace !== null || i === null) return;
  const opening = unfolding;
  movingFace = i;
  hovered = false;
  syncNetControls();
  animate(430, progress => {
    const t = progress * progress * (3 - 2 * progress);
    amounts[i] = opening ? t : 1 - t;
  }, () => {
    foldedCount += opening ? -1 : 1;
    if (opening && foldedCount === 0) unfolding = false;
    movingFace = null;
    syncNetControls();
  });
}

function switchMode(nextMode) {
  if (mode === nextMode) return;
  mode = nextMode;
  const observing = mode === 'observe';
  ui.observe.hidden = !observing;
  ui.net.hidden = observing;
  ui.picker.hidden = observing;
  ui.showObserve.setAttribute('aria-pressed', String(observing));
  ui.showNet.setAttribute('aria-pressed', String(!observing));
  if (observing) cancelAnimationFrame(animationId);
  else chooseNet();
  scheduleDraw();
}

function faceAt(event) {
  const rect = ui.fold.getBoundingClientRect();
  return polygonAt(hitPolygons, event.clientX - rect.left, event.clientY - rect.top);
}

function rotateView(dx, dy) {
  yaw += dx;
  pitch = clamp(pitch + dy, -Math.PI / 2, Math.PI / 2);
  scheduleDraw();
}

function resetNetAngle() {
  netViewOffset = [0, 0];
  renderedNetAngles = [0, 0];
  manualNetAngles = null;
  ui.resetNetView.hidden = true;
  scheduleDraw();
}

function rotateNetView(dx, dy) {
  const [pitchAngle, yawAngle] = renderedNetAngles;
  const [currentPitch, currentYaw] = manualNetAngles ?? [pitchAngle, yawAngle];
  manualNetAngles = [clamp(currentPitch + dy, -Math.PI / 2, Math.PI / 2), currentYaw + dx];
  ui.resetNetView.hidden = false;
  scheduleDraw();
}

function bindRotation(canvas, onRotate, onTap) {
  let drag = null, didDrag = false;
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    didDrag = false;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!didDrag && Math.hypot(dx, dy) < 4) return;
    didDrag = true;
    canvas.classList.add('dragging');
    onRotate(dx * 0.012, dy * 0.012);
    drag.x = event.clientX;
    drag.y = event.clientY;
  });
  if (onTap) {
    canvas.addEventListener('pointerup', event => {
      if (drag?.id !== event.pointerId || didDrag) return;
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) onTap(event);
    });
    canvas.addEventListener('click', event => {
      if (event.detail === 0) onTap(event);
    });
  }
  canvas.addEventListener('lostpointercapture', event => {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    canvas.classList.remove('dragging');
  });
  canvas.addEventListener('keydown', event => {
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault();
    onRotate(direction[0] * 0.12, direction[1] * 0.12);
  });
}

for (const canvas of [ui.solid, ui.sketch]) bindRotation(canvas, rotateView);
bindRotation(ui.fold, rotateNetView, event => {
  const face = faceAt(event);
  if (face !== null && (unfolding || face === nextFace())) advanceNet();
});
ui.fold.addEventListener('pointermove', event => {
  const face = faceAt(event);
  const actionable = movingFace === null && face !== null && (unfolding || face === nextFace());
  ui.fold.dataset.actionable = String(actionable);
  const highlight = actionable && !unfolding;
  if (highlight !== hovered) { hovered = highlight; scheduleDraw(); }
});
ui.fold.addEventListener('pointerleave', () => {
  ui.fold.dataset.actionable = 'false';
  hovered = false;
  scheduleDraw();
});
ui.showObserve.addEventListener('click', () => switchMode('observe'));
ui.showNet.addEventListener('click', () => switchMode('net'));
ui.shape.addEventListener('change', () => {
  updateShape();
  if (mode === 'net') chooseNet();
});
ui.type.addEventListener('change', () => {
  selectedTypes.set(ui.shape.value, ui.type.value);
  chooseNet();
});
ui.hiddenEdges.addEventListener('change', scheduleDraw);
ui.resetView.addEventListener('click', setInitialAngle);
ui.next.addEventListener('click', advanceNet);
ui.resetNet.addEventListener('click', resetNet);
ui.resetNetView.addEventListener('click', () => {
  resetNetAngle();
  ui.fold.focus();
});

if (document.fullscreenEnabled) {
  ui.fullscreen.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { /* The browser may deny a fullscreen transition. */ }
  });
  document.addEventListener('fullscreenchange', () => {
    ui.fullscreen.querySelector('span').textContent = document.fullscreenElement ? '전체 화면 닫기' : '전체 화면';
    scheduleDraw();
  });
} else ui.fullscreen.hidden = true;

const resizer = new ResizeObserver(scheduleDraw);
[ui.solid, ui.sketch, ui.fold, ui.preview].forEach(canvas => resizer.observe(canvas));
updateShape();
