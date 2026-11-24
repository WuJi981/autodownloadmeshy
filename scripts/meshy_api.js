/*
 * meshy_api.js
 * 在 Meshy 工作区页面内提供 window.meshyApi：复用浏览器已登录的 token 查询任务、导出状态与模型 URL。
 * 用法：evaluate_script(sourcePath=<本文件>, format="script")，返回 "installed"。
 */
(function () {
  if (window.meshyApi) return "already";

  function getCookie(name) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[.$]/g, "\\$&") + "=([^;]*)"));
    return m ? m[1] : null;
  }

  function b64ToJson(raw) {
    var txt = String(raw).replace(/^base64-/, "");
    try { txt = decodeURIComponent(txt); } catch (e) {}
    var bin = atob(txt.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(bin);
  }

  function getToken() {
    // Supabase 分片 cookie：sb-<ref>-auth-token.0 / .1
    var p0 = getCookie("sb-meshy-auth-token.0");
    var p1 = getCookie("sb-meshy-auth-token.1");
    if (p0) {
      try {
        var obj = b64ToJson((p0 || "") + (p1 || ""));
        if (obj && obj.access_token) return obj.access_token;
      } catch (e) {}
    }
    // 单段 cookie
    var single = getCookie("sb-meshy-auth-token");
    if (single) {
      try {
        var o2 = b64ToJson(single);
        if (o2 && o2.access_token) return o2.access_token;
      } catch (e) {}
    }
    // localStorage 兜底
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (/^sb-.*-auth-token$/.test(k)) {
          var v = JSON.parse(localStorage.getItem(k));
          if (v && v.access_token) return v.access_token;
          if (v && v.currentSession && v.currentSession.access_token) return v.currentSession.access_token;
        }
      }
    } catch (e) {}
    return null;
  }

  async function api(path, options) {
    options = options || {};
    var token = getToken();
    var headers = { accept: "application/json" };
    if (token) headers.authorization = "Bearer " + token;
    if (options.body) headers["content-type"] = "application/json";
    var res = await fetch(path, {
      method: options.method || "GET",
      headers: headers,
      credentials: "include",
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    var text = await res.text();
    var json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, body: json !== null ? json : text.slice(0, 2000) };
  }

  window.meshyApi = {
    token: function () {
      var t = getToken();
      return t ? { ok: true, length: t.length, prefix: t.slice(0, 12) } : { ok: false };
    },
    raw: api,
    tasks: async function (limit) {
      var q = "/meshyd-api/web/v2/tasks?pageNum=1&pageSize=" + (limit || 20) + "&sortBy=-created_at";
      var r = await api(q);
      if (r.status !== 200 || !r.body || !r.body.result) return r;
      var list = r.body.result.tasks || r.body.result;
      return (list || []).map(function (t) {
        return {
          id: t.id,
          name: t.name,
          status: t.status,
          phase: t.phase,
          createdAt: t.createdAt,
          triangles: t.triangleCount,
          vertices: t.vertexCount
        };
      });
    },
    task: async function (id) {
      var r = await api("/meshyd-api/web/v2/tasks/" + id);
      if (r.status !== 200 || !r.body || !r.body.result) return r;
      var t = r.body.result;
      var tex = (t.result && t.result.texture) || {};
      var urls = (tex.textureUrls && tex.textureUrls[0]) || {};
      return {
        id: t.id,
        name: t.name,
        status: t.status,
        triangles: t.triangleCount,
        vertices: t.vertexCount,
        license: t.license,
        modelMeshyUrl: tex.modelUrl || null,
        quadJsonUrl: tex.quadJsonUrl || null,
        textureUrls: urls,
        previewUrl: (t.result && t.result.previewUrl) || null,
        previewWatermarkUrl: (t.result && t.result.previewLogoUrl) || null,
        printability: t.printability || null
      };
    },
    status: async function (id) {
      var r = await api("/meshyd-api/web/v2/tasks/" + id + "/downloadable-status?type=Task");
      return r;
    },
    credits: async function () {
      return api("/meshyd-api/web/v1/me/credits");
    }
  };

  return "installed";
})();
