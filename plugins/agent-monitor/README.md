# Agent Monitor 全会话中心

本机 Codex 会话可选监控：标题和项目搜索、执行中与历史状态分组、Agent 流转、节点公开过程及结果。

## 安装

在完整仓库根执行 `bash install.sh`。安装器使用仓库 `releases/` 中的预构建包，验证 SHA-256、检查服务并注册独立市场；无需 npm 或手动编译。运行环境需要 Node.js 20+、Python 3.10+、Codex CLI，面向 macOS 和 Linux。

源码仓库提供[完整安装指南](../../docs/install.md)。独立包不包含仓库 docs，以下命令可直接使用。

## 使用与诊断

打开插件后默认显示未选中的全会话目录，不自动绑定当前聊天或最近会话。点击一个主会话或子会话加载其流程树，再点击节点看公开过程与结果。目录状态依据日志，不代表实时进程存活；证据不足时显示未知。

独立安装包提供两个无需 npm 的命令，在插件目录执行：

```bash
node doctor.mjs
node preview-runtime.mjs
```

doctor 只检查安装文件、MCP 初始化、入口工具、目录工具、入口声明与界面资源。`server_ready` 不代表实际侧边栏已出现，`sidebar_visibility` 保持 `unverified`。官方 `global` UI 扩展说明面向 ChatGPT，Codex 客户端是否显示入口仍需确认。浏览器命令打印本机访问地址，作为不支持客户端入口时的备用方式。

## 能力边界

读取 `$CODEX_HOME/sessions`，默认 `~/.codex/sessions`。目录只返回元数据；点击节点才按需读取公开过程与最终结果，不返回内部推理。模型控制必须明确选定会话，并连接节点实际所属的 app-server。插件不会启动或复制聊天。

## 开发

仅开发者需要 `npm ci --ignore-scripts`、`npm run build`、`npm test` 和 `npm run release`。源码安装首次启动仍支持准备依赖；预构建包运行不触发构建。Python 唯一实现位于 backend，仓库根保留终端兼容入口。
