/**
 * 视觉模型客户端，调用 OpenAI 兼容的 Chat Completions 接口
 * （`POST {baseUrl}/chat/completions`），发送包含 image_url 的
 * multimodal 消息，取回文本描述。
 *
 * 兼容绝大多数国内外提供 OpenAI 兼容协议的视觉模型服务
 * （OpenAI、通义千问 DashScope、智谱 GLM、月之暗面 Kimi、
 * 硅基流动 SiliconFlow、Ollama 等）。
 */

import type { VisionProviderConfig } from "./config.js";

const DEFAULT_TIMEOUT_MS = 60_000;

export class VisionApiError extends Error {}

export interface DescribeImageParams {
  provider: VisionProviderConfig;
  dataUri: string;
  prompt: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  error?: { message?: string };
}

function extractText(body: ChatCompletionResponse): string {
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && (part.type === "text" || typeof part.text === "string"))
      .map((part) => part.text ?? "")
      .join("");
  }
  return "";
}

export async function describeImage({ provider, dataUri, prompt }: DescribeImageParams): Promise<string> {
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const timeoutMs = provider.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUri } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new VisionApiError(`调用视觉模型 "${provider.name}" 超时（${timeoutMs}ms）`);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new VisionApiError(`调用视觉模型 "${provider.name}" 失败：${reason}`);
  } finally {
    clearTimeout(timer);
  }

  const rawText = await response.text();
  let body: ChatCompletionResponse;
  try {
    body = JSON.parse(rawText) as ChatCompletionResponse;
  } catch {
    throw new VisionApiError(
      `视觉模型 "${provider.name}" 返回了非 JSON 响应（HTTP ${response.status}）：${rawText.slice(0, 500)}`,
    );
  }

  if (!response.ok) {
    const message = body.error?.message ?? rawText.slice(0, 500);
    throw new VisionApiError(`视觉模型 "${provider.name}" 返回错误（HTTP ${response.status}）：${message}`);
  }

  const text = extractText(body).trim();
  if (!text) {
    throw new VisionApiError(`视觉模型 "${provider.name}" 返回了空结果`);
  }
  return text;
}
