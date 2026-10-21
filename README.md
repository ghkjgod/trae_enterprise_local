# Trae Enterprise Local

基于 [ZedeX/trae-local-api](https://github.com/ZedeX/trae-local-api) 的 **Trae CN 企业版本地适配项目**，向 Claude Code CLI、Claude 桌面端和 OpenCode 提供 OpenAI / Anthropic 兼容接口。

原始基线：[`f394031edf48b22c73901380d42a78ce2d00a67e`](https://github.com/ZedeX/trae-local-api/tree/f394031edf48b22c73901380d42a78ce2d00a67e)。来源与文件级改动见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目不属于 Trae 官方。

**许可说明：上游仅声明“本项目仅供学习和研究使用。”，未附标准开源许可证。本仓库如实保留该声明，不擅自标注 MIT / Apache，也不宣称已经获得标准开源授权。详见 [LICENSE](LICENSE)。**

## 功能

- 从当前 Windows 用户已登录的 Trae CN 企业版读取认证信息，每次请求重新读取以跟随正常登录刷新；不把账号令牌写入仓库或日志。
- 查询企业账号实际启用的模型目录；按精确型号转发，未知型号报错，不静默替换为其他模型。
- `/v1/chat/completions` 与 `/v1/messages`，支持流式、非流式回复、推理内容和原生工具调用。
- 正确拼接长工具参数与交错分片，处理 SSE UTF-8 跨块字符。
- 完整响应按调用 ID 区分工具，兼容多个调用都返回 `index: 0`；DeepSeek V4.1 Flash 两个版本采用上游完整响应，避免尾部输出丢失。
- 将 OpenAI / Anthropic 思考强度字段映射到 Trae 的 `light`、`high`、`extra_high`；按各模型实际能力开放档位。
- 为 Claude 桌面端生成中性路由别名；菜单显示真实模型及档位。一个 Trae 配置即可承载多模型选择。
- 仅监听 `127.0.0.1`，客户端使用独立随机本地 API Key。
- 登录后后台启动，每分钟检查代理存活；每五分钟同步模型到已配置的 OpenCode 和 CC Switch。

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

后台启动/停止：`./Start-TraeAPI.ps1`、`./Stop-TraeAPI.ps1`。启动脚本优先使用项目内 `runtime/node.exe`，否则使用 PATH 中的 Node.js，要求 24+。

执行 `./scripts/Install-Startup.ps1` 安装当前用户计划任务 `Trae Enterprise Local Recovery`：登录时启动，每分钟检查一次本地 `/health`，进程退出后自动启动；连续三次本地检查失败时，仅重启经 PID、路径、命令行和创建时间核对的本项目进程。重复检查不会启动多个代理，也不会调用模型或消耗账号额度。任务允许电池供电时运行；睡眠期间不检查，恢复后继续检查。它是用户登录后的后台任务，不是无人登录也运行的系统服务。

手动执行 Stop 会暂停自动恢复，手动执行 Start 恢复运行。重启前保存 stdout/stderr，各保留十份历史文件；启动结果保存在 `service-logs/startup.log`。安装成功后会将旧的一次性启动快捷方式移到本机 `data/startup-shortcut-backup/`，避免重复配置。卸载自动恢复可执行 `Unregister-ScheduledTask -TaskName 'Trae Enterprise Local Recovery' -Confirm:$false`。

计划任务通过 `Start-TraeAPI-Hidden.vbs` 无窗口运行，避免每分钟闪出终端。Windows 复用旧 PID 时，会忽略过期记录并启动代理，不终止其他进程。

自动恢复处理本地进程退出或无响应；登录过期、网络中断、账号额度不足、上游接口变化仍需分别处理。登录过期时在 Trae 正常重新登录即可，代理会重新读取认证，无需复制令牌。`/health` 只表示本地进程可响应；带本地 API Key 的 `/v1/status` 检查本机登录信息，`/v1/models` 和实际聊天请求用于验证上游。

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

首次导入后，自动同步要求 OpenCode 配置存在原生 `providers.trae-enterprise`，且 CC Switch 数据库中存在 `app_type=opencode`、`id=trae-enterprise` 的提供商。启动脚本每五分钟读取一次上游目录，只更新这个提供商，保留其他提供商、密钥引用和默认模型；变更前备份到本机 `data/model-sync-backups/`。目录为空或读取失败时保留已有配置。可执行 `npm run sync:models` 立即同步，状态见 `data/model-sync-state.json`。

模型列表变化后会请求 OpenCode 后台重新加载。OpenCode 2.0.18 可能隐藏未设置可见性的新模型，因此同步器会在桌面客户端退出后，把新模型标为显示，保留用户主动隐藏的旧模型及最近使用记录。如果列表尚未出现新模型，退出客户端后等待一次每分钟检查，再重新打开；状态中的 `waiting_for_desktop_exit` 表示正在等待退出。

Claude CLI 2.1.242+ 支持自定义 `modelPicker`，配置后重新打开 CLI，用 `/model` 选择真实模型及档位。桌面端使用 CC Switch 的 Claude Desktop 第三方配置入口，应用配置后重新打开桌面端。

OpenCode 2.x 模型旁选择变体：`low`＝轻、`high`＝高、`xhigh`＝极高；`upstream` 使用模型默认档位。CLI 示例：

```text
opencode run --model trae-enterprise/glm-5.3-flash#xhigh "你的问题"
```

## 思考强度与 API

详见 [docs/API.md](docs/API.md)。模型能力来自本机 Trae 只读元数据，并与企业接口当前启用目录匹配；模型不支持的显式档位返回 400。

Claude 第三方模型不一定显示原生 Effort 控件，可以选择 `Trae / 模型 / 轻、高、极高` 这样的模型项。固定档位模型项优先于客户端自动附带的默认 effort。这里的“极高”与 Trae 独立的 Max 上下文开关不是同一功能。

DeepSeek V4.1 Flash（包括 1017）的原生推理档位是 `low / high / max`，默认 `high`；直接传 `xhigh` 会按 `high` 处理。本代理的 OpenCode Xhigh 发送 Trae `extra_high`，对应 Trae“极高”；Trae 到 DeepSeek 原生 `max` 的最终映射尚未公开。详见 [DeepSeek 官方说明](https://api-docs.deepseek.com/guides/thinking_mode/)。OpenCode 2.0.18 的模型提示框可能显示“不支持推理”，该版本界面转换代码把 reasoning 标记固定为 false；接口的 `reasoning_content` 和档位参数仍正常工作。

## 验证与边界

```powershell
npm test
git add .
npm run check:public
```

离线测试使用随机测试密钥和合成数据，不调用真实账号。企业部署中已验证多模型三档请求、Claude 两轮 Read 工具调用和 OpenCode low/xhigh 变体。公开包不携带原部署的日志、会话或账号证据；上游未来变更仍需重新核验。

2026-10-21 的部署验证覆盖两个 DeepSeek V4.1 Flash 版本，各完成两次读取、两次编辑、再次两次读取校验。完整响应按 ID 分开后，多工具调用的 JSON 错误消失。已检查现成实现：[Trae2api-cn 的 Python 累积器](https://github.com/autumnsentiment/Trae2api-cn/blob/def10807db7b2db38115676be3292f248ec5db92/src/sse.py#L768)处理了重复 index，但依赖其内部模块；[anghunk 的 TypeScript 转换器](https://github.com/anghunk/trae-proxy/blob/d0ede732de00cecf1aaae85f5f83eefd9eb32a5c/src/solo-bridge.ts)回放同类响应仍保留重复 index。因此继续使用现有 ZedeX 基础，只保留企业接口所需的小范围兼容处理。

本地响应头和日志证明所转发的型号与档位，不能保证某个档位在每一次问题上都产生更长推理。账号登录到期应在 Trae 正常刷新。接口与认证存储格式不是稳定的官方第三方 API，可能随客户端更新改变。

## 隐私与来源

提交文件经过白名单整理和敏感信息检查。`.env`、生成配置、账号存储、数据库、日志、运行时缓存、备份和依赖目录都不应提交。检查器只能辅助检查，不能替代对待提交 diff 的人工检查。更多说明见 [SECURITY.md](SECURITY.md)。
