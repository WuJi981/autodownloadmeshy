# autodownloadmeshy

给一张图片，自动在 Meshy 生成 3D 模型，并直接交付 **Blender `.blend` 工程文件**。

> ⚠️ **仅供学习参考**：本项目仅用于学习和技术交流，不保证可用性，也与 Meshy 官方无关。使用前请阅读 Meshy 的服务条款，只处理你自己账号生成的内容，后果由使用者自行承担。

这是 `meshyfreedownload` 的自动化衍生版：
原 skill 负责「把工作区里已经存在的模型抓下来」，本 skill 往前补齐了
「上传图片 → 套设置 → 生成 → 等待完成 → 抓模型 → 转 .blend」整条链路。

---

## 它能做什么

| 你提供 | 它完成 |
|---|---|
| 一张本地图片的绝对路径 | 打开 Chrome → 等你登录 → 上传图片 → 按预设设置面板 → 检查积分 → 点击生成 → 轮询任务 → 捕获模型 → 自动转 `.blend` → 渲染预览 |
| （可选）覆盖任意设置 | 例如「这次 4K 贴图」「输出到 D:\models」 |
| 什么都不用做 | 积分不够时**明确告诉你并停止**，不会偷偷点生成、不会误触会员项 |

**最终产物**：`xxx.blend`（贴图已打包，可直接打开编辑）+ `xxx_preview.png`。
中间产生的 GLB 会被自动删除，你不需要手动做格式转换。

---

## 先说清楚一件事（重要）

Meshy **没有** `.blend` 直链下载，网页端导出被服务端按套餐限制
（免费账号 `downloadableStatus: Forbidden`），官方格式列表里也没有 `.blend`。

所以内部链路是：

```
浏览器 viewer 解密模型 → 截获 GLB → Blender 无界面导入 + pack_all() → .blend
```

这一步由 `scripts/finalize_download.py` 全自动完成并清理中间文件。
**对你来说就是「直接拿到 .blend」**，但对其他 AI/开发者不要谎称 Meshy 能直接下 `.blend`。

---

## 环境要求

| 依赖 | 说明 |
|---|---|
| Chrome / Edge | 需要 `--remote-debugging-port=9222`，且进程常驻 |
| Chrome DevTools MCP | 本 skill 主要用 `mcp__chrome-devtools__*` 工具；换成 Playwright `connectOverCDP` 等 CDP 客户端也可以 |
| Blender 3.6+ | 必需。脚本用 `blender --background --python`，本机不在 PATH 也行，`finalize_download.py` 会自动探测常见路径；装在别处可以设环境变量 `BLENDER_EXE=C:\你的路径\blender.exe` |
| Node 18+ | 仅用于跑离线自检，不是运行时依赖 |
| Python 3.9+ | 用于 `verify_glb.py` / `finalize_download.py` |
| Meshy 账号 | 你自己登录，skill 不会代填账号密码或验证码 |

---

## 安装

把整个文件夹放到你的 skills 目录即可：

```
C:\Users\<你>\.agents\skills\autodownloadmeshy\
```

不需要 pip 安装任何东西，也不需要联网下载依赖。

---

## 怎么用（对 AI 说一句话就行）

```
用 autodownloadmeshy，图片是 D:\pics\example.png，输出到 E:\models\final
```

或者只给图片：

```
给我把 C:\Users\me\Desktop\statue.jpg 生成模型并下载成 blend
```

AI 会自动读 `config/default-settings.json`，执行完整流程。
如果浏览器里还没登录，它会提示你：

> 请在刚打开的 Chrome 里登录 Meshy，登录完成后告诉我一声。

你登录完说一声「好了」，它继续跑。

### 默认设置（来自 2026-11-10 用户截图）

| 项 | 值 |
|---|---|
| 模式 | 高细节 |
| 模型 | Meshy 7.1 - Flagship |
| 多视图 | **关（会员项，不点）** |
| 分辨率 | 标准 |
| 拆分 | 关 |
| 贴图 | 开（必须开，否则只有白模） |
| 模型版本 | Meshy 7 |
| 贴图分辨率 | 2K |
| **姿势** | **不点（点了要开会员）** |
| 图像增强 | 开 |
| 许可证 | CC BY 4.0 |
| 预计 | 约 2 分钟 / 30 积分 |

> ⚠️ **面板上带皇冠 👑 的都是会员项**：多视图、拆分、姿势、私有。
> **多视图和姿势是硬性禁点项**（一点就弹开通会员/订阅窗口），配置里
> `multiView.clickForbidden = true`、`pose.clickForbidden = true`，
> `applySettings()` 会跳过并记为 `skipped`。其他 AI 请不要自作主张去点，
> 也不要把「私有」许可证、8K 贴图这类付费项当成默认值。

改设置：编辑 `config/default-settings.json`，或在对话里直接说「这次用 4K」。

---

## 积分不够会怎样

生成前会调用 `/meshyd-api/web/v1/me/credits` 检查余额。不足时输出：

```
积分不足，无法生成：当前 10，本次需要 30。
请先在页面领取免费积分或升级后再试；本次未点击「生成」。
```

然后**立即停止**——不会点击生成、不会重试、不会动任何会员开关。
`selftest_automeshy.mjs` 里有针对这条的断言。

---

## 目录结构

```
autodownloadmeshy/
├── SKILL.md                         # 给 AI 的完整工作流（必读）
├── readme.md                        # 本文件
├── config/
│   └── default-settings.json        # 默认面板设置 / 积分 / 输出 / 运行时选项
├── references/
│   ├── run-notes-2026-11-17.md       # 首跑实战踩坑记录（12 个坑 + 基线数据）
│   ├── panel-settings.md            # 面板控件与截图对照、禁点项说明
│   └── api-notes.md                 # 接口、积分字段、下载限制
└── scripts/
    ├── cdp_driver.mjs               # ★ CDP 直连驱动：start/inject/login/upload/settings/generate/wait/capture/blend/shot
    ├── chrome_debug.ps1             # 旧版启动脚本（会被后台任务回收，改用 cdp_driver start）
    ├── automeshy.js                 # 核心：登录检测 / 设置 / 上传 / 积分闸门 / 生成 / 轮询 / 打开任务
    ├── meshyfree_hook.js            # 截获 viewer 解密后的 GLB
    ├── meshy_api.js                 # 页面内 API 封装
    ├── finalize_download.py         # 一步到位：GLB → .blend + 预览 + 清理
    ├── verify_glb.py                # GLB 结构校验
    ├── glb_to_blend.py              # Blender 导入并打包贴图
    ├── render_blend_preview.py      # 从 .blend 渲染验证图
    ├── selftest_automeshy.mjs       # 离线自检：禁点项、积分闸门、hasImage 判定
    └── selftest_hook.mjs            # 离线自检：Worker 捕获
```

---

## 一条命令跑一步（推荐）

`scripts/cdp_driver.mjs` 把首次实战踩的坑都固化进去了（脱离任务树启动 Chrome、中文路径
自动复制、真实鼠标事件点开关、只挑带贴图的任务、下载目录固定）。

```bash
# 把 <你> 换成你的 Windows 用户名
S="C:\Users\<你>\.agents\skills\autodownloadmeshy\scripts"
node "$S\cdp_driver.mjs" start
node "$S\cdp_driver.mjs" inject
node "$S\cdp_driver.mjs" login --timeout=600      # 等你自己登录
node "$S\cdp_driver.mjs" upload "D:\pics\a.png"
node "$S\cdp_driver.mjs" settings
node "$S\cdp_driver.mjs" generate --credits=30
node "$S\cdp_driver.mjs" wait --timeout=900
node "$S\cdp_driver.mjs" capture
node "$S\cdp_driver.mjs" blend "<GLB路径>" "E:\models\out" "MyModel_01"
```

`settings` 会拒绝继续如果贴图没打开；`wait` 只会返回带贴图那个任务；
`capture` 会把 GLB 落到 `~/Downloads/autodownloadmeshy/`。

---

## 给其他 AI 的最小调用序列

```js
// 1) 页面里注入 automeshy.js + meshyfree_hook.js（最好用 initScript 在文档创建前）
// 2) 等登录
await automeshy.login();

// 3) 上传图片（CDP DOM.setFileInputFiles；非 ASCII 路径先复制成 ASCII 名）
// 4) 套设置：贴图必须先开；多视图/姿势绝不点
automeshy.applySettings(cfg.settings);        // skipped 必须含「多视图」「姿势」

// 5) 积分闸门 + 生成
const prevIds = await automeshy.taskIds(10);
const g = await automeshy.generate({ creditsRequired: 30 });
if (!g.ok) { /* 把 g.message 告诉用户并 return */ }

// 6) 等「带贴图」任务（不是 waitTask 的第一个新任务）
const t = await automeshy.findTexturedTask(prevIds, 600000, 5000);
if (t.ok) automeshy.openTask(t.taskId);

// 7) 捕获（先设好下载目录）
await new Promise(r => setTimeout(r, 10000));
meshyfree.meta();                            // 核对三角面数
meshyfree.saveGlb('AutoMeshy_001.glb');
```

```bash
# 8) 自动转 .blend（用户无需操作）
python scripts/finalize_download.py "~/Downloads/AutoMeshy_001.glb" "<输出目录>" --name AutoMeshy_001
```

---

## 自检（不联网、不打开浏览器）

```bash
node scripts/selftest_automeshy.mjs
node scripts/selftest_hook.mjs
```

预期全部 `PASS`。特别是这两条：

- `姿势开关点击次数为 0`
- `积分不足未点击生成`

---

## 常见问题

**Q：为什么还要经过 GLB，不能直接下 .blend？**
A：Meshy 不提供 .blend 导出。内部转换已全自动化，你只看得到最终 `.blend`。

**Q：点了姿势会怎样？**
A：弹出开通会员。所以本 skill 把它设为禁点项，配置里也写死了。

**Q：页面上显示的积分看起来够，为什么提示积分不足？**
A：页面不同位置显示的是不同口径的余额（免费积分 /  Agent 积分 / 套餐额度）。
脚本取 `agentSpendableBalance`，并把接口原始 JSON 一并返回，方便核对真实可用值。

**Q：生成完没抓到 GLB？**
A：Meshy 会复用启动时创建的解密 Worker，钩子必须**在模型加载前**用 `initScript` 注入；
晚了就刷新页面重新注入，再 `openTask()` 一次。

**Q：.blend 打开是灰的？**
A：Blender 默认实体模式不显示贴图，按 `Z` 切到「材质预览」。

**Q：可以批量吗？**
A：可以。对每张图片重复步骤 3–8，注意每次 `prevIds` 取当次生成前的最新任务列表。

**Q：点「多视图」弹出了订阅窗口怎么办？**
A：那是会员功能，别点。`Escape` 关不掉，点遮罩空白处（左上角一点）即可关闭。
配置里已改为 `multiView.clickForbidden: true`，`applySettings()` 会跳过它。

**Q：生成完是白模，没有贴图？**
A：两个可能：① 面板「贴图」没打开（默认就是关的，开完估算从 20 涨到 30 积分）；
② 抓错了任务——一次生成会出「白模 + 带贴图」两个任务，必须取 `result.texture` 那个，
用 `automeshy.findTexturedTask()` 而不是 `waitTask()`。

**Q：上传一直提示「图片上传失败，请再试一次」？**
A：多半是图片路径带中文，命令行转码把路径搞乱了。复制成 ASCII 文件名再传，
或者直接用 `cdp_driver.mjs upload`（自动处理）。

**Q：Chrome 老是 `ECONNREFUSED 9222`？**
A：用后台任务 `Start-Process` 起的 Chrome 会被进程树回收。改用
`node scripts/cdp_driver.mjs start`（WMI 脱离式启动）。

**Q：为什么日志里看不到我传的图片名？**
A：口述的文件名可能和磁盘上的实际文件名不一致。
给路径前先列目录核对文件名。

---

## 边界

- 只处理**用户自己账号**、**用户主动提供**的图片与模型。
- 不伪造请求、不修改积分、不伪造会员状态。多视图、姿势、8K 贴图、私有许可证等付费项一律不点，跳过并告知用户，需要时提示先开通会员。
- 登录凭据由用户本人输入，skill 不接触账号密码。
- **需要注意**：本 skill 会截获浏览器中已解密的 GLB。Meshy 对免费账号的网页端导出有限制（`downloadableStatus: Forbidden`），这一步实际上绕过了该限制。它不是 Meshy 官方支持的用法，使用前请自行判断是否符合 Meshy 的服务条款。
