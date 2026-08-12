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
    delta?: {
      content?: string;
      reasoning_content?: string;
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

/**
 * 判断响应是否为 SSE 流式格式。
 * 部分中转网关（如 ai.chatboxai.app）即使请求未带 stream: true，
 * 也会强制返回 text/event-stream，因此除了 Content-Type 还要看
 * 响应体是否以 "data:" 开头。
 */
function isSseResponse(rawText: string, contentType: string | null): boolean {
  return (contentType ?? "").includes("text/event-stream") || rawText.trimStart().startsWith("data:");
}

/**
 * 解析 SSE 流式响应（`data: {json}\n\n` 行序列），拼装 delta.content 文本。
 * 推理模型的 reasoning_content（思考过程）不属于最终答案，不拼入结果；
 * `data: [DONE]` 表示流结束；流内嵌的 error 会被收集并抛出。
 */
function extractStreamedText(rawText: string): string {
  let text = "";
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload) as ChatCompletionResponse;
      if (chunk.error?.message) {
        throw new VisionApiError(`视觉模型返回错误：${chunk.error.message}`);
      }
      const delta = chunk.choices?.[0]?.delta;
      if (typeof delta?.content === "string") {
        text += delta.content;
      }
    } catch (err) {
      if (err instanceof VisionApiError) throw err;
      // 忽略无法解析的行（例如心跳注释），继续处理后续分块
    }
  }
  return text;
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

  // 上游可能强制返回 SSE 流式响应（即使请求未带 stream: true），先识别再解析
  if (isSseResponse(rawText, response.headers.get("content-type"))) {
    const text = extractStreamedText(rawText).trim();
    if (!text) {
      throw new VisionApiError(`视觉模型 "${provider.name}" 返回了空结果`);
    }
    return text;
  }

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
