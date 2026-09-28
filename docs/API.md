# API 与模型映射

监听地址 `http://127.0.0.1:19900`（端口可通过 `.env` 调整）。除 `/health` 外，接口需要 `Authorization: Bearer <local-api-key>` 或 `x-api-key: <local-api-key>`。本地 Key 与 Trae 账号 Token 是不同凭据。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 本地存活状态，不代表上游账号可用 |
| GET | `/v1/status` | 检查当前 Trae 企业登录是否有效 |
| GET | `/v1/models` | 当前账号可用目录、别名、上下文限制、档位选项 |
| POST | `/v1/chat/completions` | OpenAI Chat Completions 兼容接口 |
| POST | `/v1/messages` | Anthropic Messages 兼容接口 |

不实现 OpenAI Responses API，也不提供后台管理、账号导出或执行客户端工具的服务端接口。工具由调用客户端执行，代理仅传递工具定义、调用参数和结果。

## 请求示例

```json
{
  "model": "glm-5.3",
  "messages": [{"role": "user", "content": "17 * 23 等于多少？"}],
  "stream": true,
  "max_tokens": 2048,
  "reasoning_effort": "high"
}
```

模型必须来自自己的 `/v1/models`，示例名称不保证每个账号都启用。输出上限会限制在目录公布的模型上限内。

## 强度输入

- Trae 原生：`reasoning_effort_level: light | high | extra_high`。
- OpenAI：`reasoning_effort: low | medium | high | xhigh`，也接受 `reasoning.effort`。
- Anthropic：`output_config.effort: low | medium | high | max`。
- 映射：low→light、medium/high→high、xhigh/max→extra_high。
- 明确选择目录中的 `effort_variants[].id`（如 `glm-5.3@extra_high`）或其桌面别名，将固定该档位。
- 优先级：固定档位型号 > reasoning_effort_level > output_config.effort > reasoning_effort > reasoning.effort > 模型默认。
- 无法读取能力元数据时，不猜测档位；基础聊天仍可使用上游默认值，显式不支持的档位报 400。
- 不将 Anthropic `thinking.budget_tokens` 猜测换算成 Trae 档位。

`X-Trae-Model`、`X-Trae-Reasoning-Effort` 响应头及脱敏成功日志显示实际转发值。

## 兼容范围

支持文本、多模态目录允许的图像、OpenAI/Anthropic 工具结构、多轮工具结果、推理内容、流式 usage、SSE UTF-8 分片和 JSON 工具参数分片。不能将 API 接受请求等同于对所有客户端扩展字段的完整支持。未启用模型不会通过改名变得可用。
