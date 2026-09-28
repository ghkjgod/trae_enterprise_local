# Trae Enterprise Local

基于 [ZedeX/trae-local-api](https://github.com/ZedeX/trae-local-api) 的 **Trae CN 企业版本地适配项目**，向 Claude Code CLI、Claude 桌面端和 OpenCode 提供 OpenAI / Anthropic 兼容接口。

原始基线：[`f394031edf48b22c73901380d42a78ce2d00a67e`](https://github.com/ZedeX/trae-local-api/tree/f394031edf48b22c73901380d42a78ce2d00a67e)。来源与文件级改动见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目不属于 Trae 官方。

**许可说明：上游仅声明“本项目仅供学习和研究使用。”，未附标准开源许可证。本仓库如实保留该声明，不擅自标注 MIT / Apache，也不宣称已经获得标准开源授权。详见 [LICENSE](LICENSE)。**

## 功能

- 从当前 Windows 用户已登录的 Trae CN 企业版读取认证信息，每次请求重新读取以跟随正常登录刷新；不把账号令牌写入仓库或日志。
- 查询企业账号实际启用的模型目录；按精确型号转发，未知型号报错，不静默替换为其他模型。
- `/v1/chat/completions` 与 `/v1/messages`，支持流式、非流式回复、推理内容和原生工具调用。
- 正确拼接长工具参数与交错分片，处理 SSE UTF-8 跨块字符。
- 将 OpenAI / Anthropic 思考强度字段映射到 Trae 的 `light`、`high`、`extra_high`；按各模型实际能力开放档位。
- 为 Claude 桌面端生成中性路由别名；菜单显示真实模型及档位。一个 Trae 配置即可承载多模型选择。
- 仅监听 `127.0.0.1`，客户端使用独立随机本地 API Key。

本次公开包仅包含企业代理所需代码，未包含上游 Dashboard、旧通用服务、Trae 安装包、账户目录、配置备份或真实使用日志。

## 安装与运行

要求：Windows、**Node.js 24+**、已安装且已登录的 **Trae CN 企业版账号**。个人版/国际版认证并非本适配器的支持范围。

```powershell
git clone git@github.com:ghkjgod/trae_enterprise_local.git
cd trae_enterprise_local
npm ci
npm run setup
npm start
```

`npm run setup` 只在 `.env` 不存在时生成随机本地 API Key，不打印密钥，不覆盖现有配置。默认端口 `19900`，默认模型 `qwen3.8-max`。在 `.env` 调整 `PORT`、`DEFAULT_MODEL`；指定型号必须在自己的账号目录中启用。可选 `TRAE_DATA_DIR` 指向 Trae CN 用户数据目录。

如需国内 npm 镜像，可执行 `npm ci --registry=https://registry.npmmirror.com`。依赖锁文件保留完整性哈希。

检查监听：

```powershell
Invoke-RestMethod http://127.0.0.1:19900/health
```

后台启动/停止：`./Start-TraeAPI.ps1`、`./Stop-TraeAPI.ps1`。可选执行 `./scripts/Install-Startup.ps1` 创建当前用户登录启动项；停止使用时，从 Windows 启动文件夹删除 `Trae Enterprise Local.lnk`。脚本不设置系统服务，也不修改执行策略。运行这些脚本的 Node.js 必须为 24+。

## 接入客户端

代理启动后执行：

```powershell
npm run export:clients
```

从当前账号目录生成 `generated/` 中的配置片段：

| 文件 | 用途 |
|---|---|
| `claude-settings.local.json` | Claude CLI 的 endpoint、认证、`modelPicker`；合并到用户设置或用作 CC Switch 的单一 Trae provider |
| `cc-switch-desktop.local.json` | CC Switch 桌面 provider 参数；使用 direct 模式指向本地代理，映射模型菜单 |
| `opencode.local.json` | OpenCode 2.x 的 `providers.trae-enterprise`、原生 variants 和 reasoning 内容兼容设置 |

**这些生成文件含本地 API Key，必须留在本机。** 导出程序不会覆盖现有客户端设置或 CC Switch 数据库。将所需字段合并到客户端配置，保留自己已有的其他提供商。不同 CC Switch 版本导入格式可能不同，导出的是字段配置片段。

Claude CLI 2.1.242+ 支持自定义 `modelPicker`，配置后重新打开 CLI，用 `/model` 选择真实模型及档位。桌面端使用 CC Switch 的 Claude Desktop 第三方配置入口，应用配置后重新打开桌面端。

OpenCode 2.x 模型旁选择变体：`low`＝轻、`high`＝高、`xhigh`＝极高；`upstream` 使用模型默认档位。CLI 示例：

```text
opencode run --model trae-enterprise/glm-5.3-flash#xhigh "你的问题"
```

## 思考强度与 API

详见 [docs/API.md](docs/API.md)。模型能力来自本机 Trae 只读元数据，并与企业接口当前启用目录匹配；模型不支持的显式档位返回 400。

Claude 第三方模型不一定显示原生 Effort 控件，可以选择 `Trae / 模型 / 轻、高、极高` 这样的模型项。固定档位模型项优先于客户端自动附带的默认 effort。这里的“极高”与 Trae 独立的 Max 上下文开关不是同一功能。

## 验证与边界

```powershell
npm test
git add .
npm run check:public
```

离线测试使用随机测试密钥和合成数据，不调用真实账号。企业部署中已验证多模型三档请求、Claude 两轮 Read 工具调用和 OpenCode low/xhigh 变体。公开包不携带原部署的日志、会话或账号证据；上游未来变更仍需重新核验。

本地响应头和日志证明所转发的型号与档位，不能保证某个档位在每一次问题上都产生更长推理。账号登录到期应在 Trae 正常刷新。接口与认证存储格式不是稳定的官方第三方 API，可能随客户端更新改变。

## 隐私与来源

提交文件经过白名单整理和敏感信息检查。`.env`、生成配置、账号存储、数据库、日志、运行时缓存、备份和依赖目录都不应提交。检查器只能辅助检查，不能替代对待提交 diff 的人工检查。更多说明见 [SECURITY.md](SECURITY.md)。
