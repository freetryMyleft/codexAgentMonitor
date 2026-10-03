# Agent Monitor 插件

本机 Codex Agent 流转监控，声明全局侧边栏及会话面板入口。

源码仓库提供[完整安装指南](../../docs/install.md)和[界面截图](../../docs/screenshots.md)。独立安装包不包含仓库 `docs/`，请使用本页安装说明，或查阅 GitHub 仓库中的文档。

## 安装与启动

运行环境：Node.js 20+、Python 3.10+。不需要 API Key。

源码安装首次打开时，`scripts/start.sh` 自动执行锁定版本的 `npm ci --ignore-scripts` 和构建；需要 npm、可写插件目录与网络。准备日志只写 stderr，不污染 MCP 通信。若客户端首次连接超时，等待准备结束后重新打开插件。中断留下 `.startup-lock` 时，确认没有准备进程后移除锁目录并重试。

预构建包：开发者运行 `npm ci --ignore-scripts && npm run release`，得到 `dist/agent-monitor-1.1.0.tar.gz`。解压后整个 `agent-monitor/` 即为插件目录，可放入任一仓库的 `plugins/` 并添加 marketplace 条目。预构建包不需要 npm、node_modules、外层项目或首次启动下载，只需 Node 和 Python。

市场配置示例（位于仓库根的 `.agents/plugins/marketplace.json`）：

```json
{
  "name": "agent-monitor-local",
  "plugins": [{
    "name": "agent-monitor",
    "source": {"source": "local", "path": "./plugins/agent-monitor"},
    "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
    "category": "Productivity"
  }]
}
```

在该仓库运行 `codex plugin marketplace add "$PWD" --json` 和 `codex plugin add agent-monitor@agent-monitor-local --json`。安装后重开客户端，在插件中启用并检查入口；安装和协议测试不能证明客户端实际已显示侧边栏。

## 会话绑定

显式 `sessionId` 优先；否则按调用读取 Codex executor 元数据（包括 `openai/threadId` 和 `x-codex-turn-metadata`）。不使用服务器环境中的 `CODEX_THREAD_ID`，避免共享服务器串会话。首次结果返回后面板固定会话；客户端不提供元数据时，明确显示“最近会话（未绑定当前聊天）”和提醒，可手动选择会话。当前聊天日志不存在时报告错误，不切换到其他聊天。

## 能力边界

读取本机 `$CODEX_HOME/sessions`（默认 `~/.codex/sessions`）。点击节点仅按需读取公开进度与最终结果，不暴露内部推理。演示数据始终标注。

模型控制仅对连接的 app-server 实际持有的节点有效；默认 socket 为 `$CODEX_HOME/app-server-control/app-server-control.sock`，可用 `AGENT_MONITOR_CONTROL_SOCKET` 指定。桌面客户端若通过独立 stdio 服务运行节点，不能通过默认后台 socket 修改。插件不会启动或复制聊天来绕过此限制。

## 开发

`npm run build` 构建界面和自包含 MCP runtime，`npm test` 运行测试，`npm run preview` 启动回环地址预览。Python 模块的唯一实现位于 `backend/`，仓库根文件只保留终端兼容入口。
