# image-understand-mcp

让**纯文本模型**也拥有图片理解能力的 MCP 服务。

## 原理

纯文本大模型本身无法处理图片，但可以调用 MCP 工具。本服务作为一个
"视觉能力代理"：

```
纯文本模型（Claude / GPT / 通义千问 等，无视觉能力）
      │  调用 MCP 工具 understand_image(image, prompt)
      ▼
image-understand-mcp（本服务）
      │  读取本地文件 / 下载 URL / 解析 base64 → data URI
      │  转发给你在配置中指定的视觉模型（OpenAI 兼容接口）
      ▼
视觉模型（GPT-4o / Qwen-VL / GLM-4V / Kimi-VL 等）
      │  返回图片的文字描述
      ▼
纯文本模型继续基于文字描述进行推理、回答
```

你只需要在 MCP 配置里填一个"看得懂图"的模型的 API 信息，任何纯文本模型
接入这个 MCP 后，就能通过调用工具"看图说话"。

## 功能

- **`understand_image`**：分析一张图片，返回详细文字描述或针对指定问题的回答。
  - `image` 支持三种输入：本地文件路径、HTTP(S) URL、data URI / 裸 base64。
  - `prompt` 可选，自定义想让视觉模型回答的问题（如"提取图中所有文字"）。
  - `provider` 可选，当配置了多个视觉模型时可指定使用哪一个。
- **`list_vision_providers`**：列出当前配置的所有视觉模型及默认使用的模型。

## 安装

```bash
npm install
npm run build
```

## 配置

所有配置通过环境变量传入（在 MCP 客户端的 `env` 字段中设置）。

### 方式一：单个视觉模型（最简单）

```json
{
  "mcpServers": {
    "image-understand": {
      "command": "node",
      "args": ["/path/to/image-understand-mcp/dist/index.js"],
      "env": {
        "VISION_BASE_URL": "https://api.openai.com/v1",
        "VISION_API_KEY": "sk-xxxxxxxx",
        "VISION_MODEL": "gpt-4o"
      }
    }
  }
}
```

适用于任何 OpenAI 兼容协议的视觉模型服务，例如：

| 服务商 | VISION_BASE_URL 示例 | VISION_MODEL 示例 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| 阿里通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-plus` |
| 智谱 AI | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-flash` |
| 月之暗面 Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k-vision-preview` |
| 硅基流动 SiliconFlow | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2-VL-72B-Instruct` |
| 本地 Ollama | `http://localhost:11434/v1` | `llava` |

### 方式二：配置多个视觉模型，供调用方按需选择

```json
{
  "mcpServers": {
    "image-understand": {
      "command": "node",
      "args": ["/path/to/image-understand-mcp/dist/index.js"],
      "env": {
        "VISION_PROVIDERS": "[{\"name\":\"gpt4o\",\"baseUrl\":\"https://api.openai.com/v1\",\"apiKey\":\"sk-xxx\",\"model\":\"gpt-4o\"},{\"name\":\"qwen-vl\",\"baseUrl\":\"https://dashscope.aliyuncs.com/compatible-mode/v1\",\"apiKey\":\"sk-yyy\",\"model\":\"qwen-vl-plus\"}]",
        "VISION_DEFAULT_PROVIDER": "gpt4o"
      }
    }
  }
}
```

配置后，纯文本模型调用 `understand_image` 时可传入 `provider: "qwen-vl"`
来指定使用哪个视觉模型；不指定则使用 `VISION_DEFAULT_PROVIDER`（缺省为
数组中的第一个）。

### 环境变量说明

| 变量 | 必填 | 说明 |
|---|---|---|
| `VISION_BASE_URL` | 二选一 | 视觉模型 API 的 base URL（不含 `/chat/completions`） |
| `VISION_API_KEY` | 二选一 | API Key |
| `VISION_MODEL` | 二选一 | 模型名称 |
| `VISION_TIMEOUT_MS` | 否 | 单次请求超时时间（毫秒），默认 60000 |
| `VISION_PROVIDERS` | 二选一 | JSON 数组，配置多个 provider（见上方示例） |
| `VISION_DEFAULT_PROVIDER` | 否 | 多 provider 时的默认 provider 名称 |

`VISION_PROVIDERS` 与 `VISION_BASE_URL`/`VISION_API_KEY`/`VISION_MODEL` 二选一；
若同时设置，优先使用 `VISION_PROVIDERS`。

## 本地开发

```bash
npm run dev          # 用 tsx 直接运行 src/index.ts
npm run build         # 编译到 dist/
npm run inspector      # 用 MCP Inspector 交互式调试（需先 build）
node scripts/smoke-test.mjs   # 端到端冒烟测试（mock 视觉模型 API，无需真实 API Key）
```

## 常见问题

**Q: 图片必须是什么格式？**
A: 支持常见格式（PNG/JPEG/WebP/GIF/BMP），本地路径按扩展名或文件头判断类型，
URL 优先用响应头 `Content-Type`。

**Q: 报错 "未找到视觉模型配置"？**
A: 检查是否正确设置了 `VISION_BASE_URL`/`VISION_API_KEY`/`VISION_MODEL`，
或 `VISION_PROVIDERS`。

**Q: 视觉模型返回错误？**
A: 工具会把视觉模型 API 返回的 HTTP 状态码和错误信息透传给调用方模型，
便于定位是 Key 无效、模型名不对，还是配额不足。
