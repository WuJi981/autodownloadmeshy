/*
 * selftest_hook.mjs
 * 在 Node 的浏览器桩环境里验证 meshyfree_hook.js 的两条捕获路径（addEventListener / onmessage）
 * 以及 meta() / saveGlb() 行为，不依赖真实浏览器。
 *
 * 用法: node scripts/selftest_hook.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.join(here, 'meshyfree_hook.js');

const events = { listeners: {} };
class FakeWorker {
  constructor() {
    this._l = {};
    FakeWorker.last = this;
  }
  addEventListener(type, fn) {
    (this._l[type] = this._l[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    this._l[type] = (this._l[type] || []).filter((f) => f !== fn);
  }
  dispatch(data) {
    (this._l.message || []).forEach((f) => f({ data }));
  }
}

const downloads = [];
globalThis.window = globalThis;
globalThis.document = {
  cookie: '',
  title: 'selftest',
  createElement: () => ({ style: {}, download: '', click() { downloads.push(this.download); }, remove() {} }),
  body: { appendChild() {} }
};
globalThis.Worker = FakeWorker;
globalThis.URL.createObjectURL = () => 'blob:selftest';
globalThis.URL.revokeObjectURL = () => {};

function makeGlb(json, binLength = 4096) {
  const enc = new TextEncoder();
  let head = enc.encode(JSON.stringify(json));
  const pad = (4 - (head.length % 4)) % 4;
  if (pad) {
    const padded = new Uint8Array(head.length + pad).fill(0x20);
    padded.set(head);
    head = padded;
  }
  const total = 12 + 8 + head.length + 8 + binLength;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, head.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buf, 20).set(head);
  const off = 20 + head.length;
  dv.setUint32(off, binLength, true);
  dv.setUint32(off + 4, 0x004e4942, true);
  return buf;
}

const glb = makeGlb({
  asset: { generator: 'selftest' },
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  accessors: [{ count: 3 }, { count: 12 }],
  images: [{ mimeType: 'image/webp' }],
  materials: [{}],
  nodes: [{}]
});

const code = fs.readFileSync(hookPath, 'utf8');
const install = vm.runInThisContext(code);
const reinstall = vm.runInThisContext(code);
console.log('install      ->', install);
console.log('reinstall    ->', reinstall);

// 路径 1: addEventListener
const w1 = new window.Worker('blob:fake1');
w1.addEventListener('message', () => {});
FakeWorker.last.dispatch(glb);

// 路径 2: onmessage 赋值（必须同时保留应用自身回调）
const w2 = new window.Worker('blob:fake2');
let appCalled = false;
w2.onmessage = () => { appCalled = true; };
FakeWorker.last.dispatch(glb);

const meta = meshyfree.meta();
const saved = meshyfree.saveGlb('SelfTest');

console.log('list         ->', JSON.stringify(meshyfree.list()));
console.log('meta         ->', JSON.stringify(meta));
console.log('save         ->', JSON.stringify(saved));
console.log('app callback ->', appCalled);
console.log('errors       ->', JSON.stringify(meshyfree.errors()));

const checks = [
  ['addEventListener 路径已捕获', meshyfree.list().length >= 2],
  ['onmessage 回调未被吞掉', appCalled === true],
  ['GLB 头部解析正确', meta.version === 2 && meta.actualLength === glb.byteLength],
  ['三角面数正确', meta.triangles === 4],
  ['saveGlb 触发下载', saved.ok === true && downloads.includes('SelfTest.glb')],
  ['无内部错误', Array.isArray(meshyfree.errors()) && meshyfree.errors().length === 0]
];

let failed = 0;
for (const [name, pass] of checks) {
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name);
  if (!pass) failed++;
}
process.exit(failed === 0 ? 0 : 1);
