[English](./README.md) | [简体中文](#)

# Claude Code Runner

> [!WARNING]
>
> - 这项工作处于 alpha 阶段，可能存在安全问题，使用风险自负。
> - 如有疑问，请发送邮件至 [admin@soraharu.com](mailto:admin@soraharu.com)。

在 Docker 容器内将 Claude Code 作为自主代理运行，并自动集成 GitHub。安全地绕过所有权限提示。

## 为什么选择 Claude Code Runner？

Claude Code Runner 的主要目标是通过允许 Claude Code 在没有权限提示的情况下执行，从而实现 **完全异步的智能体工作流**。通过在隔离的 Docker 容器中使用 `--dangerously-skip-permissions` 标志运行 Claude，Claude 可以：

- 无需请求权限即可立即执行任何命令
- 自主进行代码更改
- 运行构建工具、测试和开发服务器
- 创建提交并管理 Git 操作
- 在不打断用户的情况下持续工作

通过 **基于浏览器的终端** 访问 Claude，让你可以在处理其他任务的同时监控 AI 助手并与之交互。这创建了一个真正自主的开发助手，类似于 [OpenAI Codex](https://chatgpt.com/codex) 或 [Google Jules](https://jules.dev)，但在你的本地机器上运行，并且完全可控。

## 概述

Claude Code Runner 允许你在隔离的 Docker 容器中运行 Claude Code，为 AI 辅助开发提供安全的环境。它会自动：

- 为每个会话创建新的 Git 分支
- 监控 Claude 所做的提交
- 提供交互式的更改审查
- 安全地转发凭证
- 启用推送/PR 创建工作流
- 运行自定义设置命令以初始化环境

## 安装

从 npm 全局安装 Claude Code Runner：

```bash
npm install -g claude-code-runner
```

### 前置要求

- Node.js >= 22.13.0
- Docker 或 Podman
- Git

## 使用方法

### 快速开始

> **提示**：为了最快的启动速度，使用预构建的官方镜像：在配置中设置 `buildImage: false`。默认镜像（`ghcr.io/yanranxiaoxi/claude-code-runner:latest`）会自动使用。

只需在任何 Git 仓库文件夹中运行：

```bash
claude-run
```

这将：

1. 创建一个新分支 (`claude/[timestamp]`)
2. 启动一个包含 Claude Code 的 Docker 容器
3. 在 `http://localhost:3456` 上启动 Web UI
4. 自动打开浏览器

### 命令

#### `claude-run` (默认)

使用 Web UI 启动新容器（推荐）：

```bash
claude-run
```

#### `claude-run start`

显式启动带选项的新容器：

```bash
claude-run start [选项]

选项:
  -c, --config <path>    配置文件 (默认: ./claude-run.config.json)
  -n, --name <name>      容器名称前缀
  --no-web               禁用 Web UI (使用终端附加)
  --no-push              禁用自动分支推送
  --no-pr                禁用自动 PR 创建
```

#### `claude-run attach [container-id]`

附加到现有容器：

```bash
# 交互式选择
claude-run attach

# 指定容器
claude-run attach abc123def456

选项:
  --no-web               使用终端附加而不是 Web UI
```

#### `claude-run list`

列出所有 Claude Runner 容器：

```bash
claude-run list
claude-run ls        # 别名

选项:
  -a, --all              显示所有容器 (包括已停止的)
```

#### `claude-run stop [container-id]`

停止容器：

```bash
# 交互式选择
claude-run stop

# 指定容器
claude-run stop abc123def456

# 停止全部
claude-run stop --all
```

#### `claude-run logs [container-id]`

查看容器日志：

```bash
claude-run logs
claude-run logs abc123def456

选项:
  -f, --follow           跟踪日志输出
  -n, --tail <lines>     显示的行数 (默认: 50)
```

#### `claude-run clean`

删除已停止的容器：

```bash
claude-run clean
claude-run clean --force  # 删除所有容器
```

#### `claude-run config`

显示当前配置：

```bash
claude-run config
```
#### `claude-run self-update`

更新 Claude Code Runner 到最新版本：

```bash
claud-run self-update
claud-run update        # 别名
```

此命令会自动将全局安装的包更新到 npm 上可用的最新版本。
### 配置

创建一个 `claude-run.config.json` 文件（参考 `claude-run.config.example.json`）：

```json
{
	"dockerImage": "claude-code-runner:latest",
	"buildImage": true,
	"dockerfile": "./custom.Dockerfile",
	"detached": false,
	"autoPush": true,
	"autoCreatePR": true,
	"autoStartClaude": true,
	"envFile": ".env",
	"environment": {
		"NODE_ENV": "development"
	},
	"setupCommands": ["npm install", "npm run build"],
	"volumes": ["/host/path:/container/path:ro"],
	"mounts": [
		{
			"source": "./data",
			"target": "/workspace/data",
			"readonly": false
		},
		{
			"source": "/home/user/configs",
			"target": "/configs",
			"readonly": true
		}
	],
	"allowedTools": ["*"],
	"maxThinkingTokens": 100000,
	"bashTimeout": 600000,
	"containerPrefix": "my-project",
	"claudeConfigPath": "~/.claude.json",
	"dockerSocketPath":"/run/user/1000/podman/podman.sock",
	"forwardSshKeys": true,
	"forwardGpgKeys": true,
	"forwardSshAgent": true,
	"enableGpgSigning": false
}
```

#### 配置选项

- `dockerImage`: 要使用的基础 Docker 镜像 (默认: `claude-code-runner:latest`)
- `buildImage`: 在本地构建镜像（默认：true）或从仓库拉取（设置为 false）
- `dockerfile`: 自定义 Dockerfile 的路径 (可选)
- `detached`: 在分离模式下运行容器
- `autoPush`: 提交后自动推送分支
- `autoCreatePR`: 自动创建拉取请求
- `autoStartClaude`: 自动启动 Claude Code (默认: true)
- `envFile`: 从文件加载环境变量 (例如 `.env`)
- `environment`: 额外的环境变量
- `setupCommands`: 容器启动后要运行的命令 (例如安装依赖)
- `volumes`: 旧版卷挂载 (字符串格式)
- `mounts`: 现代挂载配置 (对象格式)
- `allowedTools`: Claude 工具权限 (默认: 全部)
- `maxThinkingTokens`: Claude 的最大思考令牌数
- `bashTimeout`: bash 命令超时时间（毫秒）
- `containerPrefix`: 容器名称的自定义前缀
- `claudeConfigPath`: Claude 配置文件的路径
- `dockerSocketPath`: 自定义 Docker/Podman 套接字路径（默认自动检测）
- `forwardSshKeys`: 将 `~/.ssh` 中的 SSH 密钥转发到容器（默认：true）
- `forwardGpgKeys`: 将 `~/.gnupg` 中的 GPG 密钥转发到容器（默认：true）
- `forwardSshAgent`: 转发 SSH agent 以支持带密码的密钥（默认：true）
- `enableGpgSigning`: 在容器中启用 GPG 提交签名（默认：false）

#### 挂载配置

`mounts` 数组允许你将文件或目录挂载到容器中：

- `source`: 宿主机上的路径（相对路径从当前目录解析）
- `target`: 容器中的路径（相对路径从 /workspace 解析）
- `readonly`: 可选布尔值，使挂载为只读（默认: false）

示例用例：

- 挂载不应包含在 Git 中的数据目录
- 在宿主机和容器之间共享配置文件
- 挂载构建产物或依赖项
- 访问宿主系统资源（谨慎使用）

#### 使用预构建的容器镜像

默认情况下，Claude Code Runner 在本地构建 Docker 镜像。如果你更喜欢从仓库拉取预构建镜像：

**方案 1：使用官方预构建镜像（推荐）**

最简单的方式是使用官方维护的镜像，只需设置 `buildImage: false`：

```json
{
	"buildImage": false
}
```

官方镜像 `ghcr.io/yanranxiaoxi/claude-code-runner:latest` 会自动使用。

然后运行：

```bash
claude-run
```

**可用的官方镜像：**

- **GitHub 容器镜像仓库**（默认）：`ghcr.io/yanranxiaoxi/claude-code-runner:latest`
- **Docker Hub**：`docker.io/yanranxiaoxi/claude-code-runner:latest`
- **GitLab 镜像仓库**：`registry.gitlab.soraharu.com/xiaoxi/claude-code-runner:latest`

所有镜像都具有以下优势：
- ✅ 定期维护和更新
- ✅ 已预配置并测试
- ✅ 开箱即用
- ✅ 启动速度更快
- ✅ 使用默认镜像（GitHub 容器镜像仓库）时无需指定完整的镜像 URL

要使用 Docker Hub：

```json
{
	"buildImage": false,
	"dockerImage": "docker.io/yanranxiaoxi/claude-code-runner:latest"
}
```

要使用 GitLab 镜像仓库：

```json
{
	"buildImage": false,
	"dockerImage": "registry.gitlab.soraharu.com/xiaoxi/claude-code-runner:latest"
}
```

**方案 2：使用自定义镜像**

如果你在仓库中维护自己的镜像：

```json
{
	"dockerImage": "myregistry.com/claude-code-runner:latest",
	"buildImage": false
}
```

**方案 3：本地构建（默认）**

从仓库中的 Dockerfile 构建镜像：

```json
{
	"dockerImage": "claude-code-runner:latest",
	"buildImage": true
}
```

这对以下场景很有用：

- **开发**：在本地定制镜像
- **团队工作流**：构建一致的环境
- **CI/CD 流水线**：生成自定义版本

## 功能特性

### Podman 支持

Claude Code Runner 还支持 Podman 作为 Docker 的替代方案。该工具通过检查可用的套接字路径自动检测你是使用 Docker 还是 Podman：

- **自动检测**: 工具在标准位置检查 Docker 和 Podman 套接字
- **自定义套接字路径**: 使用 `dockerSocketPath` 配置选项指定自定义套接字
- **环境变量**: 设置 `DOCKER_HOST` 来覆盖套接字检测

> **重要提示**：如果你使用 Podman 的 rootless（无根）模式，需要启用 Podman socket 服务：
>
> ```bash
> systemctl --user enable --now podman.socket
> ```
>
> 验证 socket 服务是否正在运行：
>
> ```bash
> systemctl --user status podman.socket
> ```

Podman 的示例配置：

```json
{
	"dockerSocketPath": "/run/user/1000/podman/podman.sock"
}
```

工具将在以下情况下自动检测并使用 Podman：

- Docker 套接字不可用
- 在标准位置找到 Podman 套接字（`/run/podman/podman.sock` 或 `$XDG_RUNTIME_DIR/podman/podman.sock`）

### SSH 和 GPG 密钥支持

Claude Code Runner 会自动将你的 SSH 和 GPG 密钥转发到容器中，让你可以无缝地对任何远程仓库（GitHub、GitLab、Bitbucket、自托管等）进行 git 操作。

#### 自动 SSH 密钥转发

默认情况下，你的 `~/.ssh` 目录会自动挂载到容器中并设置正确的权限：

- ✅ 支持所有 git 托管提供商（不仅仅是 GitHub）
- ✅ 支持 SSH 协议（`git@github.com:user/repo.git`）
- ✅ 自动处理密钥权限
- ✅ 支持多个 SSH 密钥

**对于带密码的 SSH 密钥**，在运行 `claude-run` 之前先在宿主机上启动 SSH agent：

```bash
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_rsa  # 输入你的密码
claude-run  # SSH agent 会被转发到容器
```

容器将使用宿主机的 SSH agent，因此你无需再次输入密码。

#### GPG 密钥支持

来自 `~/.gnupg` 的 GPG 密钥也会自动转发到容器。但是，**GPG 提交签名默认是禁用的**，以避免在非交互式环境中出现密码提示。

**要启用 GPG 提交签名**，在 `claude-run.config.json` 中添加：

```json
{
  "enableGpgSigning": true
}
```

> **注意**：GPG 签名需要一个没有密码的 GPG 密钥，或正确配置 GPG agent。为了安全起见，建议考虑使用 SSH 提交签名。

#### 禁用 SSH/GPG 转发

如果你不想转发密钥，可以禁用此功能：

```json
{
  "forwardSshKeys": false,
  "forwardGpgKeys": false,
  "forwardSshAgent": false
}
```

#### Git 配置

你的 git 配置（姓名、邮箱等）会自动从宿主机复制。容器已预先配置为：

- 自动接受所有 SSH 主机密钥（为了安全，请在首次连接时手动验证）
- 使用 SSH agent 进行身份验证
- 同时支持 SSH 和 HTTPS 协议

**对于使用令牌的 HTTPS**，设置 `GITHUB_TOKEN` 环境变量或使用内置的 `gh` CLI 令牌发现功能。

### Web UI 终端

启动基于浏览器的终端界面以与 Claude Code 交互：

```bash
claude-run --web
```

这将：

- 以分离模式启动容器
- 在 `http://localhost:3456` 上启动 Web 服务器
- 自动打开浏览器
- 提供完整的终端界面，具有：
  - 实时终端流
  - 复制/粘贴支持
  - 终端调整大小
  - 重新连接功能

非常适合在处理其他任务时监控 Claude 的工作。

### 自动凭证发现

Claude Code Runner 会自动发现并转发：

**Claude 凭证：**

- Anthropic API 密钥 (`ANTHROPIC_API_KEY`)
- macOS 钥匙串凭证（Claude Code）
- AWS Bedrock 凭证
- Google Vertex 凭证
- Claude 配置文件（`.claude.json`、`.claude/`）

**GitHub 凭证：**

- GitHub CLI 身份验证（`gh auth`）
- GitHub 令牌（`GITHUB_TOKEN`、`GH_TOKEN`）
- Git 配置（`.gitconfig`）

### 沙箱执行

- Claude 使用 `--dangerously-skip-permissions` 标志运行（在容器中安全）
- 为每个会话创建隔离的分支
- 在容器内完全访问运行任何命令
- 文件被复制到容器中（而不是挂载），实现真正的隔离
- 保留 Git 历史以进行适当的版本控制

### 提交监控

当 Claude 进行提交时：

1. 出现实时通知
2. 显示带语法高亮的完整差异
3. 交互式菜单提供选项：
   - 继续工作
   - 将分支推送到远程
   - 推送分支并创建 PR
   - 退出

### 使用多个容器

同时运行多个 Claude 实例：

```bash
# 终端 1: 启动主开发
claude-run start --name main-dev

# 终端 2: 启动功能分支工作
claude-run start --name feature-auth

# 终端 3: 列出所有运行中的容器
claude-run list

# 终端 4: 附加到任何容器
claude-run attach
```

## Docker 环境

### 默认镜像

默认 Docker 镜像包含：

- AlmaLinux 10
- Git、GitHub CLI
- Node.js、npm
- Python 3
- Claude Code
- 构建必需工具

### 自定义 Dockerfile

创建自定义环境：

```dockerfile
FROM claude-code-runner:latest

# 添加你的工具
RUN apt-get update && apt-get install -y \
    rust \
    cargo \
    postgresql-client

# 安装项目依赖
COPY package.json /tmp/
RUN cd /tmp && npm install

# 自定义配置
ENV CUSTOM_VAR=value
```

在配置中引用：

```json
{
	"dockerfile": "./my-custom.Dockerfile"
}
```

## 工作流示例

1. **启动 Claude Runner：**

   ```bash
   cd my-project
   claude-run
   ```

2. **与 Claude 交互：**

   ```
   > 帮我重构认证模块以使用 JWT 令牌
   ```

3. **Claude 自主工作：**

   - 探索代码库
   - 进行更改
   - 运行测试
   - 提交更改

4. **审查并推送：**
   - 查看提交通知
   - 审查带语法高亮的差异
   - 选择推送并创建 PR

## 安全考虑

- 凭证以只读方式挂载
- 容器与宿主机隔离
- 分支限制可防止意外修改主分支
- 所有更改在推送前需要明确的用户批准

## 故障排除

### Docker 权限问题

将你的用户添加到 docker 组：

```bash
sudo usermod -aG docker $USER
# 注销并重新登录以使更改生效
```

### 容器清理

删除所有 Claude Runner 容器和镜像：

```bash
npm run purge-containers
```

### 凭证发现失败

显式设置凭证：

```bash
export ANTHROPIC_API_KEY=your-key
export GITHUB_TOKEN=your-token
```

或使用 `.env` 文件配合 `envFile` 配置选项。

### 构建错误

确保使用 Node.js >= 22.13.0：

```bash
node --version
```

## 开发

### 从源代码构建

从源代码构建和开发 Claude Code Runner：

```bash
git clone https://gitlab.soraharu.com/XiaoXi/claude-code-runner.git
cd claude-code-runner
npm install
npm run build
npm link  # 创建全局 'claude-run' 命令
```

### 可用脚本

- `npm run build` - 将 TypeScript 构建为 JavaScript
- `npm run dev` - 开发的监视模式
- `npm start` - 构建并运行 CLI
- `npm run lint` - 运行 ESLint
- `npm run fix` - 运行 ESLint 并修复格式错误
- `npm run purge-containers` - 清理所有容器

## 贡献

1. Fork 仓库
2. 创建功能分支
3. 进行更改
4. 运行代码检查：`npm run lint`
5. 提交拉取请求

## 感谢

[claude-code-sandbox](https://github.com/textcortex/claude-code-sandbox)

## 许可证

MIT
