# 安装指南

## 普通用户：一条安装命令

需要 Node.js 20+、Python 3.10+ 和支持 `codex plugin` 的 Codex CLI。当前安装脚本面向 macOS 和 Linux。

首次下载项目后执行：

```bash
git clone https://github.com/freetryMyleft/codexAgentMonitor.git
cd codexAgentMonitor
bash install.sh
```

仓库 `releases/` 包含预构建安装包与 SHA-256。安装器验证校验和、检查服务，然后注册并安装插件。普通用户不运行 npm，不编译源码，不需要 sudo。Node.js 和 Python 仍需预先安装。

安装器只创建自己的用户目录：`$CODEX_HOME/agent-monitor-installs/install.XXXXXX`，默认在 `~/.codex/` 下。旧安装目录保留，其他插件和市场文件不会被覆盖。安装失败时保留目录便于检查；校验失败时不会注册市场。

升级已有安装时，安装器先确认 `agent-monitor-local` 是只包含 Agent Monitor 的本地市场，再切换该市场登记的来源。旧源码和安装目录保留。新来源登记或插件安装失败时，安装器尝试恢复旧来源；同名市场包含其他插件时会停止升级。

更新时在干净的项目目录执行：

```bash
git pull --ff-only
bash install.sh
```

## 安装后使用

重开客户端，在插件列表中确认 Agent Monitor 已启用。可引用 `@Agent Monitor` 请求“打开全会话中心”。全局侧边栏或会话面板是否展示入口，取决于客户端支持。

监控首页不绑定当前聊天，也不自动打开最近会话。首页列出本机可读的主会话和子会话，可按标题、ID 或项目搜索，按项目和日志状态筛选。点击一个会话后加载其流程树，再点击节点查看公开过程和最终结果。

“执行中”表示日志最后记录的状态，不是进程存活检测。状态读取量有上限，缺少可靠事件时显示未知。目录分页查询，不再只返回最近 20 个主会话。目录刷新不会改变用户已选会话。

## 没有侧边栏入口时如何判断

插件列表可见只证明安装和目录发现成功。官方把 `global` 入口定义为 ChatGPT 全局侧边栏的全屏 MCP App；同一插件在 Codex 安装成功，并不保证 Codex 客户端显示该界面入口。[官方扩展说明](https://developers.openai.com/plugins/build/extensions)

安装器会打印诊断命令：

```bash
node /安装目录/plugins/agent-monitor/doctor.mjs /安装目录/plugins/agent-monitor
```

诊断检查预构建文件、MCP 初始化、监控工具、全会话目录工具、`global`/`thread` 声明和 HTML 资源。输出 `server_ready: true` 只代表服务与资源就绪；`sidebar_visibility: "unverified"` 保留客户端验收状态。诊断不读取会话正文、不打印其他 MCP 配置。

服务诊断通过、客户端仍不显示入口时，记录客户端版本及界面截图，再检查客户端支持情况。不要反复编译，也不要修改客户端内部文件。官方排障文档区分服务与发现检查，以及 ChatGPT 的 UI 检查。[官方排障说明](https://developers.openai.com/plugins/deploy/troubleshooting)

## 浏览器备用入口

安装器打印浏览器预览命令，预构建包已包含运行时，无需 npm：

```bash
node /安装目录/plugins/agent-monitor/preview-runtime.mjs
```

打开打印的 `http://127.0.0.1:端口`。真实模式显示全会话中心；添加 `/?mode=demo` 或点击“演示”查看模拟数据。端口由系统分配，服务只绑定本机回环地址。

## 常见问题

| 情况 | 处理方式 |
| --- | --- |
| 缺少 Node.js、Python 或 Codex | 安装所缺组件后重试；先检查版本 |
| 缺少 `releases/` 安装包 | 下载包含预构建包的新版本；不要对普通用户要求 npm 编译 |
| SHA-256 校验失败 | 重新下载发布版本，停止安装；不要跳过校验 |
| 插件列表可见，侧边栏不可见 | 执行 doctor；服务通过后检查客户端支持，使用浏览器备用入口 |
| 目录为空 | 检查 `$CODEX_HOME/sessions`，默认 `~/.codex/sessions`；无日志时显示空目录 |
| 状态未知 | 最近的有界日志读取中没有可靠状态事件；不会猜测完成或运行 |
| 模型设置不可用 | 节点必须由插件连接的 app-server 持有；桌面独立 stdio 节点通常不属于默认 socket |
| 模型修改结果未确认 | 重新读取核对配置，不自动重复提交 |

默认模型控制 socket 为 `$CODEX_HOME/app-server-control/app-server-control.sock`。可通过 `AGENT_MONITOR_CONTROL_SOCKET` 指定节点所属的本机服务。插件不会自动启动、恢复或复制聊天取得控制权。

## 开发者编译与打包

下面的命令仅供开发者，不是普通用户安装步骤：

```bash
npm --prefix plugins/agent-monitor ci --ignore-scripts
npm --prefix plugins/agent-monitor run release
python3 -m unittest discover -s tests
npm --prefix plugins/agent-monitor test
```

构建输出位于 `plugins/agent-monitor/dist/agent-monitor-1.2.0.tar.gz` 及 `.sha256`。发布时将这两个文件复制到仓库 `releases/`，确保归档与源码版本一致。源码市场的手动注册方式仍用于开发；普通用户入口始终是 `bash install.sh`。

## 隐私

会话目录只返回元数据。默认节点快照不返回工具参数或对话正文；点击节点后按需读取公开过程与最终结果，内部推理正文不会返回。上传截图前检查标题、项目路径和结果是否包含敏感信息。

[返回 README](../README.md) · [界面截图](screenshots.md)
