/**
 * 图片加载与归一化模块。
 *
 * 支持三种输入形式，统一转换成可直接放进 OpenAI 兼容
 * `image_url` 字段的 data URI：
 *   1. 本地文件路径（绝对或相对路径）
 *   2. HTTP(S) URL
 *   3. 已经是 data URI（`data:image/...;base64,...`）或裸 base64 字符串
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const EXT_MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

const DATA_URI_RE = /^data:([^;,]+);base64,/i;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export interface LoadedImage {
  dataUri: string;
  mimeType: string;
  /** 供日志/错误信息使用，不含 base64 正文 */
  sourceDescription: string;
}

export class ImageLoadError extends Error {}

function guessMimeFromExt(pathOrUrl: string): string | undefined {
  const match = pathOrUrl.toLowerCase().match(/\.[a-z0-9]+$/);
  if (!match) return undefined;
  return EXT_MIME_MAP[match[0]];
}

function bytesToMime(bytes: Uint8Array): string | undefined {
  // 常见图片格式的魔数嗅探，作为 Content-Type / 扩展名缺失时的兜底
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp";
  }
  return undefined;
}

async function loadFromLocalPath(path: string): Promise<LoadedImage> {
  const absolutePath = isAbsolute(path) ? path : resolve(process.cwd(), path);
  let buffer: Buffer;
  try {
    buffer = await readFile(absolutePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ImageLoadError(`无法读取本地图片文件 "${absolutePath}": ${reason}`);
  }
  const mimeType = guessMimeFromExt(absolutePath) ?? bytesToMime(buffer) ?? "application/octet-stream";
  return {
    dataUri: `data:${mimeType};base64,${buffer.toString("base64")}`,
    mimeType,
    sourceDescription: `本地文件 ${absolutePath}`,
  };
}

async function loadFromUrl(url: string): Promise<LoadedImage> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ImageLoadError(`下载图片失败 "${url}": ${reason}`);
  }
  if (!response.ok) {
    throw new ImageLoadError(`下载图片失败 "${url}": HTTP ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
  const mimeType =
    (contentType && contentType.startsWith("image/") ? contentType : undefined) ??
    guessMimeFromExt(url) ??
    bytesToMime(bytes) ??
    "application/octet-stream";
  return {
    dataUri: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
    mimeType,
    sourceDescription: `URL ${url}`,
  };
}

/**
 * 加载并归一化一张图片。
 *
 * @param image 本地路径 / HTTP(S) URL / data URI / 裸 base64 字符串
 * @param mimeType 当 image 为裸 base64 字符串时，用于指定 MIME 类型（默认 image/png）
 */
export async function loadImage(image: string, mimeType?: string): Promise<LoadedImage> {
  const trimmed = image.trim();
  if (!trimmed) {
    throw new ImageLoadError("image 参数不能为空");
  }

  const dataUriMatch = trimmed.match(DATA_URI_RE);
  if (dataUriMatch) {
    return { dataUri: trimmed, mimeType: dataUriMatch[1], sourceDescription: "内联 data URI" };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return loadFromUrl(trimmed);
  }

  // 裸 base64：长度较长且只包含 base64 字符集，且不像文件路径
  if (trimmed.length > 100 && BASE64_RE.test(trimmed) && !trimmed.includes("/") && !trimmed.includes("\\")) {
    const resolvedMime = mimeType ?? "image/png";
    return { dataUri: `data:${resolvedMime};base64,${trimmed}`, mimeType: resolvedMime, sourceDescription: "内联 base64 数据" };
  }

  return loadFromLocalPath(trimmed);
}
