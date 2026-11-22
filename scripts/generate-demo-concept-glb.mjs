// Generates public/models/ea-demo-concept-coupe.glb — an ORIGINAL, procedurally
// built stylised coupe owned by the project (no third-party geometry/textures).
// It is a DEMO CONCEPT for the 3D/AR viewer and must never be presented as a
// real auction vehicle. Run: node tools/3d/generate-demo-concept-glb.mjs
// No dependencies: writes glTF 2.0 binary (GLB) directly.
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("public/models/ea-demo-concept-coupe.glb");

// ---------- geometry helpers ----------
const meshes = []; // {name, material, positions[], normals[], indices[]}
function addMesh(name, material, positions, indices, normals) {
  meshes.push({ name, material, positions, indices, normals: normals ?? smoothNormals(positions, indices) });
}
function smoothNormals(p, idx) {
  const n = new Float64Array(p.length);
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { n[k] += nx; n[k + 1] += ny; n[k + 2] += nz; }
  }
  const out = [];
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    out.push(n[i] / l, n[i + 1] / l, n[i + 2] / l);
  }
  return out;
}
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);
// piecewise-smooth profile through [x, value] keys
function profile(keys) {
  return x => {
    if (x <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      if (x <= keys[i][0]) {
        const t = (x - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]);
        return lerp(keys[i - 1][1], keys[i][1], smooth(t));
      }
    }
    return keys[keys.length - 1][1];
  };
}

// Car axes (glTF): +X right, +Y up, +Z forward (front of car). Length 4.6 m.
const L0 = -2.3, L1 = 2.3;
const halfWidth = profile([[-2.3, .78], [-2.15, .9], [-1.6, .95], [1.4, .95], [2.05, .86], [2.3, .7]]);
const bottom = profile([[-2.3, .34], [-2.0, .26], [1.9, .26], [2.3, .34]]);
const shoulder = profile([[-2.3, .78], [-2.05, .9], [-1.2, .93], [.9, .86], [1.9, .72], [2.3, .58]]);
// greenhouse (glass canopy) exists between z=-1.25 and z=1.0
const roof = profile([[-1.45, .93], [-1.0, 1.24], [-.55, 1.33], [.15, 1.33], [.95, .88]]);
const roofHalf = profile([[-1.45, .82], [-1.0, .66], [0, .62], [.95, .8]]);

function sectionPoints(z) {
  // Lower body: rounded rectangle-ish superellipse from bottom to shoulder.
  const w = halfWidth(z), b = bottom(z), s = shoulder(z), pts = [];
  const N = 28, e = 2 / 5.5; // superellipse exponent (boxy but soft)
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const c = Math.cos(a), si = Math.sin(a);
    const x = w * Math.sign(c) * Math.abs(c) ** e;
    const y = (b + s) / 2 + ((s - b) / 2) * Math.sign(si) * Math.abs(si) ** e;
    pts.push([x, y, z]);
  }
  return pts;
}
function canopyPoints(z) {
  const s = shoulder(z) - .02, r = roof(z), w0 = halfWidth(z) * .9, w1 = roofHalf(z), pts = [];
  const N = 16;
  for (let i = 0; i <= N; i++) {
    const t = i / N, a = Math.PI * t; // left -> over the top -> right
    const x = -Math.cos(a) * lerp(w0, w1, Math.sin(a) ** .6);
    const y = s + (r - s) * Math.sin(a) ** .45;
    pts.push([x, y, z]);
  }
  return pts;
}
function loft(stations, sectionFn, closed, capEnds) {
  const rings = stations.map(sectionFn), n = rings[0].length, pos = [], idx = [];
  for (const ring of rings) for (const p of ring) pos.push(...p);
  const segs = closed ? n : n - 1;
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < segs; i++) {
      const a = r * n + i, b = r * n + ((i + 1) % n), c = (r + 1) * n + i, d = (r + 1) * n + ((i + 1) % n);
      idx.push(a, c, b, b, c, d);
    }
  }
  if (capEnds) {
    for (const [ri, flip] of [[0, true], [rings.length - 1, false]]) {
      const centre = pos.length / 3, ring = rings[ri];
      const cx = ring.reduce((s, p) => s + p[0], 0) / n, cy = ring.reduce((s, p) => s + p[1], 0) / n;
      pos.push(cx, cy, ring[0][2]);
      for (let i = 0; i < n; i++) {
        const a = ri * n + i, b = ri * n + ((i + 1) % n);
        flip ? idx.push(centre, a, b) : idx.push(centre, b, a);
      }
    }
  }
  return { pos, idx };
}
const stations = (a, b, count) => Array.from({ length: count }, (_, i) => lerp(a, b, i / (count - 1)));

// Body + canopy
{ const { pos, idx } = loft(stations(L0, L1, 72), sectionPoints, true, true); addMesh("Body", 0, pos, idx); }
{ const { pos, idx } = loft(stations(-1.42, .93, 40), canopyPoints, false, false);
  // close canopy ends with simple fans
  addMesh("Glass", 1, pos, idx); }

// Box helper (flat normals)
function box(cx, cy, cz, sx, sy, sz) {
  const pos = [], nor = [], idx = [];
  const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const [nx, ny, nz] of faces) {
    const u = ny !== 0 ? [1, 0, 0] : [0, 1, 0];
    const v = [ny * u[2] - nz * u[1], nz * u[0] - nx * u[2], nx * u[1] - ny * u[0]];
    const base = pos.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      pos.push(cx + (nx + u[0] * su + v[0] * sv) * sx / 2, cy + (ny + u[1] * su + v[1] * sv) * sy / 2, cz + (nz + u[2] * su + v[2] * sv) * sz / 2);
      nor.push(nx, ny, nz);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { pos, nor, idx };
}
// Light bars (emissive)
{ const l = box(-.5, .7, 2.2, .5, .05, .1), r = box(.5, .7, 2.2, .5, .05, .1);
  addMesh("Headlight_L", 2, l.pos, l.idx, l.nor); addMesh("Headlight_R", 2, r.pos, r.idx, r.nor); }
{ const t = box(0, .8, -2.27, 1.4, .05, .06); addMesh("Taillight_Bar", 3, t.pos, t.idx, t.nor); }

// Wheels: tyre (cylinder band + sidewalls) and a rim disc with 5 spokes
function cylinder(cx, cy, cz, radius, width, seg, capOuter) {
  const pos = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2, y = cy + Math.sin(a) * radius, z = cz + Math.cos(a) * radius;
    pos.push(cx - width / 2, y, z, cx + width / 2, y, z);
  }
  for (let i = 0; i < seg; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  if (capOuter !== 0) {
    const side = Math.sign(capOuter), c = pos.length / 3, xx = cx + side * width / 2;
    pos.push(xx, cy, cz);
    for (let i = 0; i < seg; i++) { const a = i * 2 + (side > 0 ? 1 : 0), b = a + 2; side > 0 ? idx.push(c, a, b) : idx.push(c, b, a); }
  }
  return { pos, idx };
}
const wheelR = .35, axleY = .35, track = .9;
for (const [label, wz] of [["F", 1.42], ["R", -1.38]]) {
  for (const [side, sx] of [["L", -1], ["R", 1]]) {
    const x = sx * track;
    const tyre = cylinder(x, axleY, wz, wheelR, .26, 48, 0);
    addMesh(`Tyre_${label}${side}`, 4, tyre.pos, tyre.idx);
    const rim = cylinder(x + sx * .1, axleY, wz, .24, .07, 48, sx);
    addMesh(`Rim_${label}${side}`, 5, rim.pos, rim.idx);
    for (let k = 0; k < 5; k++) { // spokes
      const a = (k / 5) * Math.PI * 2, sp = box(x + sx * .14, axleY + Math.sin(a) * .12, wz + Math.cos(a) * .12, .03, .05, .05);
      // stretch spoke radially by duplicating outward
      const sp2 = box(x + sx * .14, axleY + Math.sin(a) * .2, wz + Math.cos(a) * .2, .03, .05, .05);
      addMesh(`Spoke_${label}${side}${k}a`, 5, sp.pos, sp.idx, sp.nor);
      addMesh(`Spoke_${label}${side}${k}b`, 5, sp2.pos, sp2.idx, sp2.nor);
    }
    const cal = box(x + sx * .02, axleY + .14, wz + .1, .06, .12, .16); // brake caliper
    addMesh(`Caliper_${label}${side}`, 6, cal.pos, cal.idx, cal.nor);
  }
}

// ---------- materials (PBR) ----------
const materials = [
  { name: "EA_Paint_DeepRed", pbrMetallicRoughness: { baseColorFactor: [.42, .006, .018, 1], metallicFactor: .55, roughnessFactor: .28 },
    extensions: { KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatRoughnessFactor: .04 } } },
  { name: "Glass_Smoked", pbrMetallicRoughness: { baseColorFactor: [.012, .012, .015, 1], metallicFactor: .2, roughnessFactor: .06 } },
  { name: "Light_White", pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: .3 }, emissiveFactor: [1, 1, 1] },
  { name: "Light_Red", pbrMetallicRoughness: { baseColorFactor: [1, .02, .05, 1], metallicFactor: 0, roughnessFactor: .3 }, emissiveFactor: [1, .03, .06] },
  { name: "Tyre_Rubber", pbrMetallicRoughness: { baseColorFactor: [.02, .02, .022, 1], metallicFactor: 0, roughnessFactor: .85 } },
  { name: "Rim_Graphite", pbrMetallicRoughness: { baseColorFactor: [.2, .2, .22, 1], metallicFactor: 1, roughnessFactor: .25 } },
  { name: "Caliper_Black", pbrMetallicRoughness: { baseColorFactor: [.05, .05, .055, 1], metallicFactor: .3, roughnessFactor: .45 } },
];

for (const m of materials) m.doubleSided = true; // robust shading regardless of triangle winding

// ---------- GLB encoding ----------
const chunks = [], accessors = [], bufferViews = [], gltfMeshes = [], nodes = [];
let offset = 0;
function pushView(typed, target) {
  const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  const pad = (4 - (bytes.length % 4)) % 4;
  chunks.push(bytes, Buffer.alloc(pad));
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
  offset += bytes.length + pad;
  return bufferViews.length - 1;
}
for (const m of meshes) {
  const p = new Float32Array(m.positions), n = new Float32Array(m.normals);
  const vcount = p.length / 3;
  const ix = vcount > 65535 ? new Uint32Array(m.indices) : new Uint16Array(m.indices);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[i + k]); max[k] = Math.max(max[k], p[i + k]); }
  accessors.push({ bufferView: pushView(p, 34962), componentType: 5126, count: vcount, type: "VEC3", min, max });
  const pa = accessors.length - 1;
  accessors.push({ bufferView: pushView(n, 34962), componentType: 5126, count: vcount, type: "VEC3" });
  const na = accessors.length - 1;
  accessors.push({ bufferView: pushView(ix, 34963), componentType: ix instanceof Uint32Array ? 5125 : 5123, count: ix.length, type: "SCALAR" });
  const ia = accessors.length - 1;
  gltfMeshes.push({ name: m.name, primitives: [{ attributes: { POSITION: pa, NORMAL: na }, indices: ia, material: m.material }] });
  nodes.push({ name: m.name, mesh: gltfMeshes.length - 1 });
}
nodes.push({ name: "EA_Demo_Concept_Coupe", children: nodes.map((_, i) => i) });
const bin = Buffer.concat(chunks);
const gltf = {
  asset: { version: "2.0", generator: "E&A tools/3d/generate-demo-concept-glb.mjs", copyright: "E&A East and West Auctioneers Group — original procedural demo asset. DEMO CONCEPT, not a real vehicle." },
  extensionsUsed: ["KHR_materials_clearcoat"],
  scene: 0, scenes: [{ name: "Scene", nodes: [nodes.length - 1] }],
  nodes, meshes: gltfMeshes, materials, accessors, bufferViews,
  buffers: [{ byteLength: bin.length }],
};
let json = Buffer.from(JSON.stringify(gltf));
json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
jh.writeUInt32LE(json.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([header, jh, json, bh, bin]));
console.log(`GLB written: ${OUT} · ${meshes.length} meshes · ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
