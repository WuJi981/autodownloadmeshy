/*
 * meshyfree_hook.js
 * 注入到 Meshy 工作区页面（必须在打开模型之前执行），用于捕获 viewer 解密后的 GLB。
 * 用法：evaluate_script(sourcePath=<本文件>, format="script") 或在 CDP 里 Runtime.evaluate 本文件全文。
 * 成功返回 "installed"；页面会获得 window.meshyfree。
 */
(function () {
  if (window.__meshyfreeInstalled) return "already";
  window.__meshyfreeInstalled = true;

  var state = { items: [], blobs: [], cdn: [], errors: [] };
  var NativeWorker = window.Worker;

  function magicOf(buf) {
    try {
      var n = Math.min(12, buf.byteLength);
      var u8 = new Uint8Array(buf, 0, n);
      var s = "";
      for (var i = 0; i < n; i++) s += String.fromCharCode(u8[i]);
      return s;
    } catch (e) {
      return "";
    }
  }

  function remember(buf, label) {
    try {
      if (!buf || buf.byteLength < 1024) return;
      state.items.push({ label: label, size: buf.byteLength, magic: magicOf(buf), ts: Date.now(), buf: buf });
    } catch (e) {
      state.errors.push(label + ": " + e);
    }
  }

  function scan(data, label) {
    try {
      if (data instanceof ArrayBuffer) return remember(data, label);
      if (ArrayBuffer.isView(data)) return remember(data.buffer, label);
      if (typeof Blob !== "undefined" && data instanceof Blob) {
        data.arrayBuffer().then(function (b) { remember(b, label + ":blob"); }).catch(function () {});
        return;
      }
      if (data && typeof data === "object") {
        for (var k in data) {
          var v = data[k];
          if (v instanceof ArrayBuffer) remember(v, label + "." + k);
          else if (ArrayBuffer.isView(v)) remember(v.buffer, label + "." + k);
        }
      }
    } catch (e) {
      state.errors.push(label + ": " + e);
    }
  }

  function wrapWorker(w) {
    try {
      var add = w.addEventListener.bind(w);
      var remove = w.removeEventListener.bind(w);
      w.addEventListener = function (type, fn, opt) {
        if (type === "message" && typeof fn === "function") {
          var wrapped = function (ev) {
            scan(ev && ev.data, "worker.onmessage");
            return fn.apply(this, arguments);
          };
          wrapped.__meshyOriginal = fn;
          return add(type, wrapped, opt);
        }
        return add(type, fn, opt);
      };
      w.removeEventListener = function (type, fn, opt) {
        if (type === "message" && fn && fn.__meshyOriginal) return remove(type, fn.__meshyOriginal, opt);
        return remove(type, fn, opt);
      };
      var onmsg = null;
      var onmsgWrapped = null;
      Object.defineProperty(w, "onmessage", {
        configurable: true,
        get: function () { return onmsg; },
        set: function (fn) {
          if (onmsgWrapped) {
            try { remove("message", onmsgWrapped); } catch (e) {}
            onmsgWrapped = null;
          }
          onmsg = fn;
          if (typeof fn === "function") {
            onmsgWrapped = function (ev) {
              scan(ev && ev.data, "worker.onmessage");
              return fn.call(this, ev);
            };
            add("message", onmsgWrapped);
          }
        }
      });
    } catch (e) {
      state.errors.push("wrapWorker: " + e);
    }
  }

  if (NativeWorker) {
    function HookedWorker(url, opts) {
      var w = new NativeWorker(url, opts);
      try { state.workers = (state.workers || 0) + 1; } catch (e) {}
      wrapWorker(w);
      return w;
    }
    HookedWorker.prototype = NativeWorker.prototype;
    try { window.Worker = HookedWorker; } catch (e) { state.errors.push("Worker replace: " + e); }

    try {
      var nativePost = NativeWorker.prototype.postMessage;
      NativeWorker.prototype.postMessage = function (msg) {
        scan(msg, "worker.postMessage");
        return nativePost.apply(this, arguments);
      };
    } catch (e) {
      state.errors.push("postMessage patch: " + e);
    }
  }

  try {
    var nativeCreate = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      try {
        if (obj && typeof obj === "object" && typeof obj.size === "number") {
          state.blobs.push({ type: obj.type || "", size: obj.size, ts: Date.now() });
        }
      } catch (e) {}
      return nativeCreate.apply(URL, arguments);
    };
  } catch (e) {
    state.errors.push("createObjectURL patch: " + e);
  }

  try {
    if (window.fetch) {
      var nativeFetch = window.fetch;
      window.fetch = function (input) {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        if (/\.(meshy|glb|gltf|bin)(\?|$)/i.test(url) || /(cdn-models|cdn-images|assets\.meshy)/i.test(url)) {
          state.cdn.push({ url: url.slice(0, 500), ts: Date.now() });
        }
        return nativeFetch.apply(this, arguments);
      };
    }
  } catch (e) {
    state.errors.push("fetch patch: " + e);
  }

  function parseGlb(buf) {
    var dv = new DataView(buf);
    var magic = dv.getUint32(0, true);
    if (magic !== 0x46546c67) return null;
    var version = dv.getUint32(4, true);
    var total = dv.getUint32(8, true);
    var len0 = dv.getUint32(12, true);
    var type0 = dv.getUint32(16, true);
    if (type0 !== 0x4e4f534a) return null;
    var jsonText = new TextDecoder("utf-8").decode(new Uint8Array(buf, 20, len0));
    var json = JSON.parse(jsonText);
    var triangles = 0;
    (json.meshes || []).forEach(function (m) {
      (m.primitives || []).forEach(function (p) {
        if (p.indices != null && json.accessors && json.accessors[p.indices]) {
          triangles += Math.floor(json.accessors[p.indices].count / 3);
        }
      });
    });
    return {
      version: version,
      declaredLength: total,
      actualLength: buf.byteLength,
      generator: json.asset && json.asset.generator,
      meshes: (json.meshes || []).length,
      nodes: (json.nodes || []).length,
      materials: (json.materials || []).length,
      images: (json.images || []).map(function (i) { return i.mimeType || "unknown"; }),
      textures: (json.textures || []).length,
      triangles: triangles,
      extensionsUsed: json.extensionsUsed || [],
      extensionsRequired: json.extensionsRequired || []
    };
  }

  function latestGlb() {
    var found = null;
    for (var i = 0; i < state.items.length; i++) {
      if (String(state.items[i].magic).indexOf("glTF") === 0) found = state.items[i];
    }
    return found;
  }

  window.meshyfree = {
    list: function () {
      return state.items.map(function (i) {
        return { label: i.label, size: i.size, magic: JSON.stringify(i.magic).slice(1, -1) };
      });
    },
    glb: function () {
      var it = latestGlb();
      return it ? it.buf : null;
    },
    meta: function () {
      var it = latestGlb();
      if (!it) return { error: "no GLB captured yet" };
      try {
        return parseGlb(it.buf);
      } catch (e) {
        return { error: String(e) };
      }
    },
    saveGlb: function (name) {
      var it = latestGlb();
      if (!it) return { ok: false, reason: "no GLB captured yet" };
      var fileName = name || ("meshy-" + Date.now() + ".glb");
      if (!/\.glb$/i.test(fileName)) fileName += ".glb";
      var blob = new Blob([it.buf], { type: "model/gltf-binary" });
      var a = document.createElement("a");
      var href = URL.createObjectURL(blob);
      a.href = href;
      a.download = fileName;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        a.remove();
        URL.revokeObjectURL(href);
      }, 10000);
      return { ok: true, name: fileName, size: blob.size };
    },
    saveItem: function (index, name) {
      var it = state.items[index];
      if (!it) return { ok: false, reason: "index out of range" };
      var blob = new Blob([it.buf], { type: "application/octet-stream" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name || ("capture-" + index + ".bin");
      document.body.appendChild(a);
      a.click();
      return { ok: true, size: blob.size };
    },
    blobUrls: function () { return state.blobs.slice(-50); },
    cdn: function () { return state.cdn.slice(-50); },
    errors: function () { return state.errors.slice(-20); },
    clear: function () {
      state.items.length = 0;
      state.blobs.length = 0;
      state.cdn.length = 0;
      state.errors.length = 0;
      return "cleared";
    }
  };

  return "installed";
})();
