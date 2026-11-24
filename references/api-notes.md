# Meshy 接口与判定笔记（autodownloadmeshy）

实测于 `meshy.cn`，2026-11-09/10。字段可能随版本变化，脚本已做容错。

## 认证

Supabase 会话，token 在 cookie `sb-<ref>-auth-token.0` / `.1`（分片，值带 `base64-` 前缀）。
拼接 → 去前缀 → base64 解码 → `JSON.parse` → `access_token`。
/automeshy.js 的 `token()` 同时兼容 localStorage 里的 `sb-*-auth-token`。

请求头需要 `authorization: Bearer <access_token>`，缺失返回
`{"code":"MissingToken","result":"Missing access token"}`。

## 本 skill 用到的接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/meshyd-api/web/v1/me/info` | 登录检测（email / tier） |
| GET | `/meshyd-api/web/v1/me/credits` | **积分闸门** |
| GET | `/meshyd-api/web/v2/tasks?pageNum=1&pageSize=5&sortBy=-created_at` | 生成前后任务列表比对、轮询状态 |
| GET | `/meshyd-api/web/v2/tasks/{taskId}` | 任务详情、模型/贴图 URL、拓扑统计 |
| GET | `/meshyd-api/web/v2/tasks/{taskId}/downloadable-status?type=Task` | 官方导出授权判定 |
| PUT | `/meshyd-api/web/v2/tasks/{taskId}/open` | 打开任务 |

不存在的下载路由（实测 404）：`/v{1,2}/tasks/{id}/download`。

## 积分字段

`/me/credits` 返回示例（不同时间会变）：

```json
{
  "creditBalance": 0,
  "freeCreditBalance": 90,
  "agentSpendableBalance": 105,
  "shareCreditEarned": 15,
  "agentCreditsByPlan": { "premium": 600, "pro": 200, "starter": 50 }
}
```

- 页面上「我的积分」显示的数字与 `agentSpendableBalance` 一致（曾实测 105 / 76）。
- `automeshy.credits()` 返回原始 `result` + 页面抓取的 `balance/cost` + `available`
  （优先 `agentSpendableBalance`，其次 `freeCreditBalance`、`creditBalance`）。
- 一次「高细节 + 贴图 + 2K」生成，面板显示 **30 积分 / 约 2 分钟**。
- `checkCredits(required)` 在 `available < required` 时返回 `ok:false` 与中文提示，
  `generate()` 会直接返回 `stage:"credits"`，**不点击生成按钮**。

不同口径余额可能不一致，遇到争议时把 `raw` 原始 JSON 一并发给用户核对。

## 任务轮询

`waitTask(prevIds, timeoutMs, pollMs)` 逻辑：

1. 生成前取 `taskIds(5)` 作为基线 `prevIds`。
2. 每 5 秒拉一次最近 5 个任务，跳过基线内的 id。
3. 新任务 `SUCCEEDED` → 返回 `{ok:true, taskId, triangles, vertices, waitedMs}`。
4. 新任务 `FAILED` / `CANCELED` → 返回 `{ok:false, message}`。
5. 超过 `waitTimeoutMs`（默认 10 分钟）→ `{ok:false, status:"TIMEOUT"}`。

超时后不要重复点击生成，先让用户到页面确认任务状态，避免重复扣积分。

## 导出限制

免费账号实测：

```json
{"code":"OK","result":{"count":0,"premiumQuota":0,"totalLimit":"0","downloadableStatus":"Forbidden"}}
```

- `totalLimit: "0"` + `Forbidden` → 前端下载按钮置灰。
- 访问别人的任务该接口返回 403，与「自己的任务但 200 + Forbidden」是两种情况。
- **官方格式里没有 `.blend`**，所以最终 `.blend` 必须由本 skill 内部转换产出。

## 解密与抓取

viewer 用 Web Worker + `mesh_loader.wasm` 把加密容器 `model.meshy`（魔数 `MESHY.AI`）
解密成标准 glTF 2.0 二进制，Worker 回传的 `ArrayBuffer` 就是完整 GLB（含内嵌 WebP 贴图）。
`meshyfree_hook.js` 钩住 `Worker.onmessage` / `addEventListener('message')` /
`postMessage` / `createObjectURL` / `fetch` 五处，认魔数 `glTF` 的那份。

实测一次：

| 方向 | 大小 | 魔数 |
|---|---|---|
| 主线程 → worker | 5,584,228 | `MESHY.AI` |
| worker → 主线程 | 19,085,816 | `glTF\x02\x00\x00\x00` |

GLB 由 `gltfpack 1.2` 生成，扩展含 `KHR_mesh_quantization`、
`KHR_texture_transform`、`EXT_texture_webp`；Blender 3.6+ 可直读。

## 关键时序

1. `initScript` 在文档创建前注入钩子 —— 晚注入会漏，因为 app 复用启动时创建的 Worker 且模型有缓存。
2. 单击资源卡片 = 选中，**双击** = 打开；`openTask()` 派发双击强制重新加载才能触发解密。
3. 新任务生成完成后 viewer 会自动加载，钩子已在即可捕获；若未捕获，刷新 + 重新注入 + 双击一次。
