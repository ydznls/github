# PBL Copilot AI 网关

这个网关把公开网页与 DeepSeek 隔开，避免 API Key 出现在浏览器代码中。网页可以在 `deepseek-v4-flash` 和 `deepseek-v4-pro` 之间切换，两种模型共用同一个 DeepSeek API Key。

## 配置

1. 将 `wrangler.toml.example` 复制为 `wrangler.toml`。
2. 默认配置已经设置 `FLASH_MODEL_NAME` 和 `PRO_MODEL_NAME`，无需修改即可对比两种模型。
3. 使用 `wrangler secret put MODEL_API_KEY` 保存模型密钥。不要把密钥提交到 GitHub。
4. 使用 `wrangler secret put APP_ACCESS_TOKEN` 设置你自己的网页访问口令，避免其他人消耗你的模型额度。
5. 使用 `wrangler deploy` 部署。
6. 把部署得到的 HTTPS 地址和访问口令填入 PBL Copilot，点击“测试连接”。

## 私有教材库

1. 登录 Cloudflare 后创建 D1 数据库 `pbl-textbook-library`。
2. 将返回的数据库 ID 写入 `wrangler.toml` 的 `TEXTBOOK_DB` 绑定。
3. 在本地教材库运行 `export_d1_sql.py`，生成仅供私有导入的 `textbook_library_d1.sql`。
4. 使用 `wrangler d1 execute pbl-textbook-library --remote --file=../textbook-library/textbook_library_d1.sql --yes` 导入。
5. `/health` 会返回教材库连接状态和可检索教材数量。公开网页只能通过带访问口令的 Worker 检索相关片段，无法直接下载教材数据库。

如果供应商给出完整的聊天接口地址，可以设置 `MODEL_API_URL`，它会覆盖 `MODEL_API_BASE`。

## 前端接口

- `GET /health`：检查模型名称和密钥是否已配置。
- `POST /generate`：接收病例、问题和分类后的教材/前沿资料，返回每个问题 6 张内容页。其中4页依据教材、2页呈现前沿证据与综合回答，约为70:30。前沿文献会绑定到对应的问题编号。网页会自动添加起始页、问题序号页和结束页。
