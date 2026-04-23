# OpenClaw Session Viewer

OpenClaw 本地 session 只读审查工具。

这个仓库只包含 `session-viewer` 工具本身，不包含你的 OpenClaw 运行态目录、session 数据、日志或本地配置。

## 功能

- 将多个 agent 的 session transcript 还原成 chat 界面
- 支持当前 session 和历史归档 session
- 支持多 session 并排对比
- 支持调用链视图
- 支持 agent、类型、状态、模型、provider 筛选
- 支持创建时间筛选，以及最近 1 天、3 天、7 天快捷筛选
- thinking 默认折叠
- 长文本默认显示 4 行，点击 `...` 展开
- assistant 模型调用展示推导耗时和 token 使用量
- 展示每个 agent 当前生效的 session 根目录和配置来源

## 环境要求

- Node.js 18+
- 本地存在可读取的 OpenClaw session 数据目录

## 启动

在本仓库根目录运行：

```bash
node server.js
```

默认访问地址：

```text
http://127.0.0.1:4318
```

可以通过环境变量修改端口或监听地址：

```bash
OPENCLAW_SESSION_VIEWER_PORT=4320 node server.js
```

```bash
OPENCLAW_SESSION_VIEWER_HOST=0.0.0.0 node server.js
```

## Session 根目录配置

本工具不会从 agent 的 `workspace` 推导 session 存放位置。

session 运行态目录和 workspace 是两组独立空间，因此需要显式配置每个 agent 的 session 根目录。

先复制示例配置：

```bash
cp session-roots.example.json session-roots.json
```

然后编辑：

```text
session-roots.json
```

示例：

```json
{
  "agents": {
    "assistant-jiajiawu": {
      "sessionRoot": "/Users/you/openclaw/.openclaw/agents/assistant-jiajiawu/sessions"
    }
  }
}
```

`sessionRoot` 支持：

- 绝对路径
- 相对 OpenClaw 根目录的路径

默认情况下，OpenClaw 根目录按 `server.js` 所在目录的上两级推导。独立使用时建议直接使用绝对路径，避免歧义。

`session-roots.json` 是本机配置，不应提交到 GitHub。提交仓库时只提交：

```text
session-roots.example.json
```

## 读取范围

工具只读取配置中的 session 根目录，并且是只读读取。

当前支持：

- `sessions.json` 中记录的当前 session
- 当前 `*.jsonl` transcript
- `/reset` 等产生的 `*.jsonl.reset.*`
- `*.jsonl.deleted.*`
- 其他符合 `*.jsonl.<reason>.<timestamp>` 形式的归档 transcript

## 建议提交文件

如果把当前目录作为独立 GitHub 仓库，建议提交：

```text
.gitignore
README.md
server.js
public/index.html
public/app.js
public/styles.css
session-roots.example.json
```

不要提交：

```text
session-roots.json
README.md.*
*.log
node_modules/
```

## 检查

```bash
node --check server.js
node --check public/app.js
```
