/**
 * 简易冒烟测试：
 * 1. 启动一个本地 mock HTTP server，模拟 OpenAI 兼容的 /chat/completions 接口
 * 2. 通过 MCP SDK 的 Client + StdioClientTransport 启动真正的 dist/index.js 子进程
 * 3. 调用 list_vision_providers 和 understand_image 工具，验证返回结果
 *
 * 用法：node scripts/smoke-test.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// 1x1 红色像素 PNG
const RED_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let receivedRequestBody = null;

const mockServer = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    receivedRequestBody = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "这是一张 1x1 的纯红色图片。" } }],
      }),
    );
  });
});

await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
const port = mockServer.address().port;
console.log(`[smoke-test] mock vision API listening on http://127.0.0.1:${port}`);

const tmpDir = mkdtempSync(join(tmpdir(), "image-understand-mcp-"));
const imagePath = join(tmpDir, "red.png");
writeFileSync(imagePath, Buffer.from(RED_PIXEL_PNG_BASE64, "base64"));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist", "index.js")],
  env: {
    ...process.env,
    VISION_BASE_URL: `http://127.0.0.1:${port}`,
    VISION_API_KEY: "test-key",
    VISION_MODEL: "mock-vision-model",
  },
});

const client = new Client({ name: "smoke-test-client", version: "1.0.0" });
await client.connect(transport);

let failed = false;
function check(label, cond) {
  console.log(`${cond ? "PASS" : "FAIL"} - ${label}`);
  if (!cond) failed = true;
}

const tools = await client.listTools();
check(
  "工具列表包含 understand_image 和 list_vision_providers",
  tools.tools.some((t) => t.name === "understand_image") && tools.tools.some((t) => t.name === "list_vision_providers"),
);

const providersResult = await client.callTool({ name: "list_vision_providers", arguments: {} });
const providersText = providersResult.content[0].text;
check("list_vision_providers 返回默认 provider", providersText.includes("mock-vision-model") && providersText.includes('"isDefault": true'));

const imageResult = await client.callTool({
  name: "understand_image",
  arguments: { image: imagePath, prompt: "这张图是什么颜色？" },
});
check("understand_image 调用未报错", imageResult.isError !== true);
check("understand_image 返回了 mock 的描述文本", imageResult.content[0].text.includes("纯红色图片"));
check("发往视觉模型的请求包含 image_url data URI", JSON.stringify(receivedRequestBody).includes("data:image/png;base64,"));
check("发往视觉模型的请求携带了自定义 prompt", JSON.stringify(receivedRequestBody).includes("这张图是什么颜色"));
check("发往视觉模型的请求使用了配置的 model 名", receivedRequestBody.model === "mock-vision-model");

// 测试错误路径：不存在的本地文件
const errorResult = await client.callTool({
  name: "understand_image",
  arguments: { image: join(tmpDir, "not-exist.png") },
});
check("不存在的文件返回 isError=true", errorResult.isError === true);
check("错误信息包含可读原因", errorResult.content[0].text.includes("图片理解失败"));

await client.close();
mockServer.close();

if (failed) {
  console.error("\n[smoke-test] 存在失败用例");
  process.exit(1);
} else {
  console.log("\n[smoke-test] 全部通过");
}
