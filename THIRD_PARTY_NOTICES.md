# 来源与许可

## 原始仓库

- 作者/维护者：ZedeX 及其贡献者。
- 仓库：https://github.com/ZedeX/trae-local-api
- 使用基线：[`f394031edf48b22c73901380d42a78ce2d00a67e`](https://github.com/ZedeX/trae-local-api/tree/f394031edf48b22c73901380d42a78ce2d00a67e)。
- 本项目从该基线的本地安装衍生出企业适配器；没有导入整个上游 Git 历史、网页管理端、账号数据或旧的通用代理。

## 文件级来源

| 文件 | 来源/改动 |
|---|---|
| `src/trae-decrypt.js` | 从上述 commit 原样保留（允许 Git 换行规范化），用于读取用户本人已登录 Trae 的本地认证存储 |
| `src/enterprise-server.js` | 在本地适配过程中新增，调用上游认证解码器；实现企业目录、OpenAI/Anthropic 转换、工具参数分片、模型别名与强度转发 |
| `src/reasoning-effort.js` | 新增；只读本机 Trae 模型能力元数据，并映射档位 |
| `tests/` | 新增/整理的纯合成离线测试；没有真实账号、业务会话或账户模型目录 |
| `scripts/`、根目录启动脚本、文档 | 为可公开分发的源码包整理；路径按当前用户/项目计算 |

`src/trae-decrypt.js` 原始文件 SHA-256：
`d9cd73a2d98c75be5f67954b6ad2f53ba4de8005b37094c32b475e8a95f95202`

上游解码器中的固定格式常量/SALT 数组来自上述公开文件，不是使用者的账号 Token、API Key 或私钥。企业接口主机、请求头兼容常量是客户端协议元数据；运行时 Authorization 来自用户自己的本地登录，并不包含在仓库里。

## 许可状态

该基线 README 仅声明“本项目仅供学习和研究使用。”未提供标准开源许可证。完整说明见 [LICENSE](LICENSE)。本仓库没有擅自补写 MIT 或 Apache 许可，也不代表 Trae 官方项目。npm 依赖（dotenv、express、node-fetch 及其传递依赖）遵守各包随附许可证。

协议参考：[Trae 企业版模型与思考强度](https://docs.trae.cn/enterprise_model-settings-for-trae-enterprise)、[OpenCode 2.x 模型配置](https://opencode.ai/v2/docs/models)。平台代码、安装包和反汇编资料不在本仓库内。
