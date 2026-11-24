/*
 * selftest_automeshy.mjs — 离线自检 automeshy.js 的关键行为，不依赖浏览器。
 * 覆盖：登录检测、积分闸门、积分不足不点生成、缺图不点生成、姿势开关绝不点击。
 * 用法: node scripts/selftest_automeshy.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

let creditsResult = { creditBalance: 0, freeCreditBalance: 0, agentSpendableBalance: 76 };
let clicks = [];
let hasImage = true;
let loggedIn = true;

function el(tag, text, extra = {}) {
  return {
    tagName: tag.toUpperCase(),
    innerText: text,
    textContent: text,
    className: '',
    checked: false,
    files: null,
    accept: 'image/*',
    multiple: false,
    name: '',
    style: {},
    attrs: {},
    getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    closest() { return this._parent || this; },
    get parentElement() { return this._parent || null; },
    getBoundingClientRect() { return { x: 10, y: 10, width: 100, height: 30, toJSON() { return this; } }; },
    dispatchEvent(ev) { if (ev.type === 'click') clicks.push(text); return true; },
    querySelector() { return null; },
    appendChild() {},
    outerHTML: '<' + tag + '>' + text + '</' + tag + '>',
    ...extra
  };
}

const buttons = [
  Object.assign(el('button', '高细节'), { attrs: { 'aria-checked': 'true', role: 'radio' } }),
  Object.assign(el('button', '标准'), { attrs: { 'aria-checked': 'true', role: 'radio' } }),
  Object.assign(el('button', 'Meshy 7'), { attrs: { 'aria-checked': 'true', role: 'radio' } }),
  Object.assign(el('button', '2K'), { attrs: { 'aria-checked': 'true', role: 'radio' } }),
  Object.assign(el('button', 'CC BY 4.0'), { attrs: { 'aria-checked': 'true', role: 'radio' } }),
  el('button', '生成'),
];
const switches = ['多视图', '拆分', '贴图', '姿势', '图像增强'].map((k, i) => {
  const s = Object.assign(el('div', k), { attrs: { role: 'switch', 'aria-checked': i === 0 || i === 2 || i === 4 ? 'true' : 'false' } });
  s._parent = el('div', k);
  return s;
});
const imgs = [];

globalThis.window = globalThis;
globalThis.location = { href: 'https://meshy.cn/workspace' };
globalThis.document = {
  cookie: 'sb-meshy-auth-token.0=base64-' + Buffer.from(JSON.stringify({ access_token: 'FAKE_TOKEN' })).toString('base64'),
  body: { innerText: '我的积分 76 生成 2分钟 30积分' },
  querySelector(sel) {
    if (sel.includes('img')) {
      if (!hasImage) return null;
      const im = imgs[0] || null;
      if (!im) return null;
      if (!/src/.test(sel)) return im;
      // 粗略实现 img[src^="blob:"],img[src^="data:"],img[src*="/uploads/"]
      if (/src\^="blob:"/.test(sel) && /^blob:/.test(im.src)) return im;
      if (/src\^="data:"/.test(sel) && /^data:/.test(im.src)) return im;
      if (/src\*="\/uploads\/"/.test(sel) && im.src.includes('/uploads/')) return im;
      return null;
    }
    if (sel.includes('input[type="file"]')) return el('input', '');
    return null;
  },
  querySelectorAll(sel) {
    if (sel.includes('img')) return hasImage ? imgs : [];
    if (sel.includes('input[type="file"]')) return [el('input', '')];
    if (sel.includes('switch') || sel.includes('checkbox')) return switches;
    if (sel.includes('radio') || sel.includes('button') || sel.includes('label')) return buttons;
    return [];
  },
  createElement: () => el('a', ''),
};
globalThis.localStorage = { length: 0, key: () => null, getItem: () => null };
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.MouseEvent = class { constructor(type, o) { this.type = type; Object.assign(this, o || {}); } };
globalThis.Event = class { constructor(type) { this.type = type; } };
globalThis.DataTransfer = class { constructor() { this.items = { add() {} }; this.files = []; } };
globalThis.File = class { constructor(parts, name, opt) { this.name = name; this.size = (parts[0] || []).length || 0; } };
globalThis.fetch = async (url) => {
  if (url.includes('/me/info')) {
    return { status: loggedIn ? 200 : 401, text: async () => JSON.stringify({ code: 'OK', result: { email: 'test@example.com', tier: 'free' } }) };
  }
  if (url.includes('/me/credits')) {
    return { status: 200, text: async () => JSON.stringify({ code: 'OK', result: creditsResult }) };
  }
  if (url.includes('/v2/tasks')) {
    return { statusSeed: 200, text: async () => JSON.stringify({ code: 'OK', result: [] }) };
  }
  return { status: 200, text: async () => '{}' };
};
globalThis.console = console;

imgs.push(Object.assign(el('img', ''), { src: 'blob:http://meshy.cn/fake', currentSrc: 'blob:http://meshy.cn/fake' }));
buttons.forEach((b) => { b._parent = el('div', ''); });
switches.forEach((s) => { s._parent = el('div', s.innerText); });

vm.runInThisContext(fs.readFileSync(path.join(here, 'automeshy.js'), 'utf8'));

const cfg = JSON.parse(fs.readFileSync(path.join(here, '..', 'config', 'default-settings.json'), 'utf8')).settings;
const checks = [];
function check(name, cond, detail) { checks.push([name, !!cond, detail]); }

// 1. 设置面板：姿势 / 多视图必须跳过
const applied = automeshy.applySettings(cfg);
check('applySettings 跳过姿势', applied.skipped.some((s) => s.indexOf('姿势') >= 0), JSON.stringify(applied.skipped));
check('applySettings 未触碰姿势控件', !applied.changed.some((s) => s.indexOf('姿势') >= 0), JSON.stringify(applied.changed));
const poseClicks = clicks.filter((c) => c === '姿势').length;
check('姿势开关点击次数为 0', poseClicks === 0, 'clicks=' + poseClicks);

// 1b. 多视图是会员项（点它会弹订阅窗口），必须跳过
check('applySettings 跳过多视图', applied.skipped.some((s) => s.indexOf('多视图') >= 0), JSON.stringify(applied.skipped));
check('applySettings 未触碰多视图控件', !applied.changed.some((s) => s.indexOf('多视图') >= 0), JSON.stringify(applied.changed));
const mvClicks = clicks.filter((c) => c === '多视图').length;
check('多视图点击次数为 0', mvClicks === 0, 'clicks=' + mvClicks);

// 2. 登录
const login = await automeshy.login();
check('登录检测', login.loggedIn === true, JSON.stringify(login));

// 3. 积分充足 -> 生成
creditsResult = { creditBalance: 0, freeCreditBalance: 0, agentSpendableBalance: 76 };
clicks = [];
const g1 = await automeshy.generate({ creditsRequired: 30 });
check('积分充足时允许生成', g1.ok === true, JSON.stringify(g1));
check('生成按钮被点击', clicks.includes('生成'), JSON.stringify(clicks));

// 4. 积分不足 -> 不点击生成
creditsResult = { creditBalance: 0, freeCreditBalance: 0, agentSpendableBalance: 10 };
clicks = [];
const g2 = await automeshy.generate({ creditsRequired: 30 });
check('积分不足时拒绝生成', g2.ok === false && g2.stage === 'credits', JSON.stringify(g2));
check('积分不足未点击生成', !clicks.includes('生成'), JSON.stringify(clicks));
check('积分不足有中文提示', /积分不足/.test(g2.message) && /本次未点击/.test(g2.message), g2.message);

// 5. 未上传图片 -> 不点击生成
creditsResult = { creditBalance: 0, freeCreditBalance: 0, agentSpendableBalance: 76 };
hasImage = false;
clicks = [];
const g3 = await automeshy.generate({ creditsRequired: 30 });
check('缺图时拒绝生成', g3.ok === false && g3.stage === 'image', JSON.stringify(g3));
check('缺图未点击生成', !clicks.includes('生成'), JSON.stringify(clicks));
hasImage = true;

// 6. hasImage 不得被右侧任务缩略图（.../tasks/...）误命中（2026-11-17 假阳性回归）
const blobSrc = imgs[0].src;
imgs[0].src = 'https://api.meshy.cn/misc/cdn-images/uid/tasks/xxx/preview.png';
check('任务缩略图不算已上传图片', automeshy.probe().hasImage === false, 'probe().hasImage 被 tasks/ 缩略图命中');
imgs[0].src = 'https://api.meshy.cn/misc/cdn-images/uid/uploads/xxx.png';
check('uploads/ 图算已上传图片', automeshy.probe().hasImage === true, 'probe().hasImage 没识别 .../uploads/ 图');
imgs[0].src = blobSrc;

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  <- ' + detail));
  if (!ok) failed++;
}
console.log(failed === 0 ? '\nALL PASS (' + checks.length + ')' : '\nFAILED: ' + failed);
process.exit(failed === 0 ? 0 : 1);
