# 面板设置对照（用户截图 2026-11-10）

截图来自 `meshy.cn/workspace` 左侧「图片生成模型」面板，两张图是同一面板的上下两段。
`config/default-settings.json` 里的值即据此填写。

## 逐项对照

| # | 控件 | 控件类型 | 截图状态 | 配置键 | 是否点击 |
|---|---|---|---|---|---|
| 1 | 高细节 / 智能拓扑 / 浮雕 | 页签 radio | 高细节 | `tab` | ✅ 点（已是默认则不点） |
| 2 | Meshy 7.1 - Flagship 最多细节，最高精度 | 下拉 combobox | 已选 | `aiModel` | ⚠️ 保留默认，通常不动 |
| 3 | 图像上传区 | file input / 拖放区 | 空 | `imagePath` | ✅ 用 `upload_file` |
| 4 | 多视图 | switch | 开 | `multiView: true` | ✅ 仅状态不符时点 |
| 5 | 分辨率：标准 / 超精细 2K / 超精细 4K | radio | 标准 | `resolution` | ✅ |
| 6 | 拆分 | switch | 关 | `split: false` | ✅ |
| 7 | 贴图 | switch | 开 | `texture: true` | ✅ |
| 8 | 模型：Meshy 7 / Meshy N1 | radio | Meshy 7 | `model` | ✅ |
| 9 | 贴图分辨率：2K / 4K / 8K | radio | 2K | `textureResolution` | ✅（4K/8K 可能需要更高套餐） |
| 10 | **姿势** + A姿势/T姿势/自定义 | switch | 开但子项灰显 | `pose.clickForbidden: true` | ❌ **绝对不点** |
| 11 | 图像增强 | switch | 开 | `imageEnhance: true` | ✅ |
| 12 | 许可证：CC BY 4.0 / 私有 | radio | CC BY 4.0 | `license` | ✅（私有为付费项，不要选） |
| 13 | 预计 2 分钟 / 30 积分 | 文本 | — | `estimatedCredits: 30` | 只读 |
| 14 | 生成 | button | 可点 | — | 仅在积分闸门通过后点 |

## 关于第 10 项「姿势」（用户 2026-11-10 明确补充）

> 「姿势这里是不需要点的 因为点了要开会员」

- 截图里「姿势」开关看起来是开着的，但下面的 A姿势 / T姿势 / 自定义 是灰显不可用状态，
  说明这是一个**付费入口**：一旦交互就会弹出开通会员。
- 因此本 skill 把它列为**硬性禁点项**：
  - `config/default-settings.json` → `settings.pose.clickForbidden = true`
  - `automeshy.applySettings()` 遇到 `clickForbidden` 或 `enabled === false` 直接 `skipped.push(...)`，不触碰 DOM
  - `selftest_automeshy.mjs` 断言「姿势开关点击次数为 0」
- 其他 AI 若自行用 `click` 工具点姿势，属于违反本 skill 约定。
- 同理，「私有」许可证、8K 贴图、超精细 4K 等也可能触发付费弹窗，默认配置里一律不启用。

## 控件定位策略（automeshy.js）

- switch：找 `[role="switch"]` 或 `input[type=checkbox]`，向上最多 4 层父节点匹配中文标签，
  用 `aria-checked` / `data-state` / `checked` 判断当前状态，只在与目标不符时点击。
- radio：在 `[role="radio"]`、`button`、`label` 里按中文文本匹配，已是选中态则不点。
- 生成按钮：精确匹配文本「生成」。
- 任务缩略图：`img` 的 `src/currentSrc` 含 taskId 时，向上找容器派发
  `mousedown → mouseup → click → click(detail=2) → dblclick`。

React 页面控件可能随版本改文案或结构；`automeshy.probe()` 会输出当前面板文本、
file input 列表与各开关状态，用于定位偏差。`applySettings()` 找不到的控件会记入
`missing`，不会静默失败——调用方应检查返回值。
