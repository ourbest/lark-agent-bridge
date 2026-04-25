# lark-agent-bridge

`lark-agent-bridge` 是一个桥接服务，用于将 Codex 项目实例连接到飞书/Lark 聊天会话。

它维护 `projectInstanceId` 与聊天会话之间的一对一绑定，将接收到的消息路由到绑定的 Codex 项目，并将回复发送回同一聊天。桥接服务还支持延迟项目启动、每个项目多 Provider，以及无需飞书的本地开发模式。

## 功能特性

- 将一个聊天会话同时绑定到一个项目
- 将消息从飞书/Lark 路由到绑定的项目
- 将项目回复发送回同一聊天
- 在首次使用时延迟建立 Codex Provider 连接
- 当没有聊天绑定时释放 Provider 连接
- 支持每个项目使用多个 Provider，并可切换当前 Provider
- 支持 `//read` 读取项目文件，在飞书文件上传权限可用时发送文件，上传失败时降级为文本
- 暴露小型 HTTP API 用于绑定管理

## 环境要求

- Node.js 18.14.1 或更高版本（推荐 Node.js 24）
- `codex` CLI（用于本地 Codex app-server 项目）
- 使用 Qwen 支持的项目需要 `@qwen-code/sdk` 和本地 Qwen 二进制文件
- 如需连接飞书，需要飞书机器人应用凭证
- 生产环境需要 `pm2` 以支持 `//restart` 命令

## 安装

### 从 GitHub 拉取

```bash
git clone https://github.com/ourbest/lark-agent-bridge.git
cd lark-agent-bridge
npm install
```

### 直接安装

```bash
npm install
```

## 配置项目

复制示例配置并编辑：

```bash
cp projects.json.example projects.json
```

示例配置：

```json
{
  "projects": [
    {
      "projectInstanceId": "my-project",
      "cwd": "/path/to/your/project"
    },
    {
      "projectInstanceId": "my-qwen-project",
      "cwd": "/path/to/your/project",
      "providers": [
        { "provider": "codex", "transport": "stdio" },
        { "provider": "qwen", "transport": "stdio" }
      ]
    },
    {
      "projectInstanceId": "my-remote-codex-project",
      "cwd": "/path/to/local/project",
      "providers": [
        {
          "provider": "codex",
          "transport": "websocket",
          "websocketUrl": "ws://10.8.0.19:4010",
          "remoteCwd": "/path/to/remote/project"
        }
      ]
    }
  ]
}
```

如果省略 `providers` 或设置为 `[]`，桥接服务将使用默认 Provider 列表：`codex`、`cc` 和 `qwen`。

`cwd` 是桥接服务端的本地项目路径。当基于 WebSocket 的 Codex Provider 需要在远程机器上使用不同的工作目录时，请使用 `remoteCwd`。

### OpenCode 项目

如需将飞书聊天绑定到 OpenCode 支持的项目，配置如下：

```json
{
  "projects": [
    {
      "projectInstanceId": "repo-a",
      "cwd": "/path/to/repo-a",
      "opencodeHostname": "127.0.0.1",
      "opencodePort": 4101
    }
  ]
}
```

## 运行

### 本地开发模式

如果未配置飞书凭证，桥接服务将以本地开发模式运行。消息会输出到 stdout 而不是发送到飞书。

```bash
npm run dev
```

### 飞书 WebSocket 模式

设置飞书凭证并启用飞书 WebSocket 传输：

```bash
FEISHU_APP_ID=your_app_id
FEISHU_APP_SECRET=your_app_secret
BRIDGE_FEISHU_WS_ENABLED=1
```

然后启动桥接服务：

```bash
npm start
```

桥接服务默认监听 `http://127.0.0.1:3000`，并将绑定数据存储在 `./data/bridge.json`。

### 使用 pm2 生产部署

```bash
pm2 start ecosystem.config.cjs
pm2 logs lark-agent-bridge
pm2 save
```

常用生命周期命令：

```bash
pm2 restart lark-agent-bridge
pm2 stop lark-agent-bridge
pm2 delete lark-agent-bridge
```

`//restart` 命令会以代码 `0` 退出进程，`pm2` 可自动重启。

## 聊天命令

在飞书/Lark 聊天中发送以 `//` 为前缀的命令。

### 桥接命令

| 命令 | 描述 |
|------|------|
| `//bind <projectId>` | 将此聊天绑定到项目 |
| `//unbind` | 解绑此聊天 |
| `//list` | 显示当前绑定 |
| `//projects` | 列出所有可见项目 |
| `//providers` | 列出已绑定项目的 Provider |
| `//provider <name>` | 切换当前 Provider |
| `//status` | 显示桥接服务和 Codex 状态 |
| `//sessions` | `//status` 的别名 |
| `//read <path>` | 读取项目 cwd 下的文件并发送到聊天 |
| `//restart` | 重启桥接服务进程 |
| `//reload projects` | 重新加载 `projects.json` |
| `//resume <threadId\|last>` | 恢复 Codex 线程 |
| `//new` | 启动新的 Codex 线程 |
| `//model <name>` | 更新已绑定项目的模型 |
| `//mode [plan|auto-edit|yolo]` | 设置项目的执行模式 |
| `//help` | 显示帮助 |

### 审批命令

| 命令 | 描述 |
|------|------|
| `//approvals` | 列出待处理的审批请求 |
| `//approve <id>` | 批准一个请求 |
| `//approve-all <id>` | 为该会话批准一个请求 |
| `//approve-auto <minutes>` | 在此聊天中自动批准审批请求 N 分钟 |
| `//deny <id>` | 拒绝一个请求 |

### Codex 命令

| 命令 | 描述 |
|------|------|
| `//session/list` | 列出 Codex 会话 |
| `//session/get <id>` | 查看某个 Codex 会话 |
| `//thread/list` | 列出 Codex 线程 |
| `//thread/get <id>` | 查看某个 Codex 线程 |
| `//thread/read <id>` | 以更丰富的摘要输出读取线程 |
| `//review` | 审查当前工作树 |
| `//review --base <branch>` | 针对某个分支进行审查 |
| `//review --commit <sha>` | 审查某个特定提交 |
| `//review <instructions>` | 使用自定义指令进行审查 |

不带 `//` 前缀的命令将被拒绝。

## HTTP API

桥接服务默认在端口 `3000` 暴露一个小型 HTTP API。

```text
POST   /bindings                    # 创建绑定
GET    /bindings/project/:id        # 通过项目查询会话
GET    /bindings/session/:id        # 通过会话查询项目
DELETE /bindings/project/:id        # 解绑项目
DELETE /bindings/session/:id        # 解绑会话
GET    /health                     # 健康检查
```

示例：

```bash
curl -X POST http://127.0.0.1:3000/bindings \
  -H 'content-type: application/json' \
  -d '{"projectInstanceId":"my-project","sessionId":"chat-id-from-feishu"}'
```

## 开发

### 运行测试

```bash
npm test
```

### 运行单个测试文件

Node 24 支持原生测试文件 glob 模式：

```bash
node --experimental-strip-types --test tests/core/binding/binding-service.test.ts
```

### 直接运行桥接服务

```bash
node --experimental-strip-types src/main.ts
```

### 开发入口点

- `npm run dev` 以开发模式启动桥接服务
- `npm start` 以生产模式启动桥接服务
- `src/main.ts` 是主运行时入口点
- `src/app.ts` 负责桥接运行时的依赖注入
- `src/runtime/bootstrap.ts` 解析运行时配置和本地开发传输层
- `src/adapters/lark/feishu-websocket.ts` 包含飞书 WebSocket 传输层
- `src/runtime/project-registry.ts` 管理延迟项目连接

## 配置

### 桥接服务

| 变量 | 默认值 | 描述 |
|------|--------|------|
| `BRIDGE_HOST` | `127.0.0.1` | 服务绑定地址 |
| `BRIDGE_PORT` | `3000` | 服务端口 |
| `BRIDGE_STORAGE_PATH` | `./data/bridge.json` | 绑定存储路径 |
| `BRIDGE_PROJECTS_FILE` | `./projects.json` | 项目配置路径 |
| `BRIDGE_PROJECTS_ROOT` | 未设置 | 从非隐藏子目录自动发现项目 |
| `BRIDGE_APP_NAME` | `lark-agent-bridge` | 启动通知中使用的显示名称 |

### 飞书

| 变量 | 描述 |
|------|------|
| `FEISHU_APP_ID` | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret |
| `BRIDGE_FEISHU_WS_ENABLED` | 设置为 `1` 以启用飞书 WebSocket 传输 |
| `BRIDGE_STARTUP_NOTIFY_OPENID` | 用于启动通知的可选 open ID |

### Codex 项目覆盖

单项目控制台模式：

| 变量 | 描述 |
|------|------|
| `BRIDGE_CONSOLE` | 设置为 `1` 启用控制台模式 |
| `BRIDGE_CONSOLE_PROJECT_INSTANCE_ID` | 要绑定的项目 |
| `BRIDGE_CODEX_CWD` | 项目工作目录 |
| `BRIDGE_CODEX_QWEN_EXECUTABLE` | Qwen 二进制文件的完整路径（用于 Qwen 支持的项目） |

## 注意事项

- 每个聊天只能同时绑定到一个项目
- Codex 连接在聊天首次绑定到项目时延迟建立
- 当所有绑定的聊天解绑时，连接会被释放
- `//read` 会优先尝试上传文件到飞书，如果文件上传不可用则降级为文本发送
