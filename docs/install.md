# 安装指南

Agent Monitor 读取本机 Codex 日志，展示主控派发、智能体执行和结果回流。监控界面包含节点详情、公开过程、最终结果、模型配置和事件时间线。

## 环境要求

| 组件 | 要求 |
| --- | --- |
| Codex 客户端 | 支持插件和 MCP Apps；需安装后确认入口 |
| Codex CLI | 能执行 `codex plugin` 命令 |
| Node.js | 20 或以上 |
| Python | 3.10 或以上；读取器仅使用标准库 |
| npm | 源码安装需要；预构建包运行不需要 |

当前插件启动脚本使用 Bash，面向 macOS 和 Linux。Windows 原生插件启动尚未适配。终端监控脚本可在支持 ANSI 的终端中运行。

先检查版本：

```bash
codex --version
codex plugin --help
node --version
python3 --version
npm --version
```

插件无需新增 API Key。插件读取的日志应来自当前用户的 Codex 数据目录。

## 从 GitHub 源码安装

```bash
git clone https://github.com/freetryMyleft/codexAgentMonitor.git
cd codexAgentMonitor

npm --prefix plugins/agent-monitor ci --ignore-scripts
npm --prefix plugins/agent-monitor run build

codex plugin marketplace add "$PWD" --json
codex plugin add agent-monitor@agent-monitor-local --json
```

安装命令输出应包含 `pluginId`、`version` 和 `installedPath`。当前源码版本为 1.1.0。

省略预先构建时，源码插件会在首次启动执行锁定依赖安装和构建。此方式需要网络、npm 和可写插件目录。准备日志写入 stderr；若首次连接超时，等待准备结束后重新打开插件。

## 使用预构建包

预构建包由仓库源码生成，包含 MCP 运行时、界面资源和 Python 读取器。安装后无需下载 npm 依赖，也不依赖仓库外层文件。Node.js 和 Python 仍需安装。

生成安装包：

```bash
cd codexAgentMonitor
npm --prefix plugins/agent-monitor ci --ignore-scripts
npm --prefix plugins/agent-monitor run release
```

输出文件为 `plugins/agent-monitor/dist/agent-monitor-1.1.0.tar.gz`。`dist/` 属于构建产物，不随源码提交到 Git；本说明不假定 GitHub Releases 已发布安装包。

在另一个目录安装生成的包：

```bash
# 在已有源码仓库根目录执行；创建独立安装目录
mkdir -p ../agent-monitor-install/plugins
tar -xzf plugins/agent-monitor/dist/agent-monitor-1.1.0.tar.gz \
  -C ../agent-monitor-install/plugins
cd ../agent-monitor-install
mkdir -p .agents/plugins
```

在 `.agents/plugins/marketplace.json` 保存以下内容：

```json
{
  "name": "agent-monitor-local",
  "interface": { "displayName": "Agent Monitor · 本地插件" },
  "plugins": [{
    "name": "agent-monitor",
    "source": { "source": "local", "path": "./plugins/agent-monitor" },
    "policy": {
      "installation": "AVAILABLE",
      "authentication": "ON_INSTALL"
    },
    "category": "Productivity"
  }]
}
```

路径相对于安装目录根解析。随后执行：

```bash
codex plugin marketplace add "$PWD" --json
codex plugin add agent-monitor@agent-monitor-local --json
```

源码市场和预构建包市场使用同一名称。选择一种方式安装；切换来源时，重新注册所选目录并确认命令返回的安装路径。

## 安装后的检查

1. 重开客户端，在插件列表中确认 Agent Monitor 已安装且启用。
2. 检查全局侧边栏或当前会话面板是否提供 Agent Monitor 入口。
3. 也可在会话中引用 `@Agent Monitor`，请求“打开 Agent Monitor，查看当前会话”。
4. 查看左侧会话名称与绑定标记。若显示“最近会话（未绑定当前聊天）”，从会话列表中手动选择。
5. 点击一个节点，检查右侧节点详情、公开过程和最终结果。已完成的节点位于历史记录分组。

插件声明了入口，安装成功也已通过协议测试。客户端是否实际展示入口、是否向工具传递当前会话元数据，仍需在相应客户端中确认。浏览器预览截图不能代替此验收。

## 浏览器预览

无需加载桌面插件即可检查界面：

```bash
cd codexAgentMonitor
npm --prefix plugins/agent-monitor run preview
```

打开命令打印的 `http://127.0.0.1:端口`，在地址后添加 `/?mode=demo` 可看演示。端口由系统分配，每次可能不同。也可通过界面的“真实会话”和“演示”按钮切换。

![演示模式的节点模型设置](screenshots/node-model-settings.png)

演示模式的“模拟应用”仅改变该监控面板的模拟配置，不会修改真实智能体。

## 更新插件

在干净的仓库工作区执行：

```bash
git pull --ff-only
npm --prefix plugins/agent-monitor ci --ignore-scripts
npm --prefix plugins/agent-monitor run build
codex plugin add agent-monitor@agent-monitor-local --json
```

确认返回的版本和安装目录，然后重开客户端。存在本地修改时，先保存修改，避免更新冲突。

## 常见问题

| 情况 | 检查方式 |
| --- | --- |
| `codex plugin` 不存在 | 检查 CLI 版本是否支持插件命令 |
| 已安装但没有入口 | 确认启用并重开客户端；检查客户端对 MCP Apps 和侧边栏扩展的支持 |
| 首次启动超时 | 预先执行 `npm ci --ignore-scripts` 和 `npm run build`，重新安装 |
| 提示 Node.js 或 Python 缺失 | 确认版本满足要求；桌面启动环境可能与终端 PATH 不同 |
| 提示准备已在运行 | 等待准备结束；若进程已中断，确认没有准备进程后移除安装目录内的空 `.startup-lock` 目录 |
| 找不到当前会话 | 确认日志位于 `$CODEX_HOME/sessions`，默认是 `~/.codex/sessions`；当前聊天没有可读日志时不会自动跳到其他会话 |
| 模型设置不可用 | 所选节点需由插件连接的 app-server 实际持有；独立 stdio 桌面节点通常不属于默认后台 socket |
| 模型修改结果未确认 | 点击“重新读取”核对配置；不要自动重复提交 |

模型控制的默认 socket 为 `$CODEX_HOME/app-server-control/app-server-control.sock`。可通过 `AGENT_MONITOR_CONTROL_SOCKET` 指定节点实际所属的本机服务。插件不会自动启动、恢复或复制聊天来取得控制权。

## 隐私与验证

截图均为模拟数据。默认快照不包含工具参数和对话正文；点击节点后按需读取公开过程与最终结果，内部推理正文不会返回。发布截图前仍应检查会话标题、项目路径和结果是否包含敏感信息。

开发验证命令：

```bash
python3 -m unittest discover -s tests
npm --prefix plugins/agent-monitor run build
npm --prefix plugins/agent-monitor test
```

插件测试覆盖独立源码首次启动、无 `node_modules` 的预构建包、会话绑定及缺失日志处理。客户端入口验收和真实桌面节点的模型写入不在这些测试的完成声明中。

[返回 README](../README.md) · [查看全部截图](screenshots.md)
