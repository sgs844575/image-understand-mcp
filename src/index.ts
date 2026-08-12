#!/usr/bin/env node
/**
 * image-understand-mcp
 *
 * 让纯文本模型也具备图片理解能力的 MCP 服务：
 * 纯文本模型通过调用本服务提供的工具，把图片转交给配置好的
 * 视觉模型（vision-capable model）分析，再把文字结果返回给
 * 调用方模型继续使用。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ConfigError, loadConfig, type AppConfig } from "./lib/config.js";
import { ImageLoadError, loadImage } from "./lib/imageLoader.js";
import { VisionApiError, describeImage } from "./lib/visionClient.js";

const DEFAULT_PROMPT = "请详细描述这张图片的内容，包括图中的文字、物体、人物、场景和整体氛围。";

function log(message: string): void {
  // MCP 用 stdio 传输协议消息，日志必须写到 stderr，不能用 console.log。
  console.error(`[image-understand-mcp] ${message}`);
}

function buildProviderEnumDescription(config: AppConfig): string {
  const names = config.providers.map((p) => (p.name === config.defaultProviderName ? `${p.name}（默认）` : p.name));
  return `选择使用哪个视觉模型 provider，可选：${names.join(", ")}。不填则使用默认 provider。`;
}

function main(): void {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      log(`配置错误：${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  log(
    `已加载 ${config.providers.length} 个视觉模型 provider：${config.providers
      .map((p) => `${p.name}(${p.model})`)
      .join(", ")}；默认 provider：${config.defaultProviderName}`,
  );

  const server = new McpServer({
    name: "image-understand-mcp",
    version: "1.0.0",
  });

  const providerNames = config.providers.map((p) => p.name) as [string, ...string[]];

  server.registerTool(
    "understand_image",
    {
      title: "图片理解",
      description:
        "分析一张图片并返回详细的文字描述。用于让不具备视觉能力的纯文本模型间接" +
        "'看懂'图片：传入本地文件路径、图片 URL 或 base64 编码数据，本工具会调用" +
        "配置好的视觉模型完成识别，并返回自然语言描述文本。" +
        "适合需要理解截图、照片、图表、文档扫描件等内容的场景。",
      inputSchema: {
        image: z
          .string()
          .describe(
            "图片来源，支持三种形式：1) 本地文件绝对/相对路径，如 C:\\a.png 或 ./a.png；" +
              "2) HTTP(S) 图片 URL；3) data URI 或裸 base64 编码字符串。",
          ),
        prompt: z
          .string()
          .optional()
          .describe(
            `想让视觉模型回答的具体问题或分析要求，例如"提取图中的所有文字"" 、判断图中有几个人"。` +
              `不填则使用默认提示词，返回图片的通用详细描述。`,
          ),
        provider: z
          .enum(providerNames)
          .optional()
          .describe(buildProviderEnumDescription(config)),
        mimeType: z
          .string()
          .optional()
          .describe("仅当 image 为裸 base64 字符串且无法从内容判断格式时使用，例如 image/png、image/jpeg。"),
      },
    },
    async ({ image, prompt, provider, mimeType }) => {
      const providerConfig =
        config.providers.find((p) => p.name === (provider ?? config.defaultProviderName)) ?? config.providers[0];

      try {
        const loaded = await loadImage(image, mimeType);
        const description = await describeImage({
          provider: providerConfig,
          dataUri: loaded.dataUri,
          prompt: prompt?.trim() || DEFAULT_PROMPT,
        });
        return {
          content: [{ type: "text", text: description }],
        };
      } catch (err) {
        if (err instanceof ImageLoadError || err instanceof VisionApiError) {
          return {
            content: [{ type: "text", text: `图片理解失败：${err.message}` }],
            isError: true,
          };
        }
        const reason = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `图片理解出现未预期的错误：${reason}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "list_vision_providers",
    {
      title: "列出可用视觉模型",
      description: "列出当前 MCP 服务配置的所有视觉模型 provider 及其名称、模型标识，以及默认使用哪一个。",
      inputSchema: {},
    },
    async () => {
      const list = config.providers.map((p) => ({
        name: p.name,
        model: p.model,
        isDefault: p.name === config.defaultProviderName,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
      };
    },
  );

  const transport = new StdioServerTransport();
  server
    .connect(transport)
    .then(() => log("MCP server 已启动，等待连接..."))
    .catch((err) => {
      log(`启动失败：${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });

  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await server.close();
    process.exit(0);
  });
}

main();
