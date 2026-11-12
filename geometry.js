/* Convex polyhedra and rigid rotations about the uncut edges of a net. */
'use strict';

const Geometry = (() => {
  const add = (a, b) => a.map((value, i) => value + b[i]);
  const sub = (a, b) => a.map((value, i) => value - b[i]);
  const mul = (a, n) => a.map(value => value * n);
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = a => mul(a, 1 / Math.hypot(...a));
  const mean = points => mul(points.reduce(add, Array(points[0].length).fill(0)), 1 / points.length);
  const pairs = points => points.map((point, i) => [point, points[(i + 1) % points.length]]);
  const edgeKey = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
  const clamp = (x, low, high) => Math.max(low, Math.min(high, x));

  function rotate(point, axis, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return add(add(mul(point, c), mul(cross(axis, point), s)), mul(axis, dot(axis, point) * (1 - c)));
  }

  function bounds(polygons) {
    const points = polygons.flat();
    const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
    return { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys) };
  }

  function solid(name, vertices, faceTopology) {
    const hull = new Map();
    for (let a = 0; a < vertices.length; a++) {
      for (let b = a + 1; b < vertices.length; b++) {
        for (let c = b + 1; c < vertices.length; c++) {
          if (faceTopology) break;
          const axis = cross(sub(vertices[b], vertices[a]), sub(vertices[c], vertices[a]));
          if (Math.hypot(...axis) < 1e-7) continue;
          const distances = vertices.map(point => dot(sub(point, vertices[a]), unit(axis)));
          if (Math.min(...distances) < -1e-7 && Math.max(...distances) > 1e-7) continue;
          const indices = distances.flatMap((distance, i) => Math.abs(distance) < 1e-7 ? [i] : []);
          if (!hull.has(indices.join())) {
            hull.set(indices.join(), { indices, normal: mul(unit(axis), Math.max(...distances) > 1e-7 ? -1 : 1) });
          }
        }
      }
    }
    const faces = faceTopology ? faceTopology.map(({ ids, normal }) => ({ ids, normal })) :
      Array.from(hull.values(), ({ indices, normal }) => {
        const center = mean(indices.map(i => vertices[i]));
        const x = unit(sub(vertices[indices[0]], center));
        const y = cross(normal, x);
        const angles = indices.map(i => {
          const v = sub(vertices[i], center);
          return { i, angle: Math.atan2(dot(v, y), dot(v, x)) };
        });
        return { normal, ids: angles.sort((a, b) => a.angle - b.angle).map(({ i }) => i) };
      });

    const byEdge = new Map();
    const neighbors = faces.map(() => []);
    faces.forEach((face, i) => {
      pairs(face.ids).forEach(([a, b]) => {
        const key = edgeKey(a, b);
        if (!byEdge.has(key)) byEdge.set(key, { a, b, faces: [] });
        byEdge.get(key).faces.push(i);
      });
    });
    const edges = [...byEdge.values()];
    for (const { a, b, faces: [first, second] } of edges) {
      neighbors[first].push({ face: second, a, b });
      neighbors[second].push({ face: first, a, b });
    }
    return { name, vertices, faces, edges, neighbors };
  }

  const signs = [-1, 1];
  const corners = signs.flatMap(x => signs.flatMap(y => signs.map(z => [x, y, z])));
  const golden = (1 + Math.sqrt(5)) / 2;
  const cycles = (a, b, c) => [[a, b, c], [c, a, b], [b, c, a]];
  const goldenCorners = (a, b) => signs.flatMap(i => signs.flatMap(j => cycles(0, i * a, j * b)));
  const cube = solid('정육면체', corners);
  const solids = {
    cube,
    box: solid('직육면체', corners.map(([x, y, z]) => [x * 1.38, y * 0.82, z * 0.62]), cube.faces),
    tetra: solid('정사면체', corners.filter(([x, y, z]) => x * y * z === 1)),
    octa: solid('정팔면체', signs.flatMap(sign => cycles(sign * 1.48, 0, 0))),
    dodeca: solid('정십이면체', [...corners, ...goldenCorners(1 / golden, golden)]),
    icosa: solid('정이십면체', goldenCorners(1, golden)),
  };

  function makeNet(shape, root, parents, order) {
    const { vertices, faces, neighbors } = shape;
    const origin = mean(faces[root].ids.map(i => vertices[i]));
    const normal = faces[root].normal;
    const [a, b] = faces[root].ids;
    const x = unit(sub(vertices[b], vertices[a]));
    const y = cross(x, normal);
    const frame = point => [dot(sub(point, origin), x), dot(sub(point, origin), y), -dot(sub(point, origin), normal)];
    const hinges = faces.map((face, i) => {
      if (i === root) return null;
      const edge = neighbors[i].find(({ face: neighbor }) => neighbor === parents[i]);
      const pivot = vertices[edge.a];
      const axis = unit(sub(vertices[edge.b], pivot));
      const target = faces[parents[i]].normal;
      const angle = Math.atan2(dot(axis, cross(face.normal, target)), dot(face.normal, target));
      return { pivot, axis, angle, edge: edgeKey(edge.a, edge.b) };
    });
    const traversal = [root];
    for (let i = 0; i < traversal.length; i++) {
      parents.forEach((parent, child) => { if (parent === traversal[i]) traversal.push(child); });
    }
    const foldOrder = order ?? traversal.slice(1).reverse();
    const creaseFaces = new Map(hinges.flatMap((hinge, face) => hinge ? [[hinge.edge, face]] : []));

    function polygons(openness) {
      const transforms = [];
      transforms[root] = frame;
      for (const i of traversal.slice(1)) {
        const { pivot, axis, angle } = hinges[i];
        const parent = transforms[parents[i]];
        const foldAngle = angle * openness[i];
        transforms[i] = point => parent(add(pivot, rotate(sub(point, pivot), axis, foldAngle)));
      }
      return faces.map((face, i) => face.ids.map(id => transforms[i](vertices[id])));
    }

    const flat = polygons(faces.map(() => 1));
    return { root, foldOrder, flat, creaseFaces, polygons };
  }

  return { solids, makeNet, add, sub, mul, dot, cross, mean, rotate, unit, pairs, edgeKey, bounds, clamp };
})();

if (typeof module !== 'undefined') module.exports = Geometry;
