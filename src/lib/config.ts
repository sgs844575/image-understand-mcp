/**
 * 配置加载模块。
 *
 * 所有配置均通过环境变量传入（在 MCP 客户端配置的 `env` 字段中设置）。
 * 支持配置一个或多个视觉模型 "provider"，纯文本模型通过 MCP 工具
 * 的 `provider` 参数选择使用哪一个（未指定时使用默认 provider）。
 *
 * 单模型场景（最简单）：
 *   VISION_BASE_URL, VISION_API_KEY, VISION_MODEL
 *
 * 多模型场景：
 *   VISION_PROVIDERS = JSON 数组字符串，例如：
 *   [
 *     {"name":"gpt4o","baseUrl":"https://api.openai.com/v1","apiKey":"sk-...","model":"gpt-4o"},
 *     {"name":"qwen-vl","baseUrl":"https://dashscope.aliyuncs.com/compatible-mode/v1","apiKey":"sk-...","model":"qwen-vl-plus"}
 *   ]
 *   VISION_DEFAULT_PROVIDER = "gpt4o"  (可选，缺省用数组第一个)
 */

export interface VisionProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 单次请求超时时间（毫秒），默认 60000 */
  timeoutMs?: number;
}

export interface AppConfig {
  providers: VisionProviderConfig[];
  defaultProviderName: string;
}

export class ConfigError extends Error {}

function loadFromMultiEnv(): VisionProviderConfig[] {
  const raw = process.env.VISION_PROVIDERS;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`VISION_PROVIDERS 不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new ConfigError("VISION_PROVIDERS 必须是一个 JSON 数组");
  }
  return parsed.map((item, idx) => {
    if (typeof item !== "object" || item === null) {
      throw new ConfigError(`VISION_PROVIDERS[${idx}] 必须是对象`);
    }
    const obj = item as Record<string, unknown>;
    for (const field of ["name", "baseUrl", "apiKey", "model"]) {
      if (typeof obj[field] !== "string" || !obj[field]) {
        throw new ConfigError(`VISION_PROVIDERS[${idx}].${field} 缺失或不是非空字符串`);
      }
    }
    return {
      name: obj.name as string,
      baseUrl: obj.baseUrl as string,
      apiKey: obj.apiKey as string,
      model: obj.model as string,
      timeoutMs: typeof obj.timeoutMs === "number" ? obj.timeoutMs : undefined,
    };
  });
}

function loadFromSingleEnv(): VisionProviderConfig[] {
  const baseUrl = process.env.VISION_BASE_URL;
  const apiKey = process.env.VISION_API_KEY;
  const model = process.env.VISION_MODEL;
  if (!baseUrl && !apiKey && !model) return [];
  const missing = ["VISION_BASE_URL", "VISION_API_KEY", "VISION_MODEL"].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new ConfigError(`缺少必需的环境变量：${missing.join(", ")}`);
  }
  const timeoutMs = process.env.VISION_TIMEOUT_MS ? Number(process.env.VISION_TIMEOUT_MS) : undefined;
  return [{ name: "default", baseUrl: baseUrl!, apiKey: apiKey!, model: model!, timeoutMs }];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const multi = loadFromMultiEnv();
  const single = multi.length === 0 ? loadFromSingleEnv() : [];
  const providers = multi.length > 0 ? multi : single;

  if (providers.length === 0) {
    throw new ConfigError(
      "未找到视觉模型配置。请设置 VISION_BASE_URL / VISION_API_KEY / VISION_MODEL，" +
        "或设置 VISION_PROVIDERS（JSON 数组）来配置多个模型。",
    );
  }

  const names = new Set<string>();
  for (const p of providers) {
    if (names.has(p.name)) {
      throw new ConfigError(`provider 名称重复："${p.name}"`);
    }
    names.add(p.name);
  }

  const requestedDefault = env.VISION_DEFAULT_PROVIDER;
  let defaultProviderName: string;
  if (requestedDefault) {
    if (!names.has(requestedDefault)) {
      throw new ConfigError(`VISION_DEFAULT_PROVIDER="${requestedDefault}" 未在 provider 列表中找到`);
    }
    defaultProviderName = requestedDefault;
  } else {
    defaultProviderName = providers[0].name;
  }

  return { providers, defaultProviderName };
}
