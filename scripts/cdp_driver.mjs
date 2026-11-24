#!/usr/bin/env node
/*
 * cdp_driver.mjs — Meshy 工作区 CDP 直连驱动（不依赖 chrome-devtools MCP）
 *
 * 为什么不用 MCP：2026-11-17 实测 chrome-devtools MCP 会自己起一个独立浏览器实例
 * （list_pages 只看到 about:blank），跟 `--remote-debugging-port=9222` 那个实例不是同一个，
 * 导致注入的钩子、登录状态、页面状态全对不上。直接连 9222 最稳。
 *
 * 子命令：
 *   node cdp_driver.mjs start                    # 用 WMI 脱离式启动 Chrome（避免被任务树回收）
 *   node cdp_driver.mjs inject [url]             # 注入 hook+automeshy 并导航
 *   node cdp_driver.mjs login [--timeout=600]    # 等用户手动登录
 *   node cdp_driver.mjs upload <图片路径>        # 上传（自动处理中文路径）
 *   node cdp_driver.mjs settings                 # 贴图开、多视图/姿势禁点、复核参数
 *   node cdp_driver.mjs generate [--credits=30]  # 积分闸门 + 真实鼠标点击生成
 *   node cdp_driver.mjs wait [--timeout=900]     # 等「带贴图」任务成功
 *   node cdp_driver.mjs capture [--task=id]      # 打开 viewer 抓解密 GLB 并落盘
 *   node cdp_driver.mjs blend <glb> <outDir> [名] # GLB -> .blend + 预览
 *   node cdp_driver.mjs shot <out.png>           # 截屏（人工核对面板用）
 *
 * 状态文件（prevIds / taskId / 下载目录）落在 os.tmpdir()/automeshy-cdp/state.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, "..");
const CFG = JSON.parse(readFileSync(path.join(SKILL_DIR, "config", "default-settings.json"), "utf8"));
const PORT = (CFG.runtime && CFG.runtime.cdpPort) || 9222;
// 临时产物（注入脚本副本、状态文件、ASCII 化图片、截图）统一放 %TEMP%/opencode/automeshy-cdp
const WORK = process.env.AUTOMESHY_WORK || path.join(tmpdir(), "opencode", "automeshy-cdp");
const STATE = path.join(WORK, "state.json");
const DL = (CFG.runtime && CFG.runtime.downloadDir) || path.join(homedir(), "Downloads", "autodownloadmeshy");

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith("--" + k + "="));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const log = (...a) => console.log(...a);
const die = (code, msg) => { console.log(msg); process.exit(code); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() { try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return {}; } }
function saveState(s) { mkdirSync(WORK, { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 1)); }

async function targetUrl() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

async function connect() {
  let list;
  try { list = await targetUrl(); } catch (e) { die(1, `ECONNREFUSED ${PORT}：Chrome 没起或已被回收 → 先跑 node cdp_driver.mjs start`); }
  const page = list.find((t) => t.type === "page" && t.url.includes("meshy.cn"));
  if (!page) die(1, "没找到 meshy.cn 页面 → 先跑 inject");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const failAll = (msg) => {
    for (const { rej, timer } of pending.values()) { clearTimeout(timer); rej(new Error(msg)); }
    pending.clear();
  };
  const send = (m, p = {}, timeoutMs = 60000) => new Promise((res, rej) => {
    const mid = ++id;
    const timer = setTimeout(() => {
      pending.delete(mid);
      rej(new Error(`CDP_TIMEOUT ${m}（${timeoutMs}ms）`));
    }, timeoutMs);
    pending.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); }, timer });
    try { ws.send(JSON.stringify({ id: mid, method: m, params: p })); } catch (e) { clearTimeout(timer); pending.delete(mid); rej(e); }
  });
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  });
  // 页面刷新/关闭会让 WS 断开；必须把挂起的调用全部 reject，否则 top-level await 悬空、进程直接退出
  ws.addEventListener("close", () => failAll("CDP 连接断开（页面被刷新/关闭？）→ 重新跑 inject"));
  ws.addEventListener("error", () => failAll("CDP WebSocket 错误"));
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true });
    ws.addEventListener("error", () => j(new Error("CDP 连接失败")), { once: true });
  });
  const ev = async (expression, timeoutMs = 60000) => {
    const r = await send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    }, timeoutMs);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const click = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  return { ws, send, ev, click, close: () => ws.close() };
}

/* ---------- start：脱离任务树启动 Chrome ---------- */
async function cmdStart() {
  try { await targetUrl(); log(`CDP_ALREADY_RUNNING port=${PORT}`); return; } catch {}
  const cands = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  const exe = cands.find((p) => existsSync(p));
  if (!exe) die(1, "找不到 Chrome/Edge");
  const profile = (CFG.runtime && CFG.runtime.chromeProfileDir) || path.join(tmpdir(), "meshy-cdp-profile");
  const ps = path.join(WORK, "start_chrome.ps1");
  mkdirSync(WORK, { recursive: true });
  // 关键：用 WMI Create 起进程，不挂在当前任务上；否则父任务一结束 Chrome 就被回收
  writeFileSync(ps, [
    `$exe = "${exe}"`,
    `$cmd = '"' + $exe + '" --remote-debugging-port=${PORT} --user-data-dir="${profile}" --no-first-run --no-default-browser-check "https://meshy.cn/workspace"'`,
    `([wmiclass]"Win32_Process").Create($cmd) | Out-Null`,
  ].join("\n"), "utf8");
  await execFileAsync("powershell", ["-ExecutionPolicy", "Bypass", "-File", ps]);
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    try { await targetUrl(); log(`CDP_READY port=${PORT} exe=${exe}`); return; } catch {}
  }
  die(2, "Chrome 起来了但 9222 不通");
}

/* ---------- inject：initScript 注入 + 导航 ---------- */
async function cmdInject() {
  const url = process.argv[3] || (CFG.site || "https://meshy.cn/workspace");
  const source = readFileSync(path.join(HERE, "meshyfree_hook.js"), "utf8") + "\n;\n" +
                 readFileSync(path.join(HERE, "automeshy.js"), "utf8");
  const c = await connect();
  await c.send("Page.enable");
  await c.send("Page.addScriptToEvaluateOnNewDocument", { source });
  await c.send("Page.navigate", { url });
  await sleep(6000);
  const st = await c.ev("JSON.stringify({hook:!!window.meshyfree, auto:!!window.automeshy, url: location.href})");
  log("INJECTED " + st);
  c.close();
}

/* ---------- login ---------- */
async function cmdLogin() {
  const timeout = parseInt(arg("timeout", "600"), 10) * 1000;
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    let c = null;
    try {
      c = await connect();
      last = await c.ev("automeshy.login()", 30000);
      if (last && last.loggedIn) { log("LOGGED_IN " + JSON.stringify(last)); c.close(); return; }
    } catch (e) {
      // 页面刚刷新/WS 断开很常见，重新连一次即可，别让整条命令挂掉
      log("retry: " + String(e.message || e).slice(0, 100));
    } finally {
      try { c && c.close(); } catch {}
    }
    await sleep(5000);
  }
  log("LOGIN_TIMEOUT " + JSON.stringify(last));
  process.exit(3);
}

/* ---------- upload ---------- */
async function cmdUpload() {
  const img = process.argv[3];
  if (!img) die(2, "用法: upload <图片路径>");
  if (!existsSync(img)) die(2, "图片不存在: " + img);
  // 中文/非 ASCII 路径：先复制成 ASCII 名，避开浏览器端解码问题（2026-11-17 实测中文路径必失败）
  let use = img;
  if (!/^[\x20-\x7E]+$/.test(img)) {
    mkdirSync(WORK, { recursive: true });
    use = path.join(WORK, "upload_" + Buffer.from(path.basename(img)).toString("hex").slice(0, 12) + path.extname(img));
    copyFileSync(img, use);
    log("ASCII_COPY " + use);
  }
  const c = await connect();
  await c.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL }).catch(() => {});
  await c.send("DOM.enable");
  const doc = await c.send("DOM.getDocument", { depth: -1 });
  const ids = [];
  (function walk(n) {
    if (n.nodeName === "INPUT" && n.attributes) {
      for (let i = 0; i < n.attributes.length; i += 2) {
        if (n.attributes[i] === "type" && n.attributes[i + 1] === "file") ids.push(n.nodeId);
      }
    }
    (n.children || []).forEach(walk);
  })(doc.root);
  if (!ids.length) die(4, "页面没有 file input");
  for (const nid of ids) await c.send("DOM.setFileInputFiles", { nodeId: nid, files: [use] }).catch(() => {});
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const p = await c.ev("automeshy.probe()");
    if (p.hasImage) { log("UPLOADED hasImage=true size=" + statSync(use).size); c.close(); return; }
    const body = await c.ev("document.body.innerText");
    if (/上传失败/.test(body)) { log("UPLOAD_FAILED（页面提示：图片上传失败）"); c.close(); process.exit(5); }
  }
  log("UPLOAD_TIMEOUT hasImage 仍为 false");
  c.close();
  process.exit(5);
}

/* ---------- settings ---------- */
// 定位：只认可见元素 + 行内作用域；返回落点校验结果，落点不对就绝不点击
const LOCATE_SWITCH = (label) => `(() => {
  const T = s => (s||'').replace(/\\s+/g,' ').trim();
  const txt = e => e ? T(e.innerText||e.textContent) : '';
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const rows = Array.from(document.querySelectorAll('div,span,label,p')).filter(e => txt(e) === ${JSON.stringify(label)} && vis(e));
  for (const e of rows) {
    let up = e;
    for (let d = 0; d < 4 && up; d++, up = up.parentElement) {
      const sw = Array.from(up.querySelectorAll('[role="switch"]')).filter(vis)[0];
      if (!sw) continue;
      const r = sw.getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const at = document.elementFromPoint(cx, cy);
      return JSON.stringify({
        found: true, checked: sw.getAttribute('aria-checked'),
        x: cx, y: cy,
        atSelf: !!at && (at === sw || sw.contains(at)),
        atTag: at ? at.tagName : null,
        atText: at ? T(at.innerText || at.textContent || '').slice(0, 24) : null
      });
    }
  }
  return JSON.stringify({ found: false });
})()`;

const LOCATE_RADIOS = (label) => `(() => {
  const T = s => (s||'').replace(/\\s+/g,' ').trim();
  const txt = e => e ? T(e.innerText||e.textContent) : '';
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const rows = Array.from(document.querySelectorAll('div,span,label,p')).filter(e => txt(e) === ${JSON.stringify(label)} && vis(e));
  for (const e of rows) {
    let up = e;
    for (let d = 0; d < 4 && up; d++, up = up.parentElement) {
      const rs = Array.from(up.querySelectorAll('[role="radio"]')).filter(vis);
      if (rs.length) return JSON.stringify(rs.map(b => ({ t: txt(b), on: b.getAttribute('aria-checked') })));
    }
  }
  return 'null';
})()`;

async function cmdSettings() {
  const c = await connect();
  const where = await c.ev("JSON.stringify({url: location.href, auto: !!window.automeshy})");
  const w = JSON.parse(where);
  if (!w.auto) { c.close(); die(6, "automeshy 未注入（页面已硬刷新）→ 先跑 inject 再 settings：" + w.url); }
  if (!/workspace/.test(w.url)) { c.close(); die(6, "当前不在工作区（" + w.url + "）→ 先跑 inject，并确认已登录"); }

  const read = async (label) => JSON.parse(await c.ev(LOCATE_SWITCH(label)));
  let tex = await read("贴图");
  if (!tex.found) { c.close(); die(6, "找不到「贴图」开关（面板没渲染完？）"); }

  if (tex.checked !== "true") {
    if (!tex.atSelf) {
      c.close();
      die(6, `落点校验失败，拒绝点击：坐标(${Math.round(tex.x)},${Math.round(tex.y)}) 上是 ${tex.atTag}「${tex.atText}」而不是贴图开关`);
    }
    await c.click(tex.x, tex.y);
    await sleep(1200);
    tex = await read("贴图");
  }

  const multi = await read("多视图");
  const pose = await read("姿势");
  const report = {
    texture: tex.checked,
    multiView: multi.found ? multi.checked : null,
    pose: pose.found ? pose.checked : null,
    model: JSON.parse(await c.ev(LOCATE_RADIOS("模型")) || "null"),
    texRes: JSON.parse(await c.ev(LOCATE_RADIOS("贴图分辨率")) || "null"),
    resolution: JSON.parse(await c.ev(LOCATE_RADIOS("分辨率")) || "null"),
    license: JSON.parse(await c.ev(LOCATE_RADIOS("许可证")) || "null"),
    estimatedCredits: await c.ev(`(document.body.innerText.replace(/\\s+/g,' ').match(/(\\d+)\\s*分钟\\s*·?\\s*(\\d+)/)||[])[2] || null`),
    skipped: ["多视图（会员项，点击会弹订阅窗口）", "姿势（会员项）"],
  };
  log(JSON.stringify(report, null, 1));

  const bad = [];
  if (report.texture !== "true") bad.push("贴图未开");
  if (report.multiView === "true") bad.push("多视图被打开了（不该发生）");
  if (report.pose === "true") bad.push("姿势被打开了（不该发生）");
  if (report.estimatedCredits && report.estimatedCredits !== "30") bad.push("估算积分=" + report.estimatedCredits + "（贴图开应=30）");
  c.close();
  if (bad.length) die(7, "SETTINGS_INVALID " + bad.join(" / "));
  log("SETTINGS_OK");
}

/* ---------- generate ---------- */
async function cmdGenerate() {
  const required = parseInt(arg("credits", String((CFG.generation && CFG.generation.creditsRequired) || 30)), 10);
  const c = await connect();
  const gate = await c.ev(`automeshy.checkCredits(${required})`);
  log(`GATE ok=${gate.ok} available=${gate.available} required=${gate.required}`);
  if (!gate.ok) die(7, gate.message);
  const prevIds = await c.ev("automeshy.taskIds(10)");
  const btn = JSON.parse(await c.ev(`(() => {
    const b = Array.from(document.querySelectorAll('button')).filter(x => (x.innerText||'').trim() === '生成')[0];
    if (!b) return JSON.stringify(null);
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
  })()`));
  if (!btn) die(8, "找不到「生成」按钮");
  await c.click(btn.x, btn.y);
  const st = loadState();
  st.prevIds = prevIds; st.startedAt = Date.now(); st.downloadDir = DL;
  saveState(st);
  log("GENERATE_CLICKED prevIds=" + prevIds.length);
  c.close();
}

/* ---------- wait：等带贴图任务 ---------- */
async function cmdWait() {
  const st = loadState();
  if (!st.prevIds) die(9, "没有 prevIds，先跑 generate");
  const deadline = Date.now() + parseInt(arg("timeout", "900"), 10) * 1000;
  const c = await connect();
  let t = null;
  // 单次 evaluate 别跑太久，60 秒一段，避免 CDP_TIMEOUT 与页面刷新一起把结果吞掉
  while (Date.now() < deadline) {
    t = await c.ev(`automeshy.findTexturedTask(${JSON.stringify(st.prevIds)}, 60000, 5000)`, 90000);
    if (t && t.ok) break;
    if (t && t.status === "TIMEOUT") continue;
    break;
  }
  log(JSON.stringify(t, null, 1));
  if (t && t.ok) { const s2 = loadState(); s2.taskId = t.taskId; saveState(s2); c.close(); return; }
  c.close();
  process.exit(10);
}

/* ---------- capture：抓解密 GLB ---------- */
async function cmdCapture() {
  const st = loadState();
  const taskId = arg("task", st.taskId);
  if (!taskId) die(11, "没有 taskId");
  const c = await connect();
  await c.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL }).catch(() => {});
  const opened = await c.ev(`automeshy.openTask(${JSON.stringify(taskId)})`);
  log("openTask " + JSON.stringify(opened));
  let meta = null;
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const arr = JSON.parse(await c.ev("JSON.stringify(meshyfree.list())") || "[]");
    const glb = arr.filter((x) => String(x.magic).startsWith("glTF"));
    log(`try${i} captured=${arr.length} glb=${glb.length}`);
    if (glb.length) { meta = JSON.parse(await c.ev("JSON.stringify(meshyfree.meta())")); log("meta " + JSON.stringify(meta)); break; }
  }
  if (!meta) { c.close(); die(12, "NO_GLB：钩子没抓到，刷新页面用 initScript 重新注入后再 openTask 一次"); }
  const name = "AutoMeshy_" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  log("saveGlb " + JSON.stringify(await c.ev(`meshyfree.saveGlb(${JSON.stringify(name + ".glb")})`)));
  let file = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const done = readdirSync(DL).find((f) => f.startsWith(name) && f.endsWith(".glb"));
    if (done) { file = path.join(DL, done); break; }
  }
  c.close();
  if (!file) die(13, "下载没落盘：" + DL);
  const s2 = loadState(); s2.glb = file; s2.glbMeta = meta; saveState(s2);
  log("GLB_FILE " + file + " size=" + statSync(file).size);
}

/* ---------- blend ---------- */
async function cmdBlend() {
  const glb = process.argv[3];
  const outDir = process.argv[4] || DL;
  const name = process.argv[5];
  if (!glb) die(2, "用法: blend <glb> <outDir> [name]");
  const args = [path.join(HERE, "finalize_download.py"), glb, outDir];
  if (name) args.push("--name", name);
  const { stdout } = await execFileAsync("python", args, { maxBuffer: 1 << 24 });
  log(stdout);
}

/* ---------- shot ---------- */
async function cmdShot() {
  const out = process.argv[3] || path.join(WORK, "shot.png");
  const c = await connect();
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(r.data, "base64"));
  log("SHOT " + out);
  c.close();
}

/* ---------- eval：排错用，在页面里执行一段脚本 ---------- */
async function cmdEval() {
  const file = process.argv[3];
  const inline = arg("expr", null);
  if (!file && !inline) die(2, "用法: eval <file.js>  或  eval --expr=\"...\"");
  const code = inline || readFileSync(file, "utf8");
  const c = await connect();
  const v = await c.ev(code);
  log(typeof v === "string" ? v : JSON.stringify(v, null, 1));
  c.close();
}

const cmd = process.argv[2];
const table = { start: cmdStart, inject: cmdInject, login: cmdLogin, upload: cmdUpload, settings: cmdSettings, generate: cmdGenerate, wait: cmdWait, capture: cmdCapture, blend: cmdBlend, shot: cmdShot, eval: cmdEval };
if (!table[cmd]) die(2, "子命令: " + Object.keys(table).join(" | "));
await table[cmd]();
