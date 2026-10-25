# dsh-token-usage · Token 用量面板

给 DeepSeek Harness Desktop 用的模型 Tokens 消耗统计插件。左侧栏「新会话」下方新增
**Token 用量** 入口，主面板提供：

- **热力消耗图**：按自然月对齐的 12 个月窗口，每日 / 每周 / 累计三种口径，悬停看单格 tokens；
- **数据折线图**：每日 Token 趋势（按模型分线，悬停显示日期、各模型与合计）；
- **模型消耗百分比图**：环形占比 + 列表（tokens、百分比），同名模型自动标注供应商。

数据全部来自 DSH 本机 Session 日志，**不联网、不上报、不改动会话内容**。

> A token-usage dashboard plugin for DeepSeek Harness Desktop: activity heatmap, daily
> trend line chart and per-model share donut, folded from the Session logs the harness
> already records. See [English install guide](#english) below.

---

## 目录

- [功能](#功能)
- [界面说明](#界面说明)
- [环境要求](#环境要求)
- [安装教程](#安装教程)
  - [方式一：让 DSH 里的 Agent 安装（推荐）](#方式一让-dsh-里的-agent-安装推荐)
  - [方式二：手动安装](#方式二手动安装)
  - [方式三：从 Release 安装包安装](#方式三从-release-安装包安装)
- [更新与卸载](#更新与卸载)
- [数据来源与统计口径](#数据来源与统计口径)
- [常见问题](#常见问题)
- [开发与测试](#开发与测试)
- [目录结构](#目录结构)
- [License](#license)

---

## 功能

| 模块 | 说明 |
| --- | --- |
| 总览卡 ×5 | 累计 Token 数、峰值 Token 数（单日最高）、最长聊天时长、当前连续天数、最长连续天数 |
| Token 活动热力图 | 12 个完整自然月窗口；一列 7 天（周一 → 周日）；本月未到的日期也占格显示为空；跨月整月切换；每日 / 每周 / 累计切换；悬停显示该格 tokens |
| 每日 Token 趋势图 | 按模型分线的平滑折线图 + 横向网格；悬停显示日期、各模型 tokens 与合计；占比 < 1% 的模型不单独画线，避免 0 基线噪点 |
| 时间范围 | 近 7 日 / 近 30 日，趋势图与模型占比随之切换 |
| 模型用量 | 环形占比图（中心显示区间总 tokens）+ 列表（颜色点、名称、tokens、百分比）；悬停任意一段圆环弹出该模型的名称、tokens 与占比，并高亮对应段 |
| 供应商标注 | 不同供应商提供同名模型时自动追加后缀，如 `DeepSeek V4.1 Flash · OpenCode`；唯一名称保持干净 |
| 其他 | 右下角刷新按钮、最近更新时间；深/浅色主题自适应 |

> 无第三方图表库：热力图、折线图、环形图全部为手写 SVG/CSS。

## 界面说明

页面自上而下：

1. 5 张统计卡；
2. **Token 活动** 卡片（右上角 每日 / 每周 / 累计 标签）；
3. **时间范围** 行（近 7 日 / 近 30 日）；
4. **每日 Token 趋势图** 卡片；
5. **模型用量** 卡片（环形图 + 列表）；
6. 右下角刷新按钮。

## 环境要求

- **DeepSeek Harness Desktop ≥ 0.2.0-rc.1**（使用了 `sessionPersistence` / `sessionQuery` /
  `llm` / `webServer` 等宿主服务与客户端 slots API）；
- 已在 **macOS + DSH Desktop 0.2.1-rc.3**（profile：`desktop`）上验证；
- Node.js 无需单独安装（DSH 自带运行时，`engines.node >= 22`）。

## 安装教程

> 插件以「本地 bundle」形式安装到 DSH 的 profile（默认 `desktop`）。
> 安装后**保留插件目录**，不要删除或移动（profile 通过链接引用它）。

### 方式一：让 DSH 里的 Agent 安装（推荐）

最省事，不用手动改配置：

1. 把仓库克隆到本地固定目录：

   ```bash
   git clone https://github.com/SeyanaA/dsh-token-usage.git ~/dsh-token-usage
   ```

2. 打开 DeepSeek Harness，新建一个对话，对 Agent 说：

   > 把 `/Users/你的用户名/dsh-token-usage` 作为本地插件安装到当前 profile。

   Agent 会调用插件管理工具（`plugin_manager` 的 `install_bundle`，target 为该目录的
   绝对路径），自动完成依赖链接与 bundle 注册。

3. 如果左侧栏没有立刻出现 **Token 用量**，**完全退出并重新打开** DeepSeek Harness 一次。

安装成功的标志：左侧栏「新会话」下方出现 **Token 用量**，点开后能看到统计卡片与图表。

### 方式二：手动安装

适合不想让 Agent 代操作、或需要批量部署的情况。

1. 下载仓库（git clone 或 Release zip），放到固定目录，例如：

   ```
   ~/.dsh/local-plugins/dsh-token-usage
   ```

2. 编辑你的 profile 配置文件 `~/.dsh/profiles/desktop/package.json`
   （其他 profile 把 `desktop` 换成对应名称）：

   ```jsonc
   {
     "dependencies": {
       // ……原有的依赖……
       "dsh-token-usage": "link:/Users/你的用户名/.dsh/local-plugins/dsh-token-usage"
     },
     "dsh": {
       "profile": {
         "bundles": [
           // ……原有的 bundle……
           "dsh-token-usage"
         ]
       }
     }
   }
   ```

3. 在 profile 目录安装依赖（任选其一）：

   ```bash
   cd ~/.dsh/profiles/desktop
   pnpm install
   ```

   如果本机没有 pnpm，可以用 DSH 自带的 pnpm（macOS 路径示例，版本号可能不同）：

   ```bash
   node "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs" install
   ```

4. 完全退出并重新打开 DeepSeek Harness。

### 方式三：从 Release 安装包安装

不装 git 也能安装：

1. 打开 [Releases](https://github.com/SeyanaA/dsh-token-usage/releases) 下载
   `dsh-token-usage-0.1.0.zip`（同页有 `SHA256SUMS.txt`）；
2. 解压到你想要的位置，例如 `~/dsh-token-usage`（解压后该目录里应直接是
   `package.json`、`index.js`、`client.js`）；
3. 按 [方式一](#方式一让-dsh-里的-agent-安装推荐) 或 [方式二](#方式二手动安装) 安装。

## 更新与卸载

**更新**

```bash
cd ~/dsh-token-usage
git pull
```

然后让 Agent 重新执行一次 `install_bundle`（指向同一目录），或重启 DeepSeek Harness。
客户端页面部分支持热加载，宿主机部分（Node 侧）需要重启应用。

**卸载**

- 让 Agent 调用 `plugin_manager` 的 `remove_bundle`（target：`dsh-token-usage`）；或
- 手动：删除 `~/.dsh/profiles/desktop/package.json` 中 `dependencies` 的
  `dsh-token-usage` 与 `dsh.profile.bundles` 里的 `dsh-token-usage`，然后
  `pnpm install`，重启 DSH。

## 数据来源与统计口径

数据来源全部是 DSH 已经写好的 Session 日志（`~/.dsh/sessions/...`）：

| 数据 | 来源 |
| --- | --- |
| 单步模型路由 | `request/header` 事件的 `data.header.config.{provider,model}` |
| 单步 token 用量 | `assistant/message` 事件的 `data.usage`（`totalTokens`；缺失时回退 input + output + cacheRead） |
| 会话清单 | `sessionPersistence.list()` 的 `{header, revision}` |

统计口径：

- **包含所有会话**：主会话、subagent、crew 子任务的模型调用都计入；
- **不包含**标题生成、网页搜索等辅助 LLM 调用（它们不写入主 agent 的 `assistant/message.usage`）；
- **最长聊天时长**：事件流中相邻间隔 ≤ 10 分钟的连续活动块；
- **当前连续天数**：需要今天有消耗（今天还没消耗时显示 0）；
- **模型身份**：`provider + model` 共同确定，同名模型按供应商分开统计并标注后缀；
- **实时性**：已结束会话按 revision 缓存增量更新，正在进行的会话每次刷新都重新读取。

**隐私**：全部计算在本机内存/本地缓存中完成，缓存文件为
`$DSH_HOME/dsh-token-usage/cache.json`，只含每日/每会话的 token 计数，不含任何消息正文。
插件不发起任何网络请求。

## 常见问题

**Q：左侧栏没有 Token 用量入口？**
完全退出并重启一次 DSH。仍没有的话，确认 profile 的 `dsh.profile.bundles` 里有
`dsh-token-usage`，并检查 DSH 版本 ≥ 0.2.0-rc.1。

**Q：打开了但面板空白/一直加载？**
宿主路由未加载，重启一次 DSH；确认安装目录没有被删除/移动（`link:` 依赖指向它）。

**Q：数字全是 0？**
这个 profile 还没有产生模型对话；先聊一轮再打开面板。插件统计的是当前 profile 的会话。

**Q：热力图为什么本月有些格子是空的？**
窗口按自然月对齐（例如 2025-11 → 2026-10），本月还没到的日期保留为空格子，
跨月时整体切换一个月。

**Q：为什么有些模型名字后面带「· DeepSeek」「· OpenCode」？**
同名模型来自不同供应商，追加上下文避免混淆；唯一名称不会加后缀。

**Q：支持哪些 profile？**
任意 profile 都可以，把安装步骤里的 `desktop` 换成你的 profile 名称即可。

## 开发与测试

```bash
git clone https://github.com/SeyanaA/dsh-token-usage.git
cd dsh-token-usage
node test/run.mjs
```

- `test/host-fold.mjs`：用合成日志验证折叠、按日聚合、峰值、连续天数、区间占比、
  供应商标注与自然月窗口；
- `test/client-render.mjs`：在 mock 的 ModuleLoader / React / ctx 下执行浏览器半边，
  验证侧栏入口与主面板注册、两阶段自检、三个图表渲染、首屏加载态、热力格颜色。

测试无需安装任何依赖，CI 在 GitHub Actions 上运行同一命令。

## 目录结构

```
index.js            宿主半边：日志折叠、revision 缓存、/api/dsh-token-usage/* 路由
client.js           浏览器半边：侧栏入口、主面板仪表盘（手写 SVG/CSS 图表）
cordis.patch.yml    向 profile 注入插件行的 bundle patch
package.json        插件清单（dsh.bundle / dsh.client 声明）
test/               纯 Node 冒烟测试
.github/workflows/  CI
```

## License

协作开发：[Codex](https://github.com/codex)（OpenAI 编程助手）。

[MIT](./LICENSE) © 2026 SeyanaA

---

## English

A token-usage dashboard plugin for **DeepSeek Harness Desktop** (≥ 0.2.0-rc.1). It adds a
**Token 用量** entry to the left sidebar and renders five summary cards, a month-aligned
12-month activity heatmap (daily / weekly / cumulative, hover for per-cell tokens), a daily
trend line chart per model, and a per-model share donut with provider suffixes for
same-named models.

Data is folded locally from the Session logs DSH already records; the plugin performs no
network requests and never stores message content. Only token counts are cached at
`$DSH_HOME/dsh-token-usage/cache.json`.

**Install (recommended):** clone the repository and ask the DSH agent to install the
directory as a local bundle, then restart DSH:

```bash
git clone https://github.com/SeyanaA/dsh-token-usage.git ~/dsh-token-usage
```

> “Install `/Users/you/dsh-token-usage` as a local bundle in the current profile.”

The agent calls the plugin manager (`plugin_manager` → `install_bundle`, target = absolute
path), which links the package and registers the bundle. Restart DeepSeek Harness if the
sidebar entry does not appear.

**Manual install:** add `"dsh-token-usage": "link:/abs/path/to/dsh-token-usage"` to
`~/.dsh/profiles/desktop/package.json` → `dependencies`, append `"dsh-token-usage"` to
`dsh.profile.bundles`, run `pnpm install` inside the profile directory, then restart DSH.

Verified on macOS with DSH Desktop 0.2.1-rc.3 (`desktop` profile). MIT licensed.
