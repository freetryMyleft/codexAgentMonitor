# All-session Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task.

**Goal:** 默认展示所有可读会话，普通用户无需手动编译即可安装，并提供侧边栏分层诊断。

**Architecture:** 独立的元数据目录与显式选中树分离。预构建归档提供运行文件，安装器验证后调用 Codex 注册，doctor 检查 MCP 声明而不假设客户端已渲染。

**Tech Stack:** Python 标准库、Node MCP SDK、MCP Apps、Bash、esbuild。

## Global Constraints

- Node.js 20+、Python 3.10+，普通用户安装不调用 npm，不使用 sudo。
- 不绑定调用者聊天或最近会话，模型写入必须显式所选 sessionId。
- 目录只返回元数据，状态未知必须保留，目录分页无 20 条截断。
- 不重启客户端、不修改客户端内部文件、不输出其他 MCP 配置或环境秘密。
- 各实现者仅修改分配文件；所有更改测试优先，审查不代替验收。

## Task 1: 全会话目录和 UI

**Files:** backend/session_catalog.py（新增）、backend/desktop_bridge.py、backend.mjs、binding.mjs、server.mjs、preview.mjs、ui/app.js、ui/index.html、ui/style.css、ui/graph.js、tests/test_sidebar_state.py、插件 tests。

**Interfaces:** `MonitorBackend.sessions({offset=0,limit=100})` 返回 `{sessions,total,offset,next_offset,generated_at,warning}`；`list_agent_sessions` 和 GET `/api/sessions` 暴露同样内容。open 未指定 sessionId 时返回目录且 `root_id:null,agents:[],flows:[]`；指定时返回树。

- [ ] 先添加 >20 个 fixture、目录独立读取、首次未选中、显式写入验证测试，运行并观察失败。
- [ ] 新建目录索引，复用 SessionSource.scan 和 SessionNames；每文件状态缓存，限制读取量，不向外返回正文。
- [ ] 添加目录子进程与分页 API，关闭时回收；selectedNode 拒绝 live 缺失 sessionId。
- [ ] UI 独立 catalog 状态，搜索、项目和状态筛选、分页、明确选中后读树；保留已有 generation 和节点加载竞态保护。
- [ ] 更新旧绑定测试以体现新需求，运行 `python3 -m unittest discover -s tests` 和 `npm --prefix plugins/agent-monitor test`。

## Task 2: 预构建安装和诊断

**Files:** install.sh（新增）、scripts/doctor.mjs（新增）、scripts/build.mjs、scripts/release.mjs、tests/install.test.mjs（新增）、README 和 docs/install.md。

**Interfaces:** `bash install.sh` 使用仓库 releases 内归档和 .sha256；`node doctor.mjs [plugin-path]` 返回安全诊断报告及非零失败状态。

- [ ] 先编写测试：缺少归档/错误校验和无 Codex 调用，有效归档使用独立目录与参数不被空格拆分；doctor 验证 mock/真实 MCP 初始化和入口。
- [ ] 安装器先检查依赖和 SHA，再在用户作用域 mktemp 目录解包；仅安装 agent-monitor 本地市场，不删除旧版本或改其他配置。
- [ ] doctor 将工具入口、资源 HTML、会话目录工具分步检查，输出客户端验收未确认，不读取会话正文。
- [ ] 开发构建为 runtime 和 doctor 各打包；归档 allowlist 增加 doctor，生成 checksum。版本同步提升到 1.2.0。
- [ ] 生成 releases 预构建归档，安装验证并更新用户文档；普通用户只需 clone 和 bash install.sh。

## Task 3: 集成验收

- [ ] 审查完整工作区 diff，修复重要问题，验证所有脚本语法和所有测试。
- [ ] 浏览器检查未选中首页、会话选择、搜索、分组及演示节点详情。
- [ ] 新安装插件执行 doctor，报告侧边栏实际可见性限制；不擅自强制重启。
- [ ] 更新计划完成状态，向用户交付结果和剩余验收项。
