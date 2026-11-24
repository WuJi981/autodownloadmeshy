---
name: autodownloadmeshy
description: 从一张本地图片全自动生成并导出 Meshy 3D 模型，最终直接交付 Blender 的 .blend 工程文件（内含贴图，无需用户手动转换格式）。用户提供图片路径后，本 skill 用 CDP 直连（或 Chrome DevTools MCP）操作 meshy.cn 工作区：等待用户登录、自动上传图片、套用预设参数（高细节 / Meshy 7 / 2K 贴图 / 图像增强 / CC BY 4.0，且绝不点击「姿势」与「多视图」这两个会员开关）、先检查积分并在不足时明确提示用户、点击生成、轮询到「带贴图」那个任务完成、截获 viewer 解密后的 GLB、自动转换成 .blend 并渲染预览图。适用于「给一张图片帮我生成并下载模型」「自动跑 Meshy 出 blend」「积分不够就告诉我」「按固定设置出模型」等请求。
agent_created: true
---

# autodownloadmeshy

## 用途

把「给一张图片 → 在 Meshy 生成 3D 模型 → 拿到可编辑的 `.blend`」这条链路全自动跑完。
调用方只需给出**本地图片路径**，其余步骤（开浏览器、等登录、上传、设参数、查积分、生成、等待、抓取、转换、预览）由本 skill 完成。

## 关于交付格式（务必如实告知用户）

Meshy 服务端**不提供 `.blend` 直链下载**：免费账号的
`/meshyd-api/web/v2/tasks/{id}/downloadable-status` 返回 `Forbidden`，且官方导出格式列表里没有 `.blend`。
因此管线内部仍然要「截获解密后的 GLB → Blender 无界面转换」这一步，但：

- 这一步由 `scripts/finalize_download.py` **自动完成**，调用方与用户都不需要手动操作；
- 中间 GLB 默认**自动删除**（`keepGlbBackup: false`）；
- 最终用户拿到的只有 `*.blend` + `*_preview.png`。

对用户说「直接给你 .blend，不用你转格式」是准确的；**不要**声称 Meshy 能直接下载 .blend。

## 硬性规则（不可违反）

0. **走 CDP 直连，不要用 chrome-devtools MCP 托管页面。** 2026-11-17 实测：MCP 会自己起一个
   独立浏览器实例（`list_pages` 只有 `about:blank`），跟 `--remote-debugging-port=9222` 那个实例
   不是同一个，注入的钩子/登录态/页面状态全对不上。直接连 9222，用 `scripts/cdp_driver.mjs`。
1. **姿势开关绝对不点。** 点击「姿势」会弹出开通会员要求，用户明确禁止。
   `config/default-settings.json` 里 `settings.pose.clickForbidden = true`，
   `applySettings()` 会直接跳过并记为 `skipped`。也不允许通过 `click` 工具单独点它。
1b. **多视图开关同样绝对不点。** 2026-11-17 实测：点「多视图」立刻弹「订阅以使用多视角／
   订阅以解锁此功能」，属会员功能。配置里已改为 `multiView.clickForbidden = true`。
   如果用户确实要多视图，先让他开通会员，再人工改配置。
2. **积分不足不点生成。** 必须先 `automeshy.checkCredits(required)`；
   返回 `ok:false` 时把 `message` 原样输出给用户并**立即停止**，不得绕过、不得重试。
3. **只处理用户自己账号内、用户主动提供的图片。** 不伪造接口、不改积分、不伪造会员状态；付费项一律跳过。截获的只是 viewer 已解密的 GLB（免费账号导出受限时会经历这一步，详见 readme「边界」）。
4. **钩子要在模型加载前注入。** Meshy 复用启动时创建的解密 Worker，晚注入会漏掉 GLB。
5. **贴图必须先开再生成。** 面板默认「贴图」是关的，不开就直接生成只会得到白模。
   开贴图后才会出现「模型 / 贴图分辨率」子项，估算积分从 20 涨到 30。
6. **必须取「带贴图」那个任务。** 一次生成会产出两个任务：
   `result.generate`（白模）+ `result.texture`（带贴图，含 colorMap/roughness/normal）。
   用 `automeshy.findTexturedTask()` 挑，不要直接用 `waitTask()` 返回的第一个。
7. **不带 Authorization 的裸 fetch 会被拒。** `/meshyd-api/*` 需要 cookie 里的 access_token
   作为 Bearer，否则 401 `MissingToken`。用 `automeshy` 内置封装，别自己写 fetch。

## 前置条件

| 项 | 要求 |
|---|---|
| 浏览器 | Chrome/Edge，以 `--remote-debugging-port=9222` 启动，且**必须脱离任务树**（见步骤 2） |
| 控制通道 | **首选 CDP 直连**：`scripts/cdp_driver.mjs`（零依赖）；MCP 仅作备用，且要确认连的是 9222 那个实例 |
| Node | 20+（脚本用内置 `WebSocket`；`cdp_driver.mjs` 无第三方依赖） |
| 登录 | 用户需在调试实例里手动登录一次 Meshy；本 skill 会等待并检测 |
| Blender 3.6+ | 必需，用于把 GLB 转成自包含 `.blend`（贴图 `packed=True`） |
| 图片 | 本地绝对路径，`.png/.jpg/.jpeg/.webp`，≤20MB；**非 ASCII 路径要复制成 ASCII 名再传** |
| 积分 | 一次生成约 30 积分（开贴图后；不开贴图 20）；不足时按硬性规则 2 处理 |

约定：`SKILL_DIR` 指本 skill 根目录；`{pageId}` 由 `list_pages` 取得。

## 工作流

> 推荐全用 `node "$SKILL_DIR/scripts/cdp_driver.mjs" <子命令>`，每个子命令都自带本次实战的坑修正。
> 下面是等价的手工步骤，供排错时对照。

### 步骤 1：读取配置

读 `config/default-settings.json`。用户可在对话里覆盖任意字段（例如「这次用 4K 贴图」「输出到 D:\out」）。
优先使用用户给的图片路径与输出目录；`imagePath` 为空时必须向用户索要，不要瞎猜。

输出目录优先级：用户指定 > `output.outputDir` > 默认 `~/Downloads/autodownloadmeshy/`。

### 步骤 2：启动可调试浏览器并打开工作区

```bash
node "$SKILL_DIR/scripts/cdp_driver.mjs" start     # 用 WMI 脱离任务树启动，profile 存在临时目录
node "$SKILL_DIR/scripts/cdp_driver.mjs" inject    # initScript 注入 hook+automeshy 并导航
```

**坑（2026-11-17 实测）**：用后台任务 `Start-Process` 起的 Chrome，会在父任务结束、进程树被回收时
一起消失，随后所有命令 `ECONNREFUSED 9222`。`cdp_driver.mjs start` 改用
`([wmiclass]"Win32_Process").Create(...)`，进程不挂在任务上，不会再被回收。

**坑**：`chrome-devtools` MCP 会自己起一个浏览器实例，`list_pages` 只看到 `about:blank`，
跟 9222 实例不是同一个。要么不用它，要么确认 MCP 配的是 `--browserUrl=http://127.0.0.1:9222`。

验证：

```js
({ hook: !!window.meshyfree, auto: !!window.automeshy })
```

### 步骤 3：等待用户登录（不要代填账号密码）

```js
await automeshy.login()
```

返回 `loggedIn:false` 时，向用户输出提示：
「请在刚打开的 Chrome 里登录 Meshy（账号密码/邮箱验证码由你自己输入），登录完成后告诉我一声。」
然后每隔 5 秒轮询 `automeshy.login()`，最多等 10 分钟；期间不得自动提交任何凭据。

或直接 `node "$SKILL_DIR/scripts/cdp_driver.mjs" login --timeout=600`。

### 步骤 4：上传图片

主路径（`cdp_driver.mjs upload` 已封装）：用 CDP `DOM.setFileInputFiles`。

```bash
node "$SKILL_DIR/scripts/cdp_driver.mjs" upload "E:\某目录\某图.png"
```

**坑（2026-11-17 实测）**：中文路径经 PowerShell/命令行传参会变成乱码，文件根本没被读到，
页面报「图片上传失败，请再试一次」。驱动脚本会自动把非 ASCII 路径复制成
`%TEMP%/automeshy-cdp/upload_xxx.png` 再传。

**坑**：`probe().hasImage` 旧实现匹配 `img[src*="cdn-images"]`，会被右侧任务缩略图
（`.../tasks/...`）命中，没上传也报成功。现已改为只认槽位里的 `blob:` / `data:` /
`.../uploads/` 图，并额外返回 `uploadSlotEmpty`（占位文案「点击/拖放/粘贴图像」是否还在）。

确认：`automeshy.probe().hasImage === true` **且** `uploadSlotEmpty === false`。

```
take_snapshot(pageId)                       // 找到「点击/拖放/粘贴图像」区域或 file input 的 uid
mcp__chrome-devtools__upload_file({
  pageId: {pageId},
  uid: "<上传区或 file input 的 uid>",
  filePaths: ["<用户给的图片绝对路径>"]
})
```

兜底（小图、或找不到 uid 时）：把图片读成 base64 dataURL，调用
`automeshy.injectImageDataURL(dataUrl, "input.png")`。
文件 >2MB 时不要走 base64，避免单次工具调用过大。

确认：`automeshy.probe().hasImage === true` 且 `uploadSlotEmpty === false`。

### 步骤 5：套用设置

```bash
node "$SKILL_DIR/scripts/cdp_driver.mjs" settings
```

等价手工调用：`automeshy.applySettings(config.settings)`。

- **「贴图」必须先打开**（默认是关的）。开完才会出现「模型 / 贴图分辨率 2K」子项，
  估算积分从 20 变 30。合成 `click` 事件对这类 shadcn 开关可能无效，
  `cdp_driver.mjs settings` 用的是 CDP 真实鼠标事件。
- **「多视图」「姿势」一律不点**（两个会员项）。返回值 `skipped` 里必须有它们；
  `changed` 里不得出现。
- 可用 `automeshy.probe()` 复核面板状态与页面上的积分数字。

对照用户截图（2026-11-10）的默认设置：`references/panel-settings.md`。

### 步骤 6：积分闸门 + 生成

```bash
node "$SKILL_DIR/scripts/cdp_driver.mjs" generate --credits=30
```

等价手工调用：

```js
const prevIds = await automeshy.taskIds(10);
const g = await automeshy.generate({ creditsRequired: config.generation.creditsRequired });
```

- `g.ok === false && g.stage === "credits"` → **把 `g.message` 原样输出给用户并终止**，
  例如：「积分不足，无法生成：当前 10，本次需要 30。请先在页面领取免费积分或升级后再试；本次未点击『生成』。」
- `g.stage === "image"` → 提示用户图片没上传成功，回到步骤 4。
- `g.ok === true` → 已点击生成，记录 `g.startedAt` 与 `prevIds`。

### 步骤 7：等「带贴图」的任务并打开结果

```bash
node "$SKILL_DIR/scripts/cdp_driver.mjs" wait --timeout=900
```

```js
const t = await automeshy.findTexturedTask(prevIds, 600000, 5000);
// { ok:true, taskId, textured:true, triangles, vertices }
```

**坑（2026-11-17 实测）**：一次生成会产出**两个任务**，三角面数一样但顶点数不同：
`result.generate`（白模）+ `result.texture`（带贴图）。用 `waitTask()` 抓到的可能是白模，
最后 `.blend` 就没有贴图。判定标准：任务详情里 `result.texture.modelUrl` 或
`result.texture.textureUrls` 非空。

拿到 `t.taskId` 后：

```js
automeshy.openTask(t.taskId)   // 双击缩略图，强制 viewer 重新加载
await new Promise(r => setTimeout(r, 10000));
const list = meshyfree.list();      // 期望出现 magic 以 "glTF" 开头的条目
const meta = meshyfree.meta();      // 三角面数应与 t.triangles 一致
meshyfree.saveGlb('AutoMeshy_<时间戳>.glb');   // 落到 Chrome 下载目录
```

若 `meshyfree.list()` 为空：刷新页面并用 `initScript` 重新注入钩子，再 `openTask()` 一次。

**坑**：`meshyfree.saveGlb` 靠浏览器下载落盘，必须先
`Browser.setDownloadBehavior({ behavior:"allow", downloadPath:<目录> })`，否则找不到文件。
`cdp_driver.mjs capture` 已处理，并把路径写进状态文件。

### 步骤 8：自动产出 `.blend`（用户无需转换格式）

```bash
node "$SKILL_DIR/scripts/cdp_driver.mjs" blend "<下载目录>/AutoMeshy_<时间戳>.glb" "<输出目录>" "AutoMeshy_<时间戳>"
```

或直接：

```bash
python "$SKILL_DIR/scripts/finalize_download.py" \
    "<下载目录>/AutoMeshy_<时间戳>.glb" "<输出目录>" \
    --name "AutoMeshy_<时间戳>"
```

脚本依次：校验 GLB → Blender 导入并 `pack_all()` → 渲染预览 → 删除中间 GLB。
日志中必须看到每个 `IMG: ... packed=True`；出现 `packed=False` 视为失败并保留 GLB 供排查。

需要保留 GLB 作备份时加 `--keep-glb`；不要预览时加 `--no-preview`。

**已验证可导入的形态（2026-11-17）**：gltfpack 1.2 压缩 + `KHR_mesh_quantization` +
`EXT_texture_webp`，3 张 2048×2048 webp 贴图，813,132 面 / 442,977 顶点，
Blender 侧 `packed=True`，30.8MB `.blend`。

## 交付

向用户报告：

1. `*.blend` 绝对路径与大小（**主交付**）
2. `*_preview.png` 绝对路径
3. 任务 ID、生成耗时、三角面/顶点数、积分消耗
4. 明确说明「已自动转好 .blend，不需要你再做格式转换」

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `ECONNREFUSED 9222` | Chrome 没起，或被父任务的进程树回收 | `node scripts/cdp_driver.mjs start`（WMI 脱离任务树启动）；不要再用后台 `Start-Process` |
| MCP `list_pages` 只有 `about:blank` | MCP 起的是另一个独立浏览器实例 | 放弃 MCP，走 `cdp_driver.mjs`；或把 MCP 指向 `--browserUrl=http://127.0.0.1:9222` |
| 页面提示「图片上传失败，请再试一次」 | 中文/非 ASCII 图片路径被命令行转码，文件没读到 | 复制成 ASCII 名再传（`cdp_driver.mjs upload` 自动处理） |
| `probe().hasImage` 为 false | 图片没进槽位 / 上传区不对 | 先看 `uploadSlotEmpty`；换 `input[type=file]` 节点重传，或用 `injectImageDataURL` |
| `hasImage` 为 true 但面板还是空的 | 旧版假阳性：命中了右侧任务缩略图 | 已修为只认 `blob:`/`data:`/`.../uploads/`；再核对 `uploadSlotEmpty` |
| 点「多视图」弹出「订阅以使用多视角」 | 会员功能 | 立刻关弹窗（Esc + 点遮罩），不要再点；配置里已设为禁点 |
| 出现「开会员」弹窗 | 误点了姿势/多视图/私有许可证等付费项 | 关闭弹窗，核对 `skipped`，这两个开关必须跳过 |
| 生成出来是白模、`.blend` 没贴图 | 「贴图」没开，或抓到了 `result.generate` 白模任务 | 先开贴图再生成；用 `findTexturedTask()` 取 `result.texture` 那个任务 |
| 一次生成冒出两个新任务 | 白模 + 带贴图各一个，面数相同、顶点数不同 | 用任务详情 `result.texture.modelUrl` 判定，别用面数猜 |
| `/meshyd-api` 返回 401 `MissingToken` | 裸 fetch 没带 `Authorization: Bearer <access_token>` | 用 `automeshy` 内置封装，别自己写 fetch |
| 点了开关但状态没变 | shadcn 开关不认合成 `dispatchEvent` 点击 | 改用 CDP `Input.dispatchMouseEvent` 真实鼠标事件（`cdp_driver.mjs settings`） |
| `saveGlb` 成功但找不到文件 | 没设下载目录 | 先 `Browser.setDownloadBehavior`，`downloadPath` 指到固定目录 |
| `checkCredits` 返回不足 | 积分不够 | 原样输出提示并停止，不得点击生成 |
| 生成按钮点了但没新任务 | 页面校验未通过 | 检查图片格式/大小、面板红字提示 |
| `waitTask` / `findTexturedTask` 超时 | 队列慢或任务失败 | 输出任务状态，让用户到页面确认，不要重复点击生成 |
| `meshyfree.list()` 为空 | 钩子晚注入 / 模型被缓存 | `initScript` 重新注入并刷新，再 `openTask()` |
| `.blend` 打开偏灰 | 实体模式不显示贴图 | 按 `Z` 切「材质预览」 |

## 自检

```bash
node "$SKILL_DIR/scripts/selftest_automeshy.mjs"   # 姿势/多视图跳过、积分闸门、不误点生成、hasImage 判定
node "$SKILL_DIR/scripts/selftest_hook.mjs"        # Worker 捕获与 GLB 解析
```

## 参考

- `readme.md` —— 面向其他用户/其他 AI 的安装与使用说明
- `references/run-notes-2026-11-17.md` —— **实战踩坑记录（首跑全流程，含 12 个坑与实测数据）**
- `references/panel-settings.md` —— 面板控件与截图设置对照
- `references/api-notes.md` —— 接口、积分字段、判定逻辑
