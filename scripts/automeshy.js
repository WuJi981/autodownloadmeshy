/*
 * automeshy.js — Meshy 图片生成模型面板自动化
 * 注入到 https://meshy.cn/workspace 页面（evaluate_script, format="script"），提供 window.automeshy。
 *
 * 设计要点：
 *  - 只操作「生成」左侧面板的官方控件，不伪造接口、不改积分、不伪造会员状态；付费项一律跳过。
 *  - 姿势（pose）开关默认不点：点击会触发「开会员」弹窗，config 中 clickForbidden=true 时直接跳过。
 *  - 多视图（multiView）同为会员项：点击会弹「订阅以使用多视角」，同样绝不点击（2026-11-17 实测）。
 *  - 积分不足时不点击生成，返回结构化错误，由调用方输出给用户。
 *  - clickEl 用的是合成事件，个别 shadcn 开关不认；不生效时改用 CDP
 *    Input.dispatchMouseEvent 打真实鼠标事件（见 scripts/cdp_driver.mjs 的 settings 子命令）。
 */

(function () {
  if (window.automeshy) return "already";

  var T = function (s) { return (s || "").replace(/\s+/g, " ").trim(); };
  var txt = function (el) { return el ? T(el.innerText || el.textContent) : ""; };

  function byText(sel, label, exact) {
    var els = Array.prototype.slice.call(document.querySelectorAll(sel));
    return els.filter(function (e) {
      var t = txt(e);
      return exact ? t === label : t.indexOf(label) >= 0;
    });
  }

  function first(sel, label, exact) { return byText(sel, label, exact)[0] || null; }

  function isOn(el) {
    if (!el) return null;
    if (el.getAttribute("aria-checked") != null) return el.getAttribute("aria-checked") === "true";
    if (el.getAttribute("data-state") != null) return el.getAttribute("data-state") === "checked" || el.getAttribute("data-state") === "on";
    if (typeof el.checked === "boolean") return el.checked;
    if (el.getAttribute("aria-pressed") != null) return el.getAttribute("aria-pressed") === "true";
    var c = " " + (el.className || "") + " ";
    if (/ (bg-lime|bg-green|bg-emerald|bg-\[#c5f955\]|is-checked|active|selected) /i.test(c)) return true;
    return null;
  }

  function clickEl(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    var o = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    el.dispatchEvent(new MouseEvent("mousedown", o));
    el.dispatchEvent(new MouseEvent("mouseup", o));
    el.dispatchEvent(new MouseEvent("click", o));
    return true;
  }

  function dblClickEl(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    var o = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    el.dispatchEvent(new MouseEvent("mousedown", o));
    el.dispatchEvent(new MouseEvent("mouseup", o));
    el.dispatchEvent(new MouseEvent("click", o));
    el.dispatchEvent(new MouseEvent("click", Object.assign({}, o, { detail: 2 })));
    el.dispatchEvent(new MouseEvent("dblclick", Object.assign({}, o, { detail: 2 })));
    return true;
  }

  function getCookie(n) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + n.replace(/[.$]/g, "\\$&") + "=([^;]*)"));
    return m ? m[1] : null;
  }

  function token() {
    var a = getCookie("sb-meshy-auth-token.0"), b = getCookie("sb-meshy-auth-token.1");
    if (a) {
      try {
        var raw = decodeURIComponent(((a || "") + (b || "")).replace(/^base64-/, ""));
        return JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))).access_token;
      } catch (e) {}
    }
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (/^sb-.*-auth-token$/.test(k)) {
          var v = JSON.parse(localStorage.getItem(k));
          if (v && v.access_token) return v.access_token;
        }
      }
    } catch (e) {}
    return null;
  }

  async function api(path, opts) {
    opts = opts || {};
    var h = { accept: "application/json" };
    if (token()) h.authorization = "Bearer " + token();
    if (opts.body) h["content-type"] = "application/json";
    var r = await fetch(path, { method: opts.method || "GET", headers: h, credentials: "include", body: opts.body ? JSON.stringify(opts.body) : undefined });
    var t = await r.text();
    try { return { status: r.status, body: JSON.parse(t) }; } catch (e) { return { status: r.status, body: t.slice(0, 500) }; }
  }

  function switchFor(label) {
    // 面板里的开关通常是 button[role=switch] 或 input[type=checkbox]，其容器包含中文标签
    var sw = Array.prototype.slice.call(document.querySelectorAll('[role="switch"],input[type="checkbox"]'));
    for (var i = 0; i < sw.length; i++) {
      var e = sw[i];
      var box = e.closest("div") || e.parentElement;
      var up = box;
      for (var d = 0; d < 4 && up; d++, up = up.parentElement) {
        if (txt(up).indexOf(label) >= 0 && txt(up).length < 120) return e;
      }
    }
    return null;
  }

  function radioFor(label, exact) {
    return first('[role="radio"],button', label, !!exact) || first("label", label, !!exact);
  }

  function setSwitch(label, desired, report, forbid) {
    if (forbid) {
      report.skipped.push(label);
      return;
    }
    var el = switchFor(label);
    if (!el) { report.missing.push(label); return; }
    var now = isOn(el);
    if (now === null) { report.unknown.push({ label: label, reason: "无法判定当前状态，未点击" }); return; }
    if (now === desired) { report.unchanged.push(label + "=" + (desired ? "开" : "关")); return; }
    clickEl(el);
    report.changed.push(label + " " + (now ? "开" : "关") + " -> " + (desired ? "开" : "关"));
  }

  function setRadio(label, desiredLabel, report) {
    var el = radioFor(desiredLabel, false);
    if (!el) { report.missing.push(label + ":" + desiredLabel); return; }
    var now = isOn(el);
    if (now === true) { report.unchanged.push(label + "=" + desiredLabel); return; }
    clickEl(el);
    report.changed.push(label + " -> " + desiredLabel);
  }

  function panelText() {
    return txt(document.body).slice(0, 2500);
  }

  /*
   * 图片是否真的进了上传槽位（修 2026-11-17 的假阳性）。
   * 成立条件之一：
   *   1) file input 上还挂着没被读走的文件
   *   2) 槽位出现 blob:/data: 预览
   *   3) 出现 .../uploads/ 的 CDN 图（任务缩略图是 .../tasks/，绝不能算）
   */
  function imageSlotFilled() {
    var ins = Array.prototype.slice.call(document.querySelectorAll('input[type="file"]'));
    for (var i = 0; i < ins.length; i++) if (ins[i].files && ins[i].files.length) return true;
    return !!document.querySelector('img[src^="blob:"],img[src^="data:"],img[src*="/uploads/"]');
  }

  /* 任务详情（带鉴权）；直接用 fetch 不带 Authorization 会 401 MissingToken */
  async function taskDetail(taskId) {
    var r = await api("/meshyd-api/web/v2/tasks/" + taskId);
    return (r.body && r.body.result) || null;
  }

  function hasTextureArtifact(d) {
    var res = (d && d.result) || {};
    var t = res.texture || {};
    if (t.modelUrl) return true;
    if (t.textureUrls && t.textureUrls.length) return true;
    return false;
  }

  function creditsFromPage() {
    var m = txt(document.body).match(/(?:我的积分|积分)\s*[^\d]{0,8}(\d+)/);
    var g = txt(document.body).match(/(\d+)\s*积分\s*.*?生成/);
    return { balance: m ? parseInt(m[1], 10) : null, cost: g ? parseInt(g[1], 10) : null };
  }

  window.automeshy = {
    version: "1.0",

    /* 登录检测：返回 {loggedIn, token, email} */
    login: async function () {
      if (!token()) return { loggedIn: false, reason: "未找到登录 token，请在浏览器里手动登录 Meshy" };
      var r = await api("/meshyd-api/web/v1/me/info");
      if (r.status !== 200 || !r.body || !r.body.result) return { loggedIn: false, reason: "会话已失效，请重新登录", raw: r };
      return { loggedIn: true, email: r.body.result.email, nickname: r.body.result.nickname, tier: r.body.result.tier };
    },

    /* 积分：返回原始接口 + 页面数字 + 可用余额 */
    credits: async function () {
      var r = await api("/meshyd-api/web/v1/me/credits");
      var res = (r.body && r.body.result) || {};
      return {
        status: r.status,
        raw: res,
        page: creditsFromPage(),
        available: (typeof res.agentSpendableBalance === "number" ? res.agentSpendableBalance :
                    typeof res.freeCreditBalance === "number" ? res.freeCreditBalance :
                    typeof res.creditBalance === "number" ? res.creditBalance : null)
      };
    },

    /* 积分闸门：不足时返回 ok=false + 可直接展示给用户的中文提示，不点击生成 */
    checkCredits: async function (required) {
      required = required || 30;
      var c = await window.automeshy.credits();
      var ok = c.available !== null && c.available >= required;
      return {
        ok: ok,
        available: c.available,
        required: required,
        raw: c.raw,
        message: ok
          ? "积分充足：当前 " + c.available + "，本次预计消耗 " + required + "。"
          : "积分不足，无法生成：当前 " + (c.available === null ? "未知" : c.available) +
            "，本次需要 " + required + "。请先在页面领取免费积分或升级后再试；本次未点击「生成」。"
      };
    },

    /* 当前面板快照，用于调试/让 AI 核对设置 */
    probe: function () {
      var out = { pageUrl: location.href, controls: {} };
      ["多视图", "拆分", "贴图", "姿势", "图像增强"].forEach(function (k) {
        var e = switchFor(k);
        out.controls[k] = e ? isOn(e) : null;
      });
      out.selectedTab = (function () {
        var t = first('[role="tab"]', "高细节", false);
        return t ? txt(t) + "=" + (isOn(t) || t.getAttribute("aria-selected")) : null;
      })();
      out.fileInputs = Array.prototype.slice.call(document.querySelectorAll('input[type="file"]')).map(function (i) {
        return { accept: i.accept || "", multiple: !!i.multiple, name: i.name || "", files: i.files ? i.files.length : null };
      });
      // 2026-11-17 修正：旧写法 img[src*="cdn-images"] 会被右侧任务缩略图（.../tasks/...）命中，
      // 没上传图片也报 hasImage=true。只认上传槽位自己的预览：blob:/data: 或 .../uploads/ 图。
      out.hasImage = !!imageSlotFilled();
      out.uploadSlotEmpty = byText("div", "点击/拖放/粘贴图像").length > 0;
      out.text = panelText();
      return out;
    },

    /*
     * 按配置设置面板。cfg 见 config/default-settings.json 的 settings 字段。
     * 关键：pose 不点（clickForbidden=true 或 enabled=false 时跳过），避免触发会员弹窗。
     */
    applySettings: function (cfg) {
      cfg = cfg || {};
      var r = { changed: [], unchanged: [], skipped: [], missing: [], unknown: [] };

      if (cfg.tab) setRadio("模式页签", cfg.tab, r);
      // 多视图 = 会员项：点它会弹「订阅以使用多视角」（2026-11-17 实测），一律不点
      if (cfg.multiView != null) {
        if (cfg.multiView && typeof cfg.multiView === "object") {
          if (cfg.multiView.enabled === true && cfg.multiView.clickForbidden !== true) {
            setSwitch("多视图", true, r, false);
          } else {
            r.skipped.push("多视图（" + (cfg.multiView.reason || "会员项，按配置不点击") + "）");
          }
        } else if (cfg.multiView === true) {
          r.skipped.push("多视图（会员项：点击会弹「订阅以使用多视角」，未点击）");
        } else {
          r.skipped.push("多视图（保持关闭，未点击）");
        }
      }
      if (cfg.resolution) setRadio("分辨率", cfg.resolution, r);
      if (cfg.split != null) setSwitch("拆分", !!cfg.split, r, false);
      if (cfg.texture != null) setSwitch("贴图", !!cfg.texture, r, false);
      if (cfg.model) setRadio("模型", cfg.model, r);
      if (cfg.textureResolution) setRadio("贴图分辨率", cfg.textureResolution, r);

      // === 姿势：默认绝不点击 ===
      var pose = cfg.pose || {};
      if (pose.clickForbidden || pose.enabled === false || pose.enabled == null) {
        r.skipped.push("姿势（按用户要求不点击，点击会要求开会员）");
      } else {
        setSwitch("姿势", true, r, false);
      }

      if (cfg.imageEnhance != null) setSwitch("图像增强", !!cfg.imageEnhance, r, false);
      if (cfg.license) setRadio("许可证", cfg.license, r);
      return r;
    },

    /* 供 upload_file 之外的小图兜底：用 base64 dataURL 直接塞进 file input */
    injectImageDataURL: function (dataUrl, fileName) {
      var input = document.querySelector('input[type="file"]');
      if (!input) return { ok: false, reason: "页面没有 file input" };
      try {
        var parts = dataUrl.split(",");
        var mime = (parts[0].match(/data:([^;]+)/) || [])[1] || "image/png";
        var bin = atob(parts[1]);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        var file = new File([arr], fileName || "input.png", { type: mime });
        var dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, name: file.name, size: file.size };
      } catch (e) {
        return { ok: false, reason: String(e) };
      }
    },

    /* 找上传区/生成按钮，给 MCP 的 snapshot uid 兜底 */
    elements: function () {
      var gen = first("button", "生成", true) || first("button", "生成", false);
      var ins = document.querySelector('input[type="file"]');
      return {
        generate: gen ? { text: txt(gen), rect: gen.getBoundingClientRect().toJSON() } : null,
        fileInput: ins ? ins.outerHTML.slice(0, 220) : null
      };
    },

    /* 点击生成。前置积分检查，失败时返回 {ok:false, message}，不点击。 */
    generate: async function (opts) {
      opts = opts || {};
      var gate = await window.automeshy.checkCredits(opts.creditsRequired || 30);
      if (!gate.ok) return { ok: false, stage: "credits", message: gate.message, credits: gate };
      var p = window.automeshy.probe();
      if (!p.hasImage && !opts.force) {
        return { ok: false, stage: "image", message: "尚未检测到已上传的图片，请先上传图片再生成。" };
      }
      var btn = first("button", "生成", true) || first("button", "生成", false);
      if (!btn) return { ok: false, stage: "button", message: "找不到「生成」按钮。" };
      clickEl(btn);
      return { ok: true, clicked: txt(btn), credits: gate, startedAt: Date.now() };
    },

    /* 生成后轮询新任务；prevIds 是点击生成前的任务 id 列表 */
    waitTask: async function (prevIds, timeoutMs, pollMs) {
      prevIds = prevIds || [];
      timeoutMs = timeoutMs || 600000;
      pollMs = pollMs || 5000;
      var t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        var r = await api("/meshyd-api/web/v2/tasks?pageNum=1&pageSize=5&sortBy=-created_at");
        var list = (r.body && r.body.result && (r.body.result.tasks || r.body.result)) || [];
        for (var i = 0; i < list.length; i++) {
          var t = list[i];
          if (prevIds.indexOf(t.id) >= 0) continue;
          if (t.status === "FAILED" || t.status === "CANCELED") {
            return { ok: false, status: t.status, taskId: t.id, message: "生成失败：" + (t.errMsg || t.status) };
          }
          if (t.status === "SUCCEEDED") {
            return { ok: true, status: t.status, taskId: t.id, name: t.name, triangles: t.triangleCount, vertices: t.vertexCount, waitedMs: Date.now() - t0 };
          }
          if (!window.automeshy._pendingLogged) {
            window.automeshy._pendingLogged = true;
            console.log("[automeshy] 新任务进行中", t.id, t.status);
          }
        }
        await new Promise(function (res) { setTimeout(res, pollMs); });
      }
      return { ok: false, status: "TIMEOUT", message: "等待生成超时（" + Math.round(timeoutMs / 1000) + " 秒），请到页面确认任务状态。" };
    },

    taskIds: async function (n) {
      var r = await api("/meshyd-api/web/v2/tasks?pageNum=1&pageSize=" + (n || 5) + "&sortBy=-created_at");
      var list = (r.body && r.body.result && (r.body.result.tasks || r.body.result)) || [];
      return list.map(function (t) { return t.id; });
    },

    /* 任务详情（含 result.generate 白模 / result.texture 带贴图 两个分支） */
    taskDetail: async function (taskId) {
      return await taskDetail(taskId);
    },

    /* 相对 prevIds 的新任务列表 */
    newTasks: async function (prevIds, n) {
      prevIds = prevIds || [];
      var r = await api("/meshyd-api/web/v2/tasks?pageNum=1&pageSize=" + (n || 5) + "&sortBy=-created_at");
      var list = (r.body && r.body.result && (r.body.result.tasks || r.body.result)) || [];
      return list.filter(function (t) { return prevIds.indexOf(t.id) < 0; }).map(function (t) {
        return { id: t.id, status: t.status, triangles: t.triangleCount, vertices: t.vertexCount, createdAt: t.createdAt };
      });
    },

    /*
     * 等「带贴图」的任务完成。一次生成会产出两个任务：
     *   result.generate -> 白模；result.texture -> 带贴图（有 colorMap/roughness/normal）。
     * 必须取后者，否则拿到的 .blend 没有贴图。
     */
    findTexturedTask: async function (prevIds, timeoutMs, pollMs) {
      prevIds = prevIds || [];
      timeoutMs = timeoutMs || 600000;
      pollMs = pollMs || 5000;
      var t0 = Date.now();
      var seen = {};
      while (Date.now() - t0 < timeoutMs) {
        var news = await window.automeshy.newTasks(prevIds, 6);
        for (var i = 0; i < news.length; i++) {
          var t = news[i];
          if (t.status === "FAILED" || t.status === "CANCELED") {
            return { ok: false, status: t.status, taskId: t.id, message: "生成失败：" + t.status };
          }
          if (t.status !== "SUCCEEDED") { seen[t.id] = true; continue; }
          if (seen["done:" + t.id]) continue;
          seen["done:" + t.id] = true;
          var d = await taskDetail(t.id);
          if (hasTextureArtifact(d)) {
            return {
              ok: true, taskId: t.id, textured: true,
              triangles: (d && d.triangleCount) || t.triangles,
              vertices: (d && d.vertexCount) || t.vertices,
              waitedMs: Date.now() - t0
            };
          }
        }
        await new Promise(function (res) { setTimeout(res, pollMs); });
      }
      return { ok: false, status: "TIMEOUT", message: "等待带贴图任务超时（" + Math.round(timeoutMs / 1000) + " 秒），请到页面确认任务状态。" };
    },

    /* 打开生成结果：双击缩略图触发 viewer 重新加载（供 hook 捕获 GLB） */
    openTask: function (taskId) {
      var img = Array.prototype.slice.call(document.querySelectorAll("img")).find(function (im) {
        return ((im.currentSrc || im.src || "").indexOf(taskId) >= 0);
      });
      if (!img) return { ok: false, reason: "找不到任务 " + taskId + " 的缩略图" };
      var el = img.closest("div[class]") || img;
      dblClickEl(el);
      return { ok: true, taskId: taskId };
    }
  };

  return "installed";
})();
