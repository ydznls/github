# PBL Copilot AI 网关

这个网关把公开网页与国内大模型隔开，避免 API Key 出现在浏览器代码中。它兼容提供 OpenAI `chat/completions` 接口的模型服务，例如 DeepSeek、通义千问兼容模式、豆包方舟兼容接口和智谱兼容接口。

## 配置

1. 将 `wrangler.toml.example` 复制为 `wrangler.toml`。
2. 修改 `MODEL_API_BASE` 和 `MODEL_NAME`。
3. 使用 `wrangler secret put MODEL_API_KEY` 保存模型密钥。不要把密钥提交到 GitHub。
4. 使用 `wrangler secret put APP_ACCESS_TOKEN` 设置你自己的网页访问口令，避免其他人消耗你的模型额度。
5. 使用 `wrangler deploy` 部署。
6. 把部署得到的 HTTPS 地址和访问口令填入 PBL Copilot，点击“测试连接”。

如果供应商给出完整的聊天接口地址，可以设置 `MODEL_API_URL`，它会覆盖 `MODEL_API_BASE`。

## 前端接口

- `GET /health`：检查模型名称和密钥是否已配置。
- `POST /generate`：接收病例、问题和已解析的文献正文，返回每个问题 6 张内容页。网页会自动添加起始页、问题序号页和结束页。
