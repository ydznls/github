const json = (data, status, origin) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-pbl-access",
    "vary": "Origin",
  },
});

function allowedOrigin(request, env) {
  const origin = request.headers.get("origin") || "";
  const configured = (env.ALLOWED_ORIGIN || "https://ydznls.github.io").replace(/\/$/, "");
  if (origin === configured || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return configured;
}

function cleanText(value, limit) {
  return typeof value === "string" ? value.replace(/\u0000/g, "").trim().slice(0, limit) : "";
}

function modelUrl(env) {
  if (env.MODEL_API_URL) return env.MODEL_API_URL;
  const base = (env.MODEL_API_BASE || "https://api.deepseek.com").replace(/\/$/, "");
  return `${base}/chat/completions`;
}

function parseModelJson(content) {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text || "").join("") : "";
  const fenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(fenced); } catch {}
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(fenced.slice(start, end + 1));
  throw new Error("模型没有返回有效 JSON");
}

function validateDeck(deck, questions) {
  if (!deck || !Array.isArray(deck.sections)) throw new Error("模型返回内容缺少 sections");
  const sections = questions.map((question) => {
    const section = deck.sections.find((item) => Number(item?.questionNumber) === question.number);
    if (!section || !Array.isArray(section.slides) || section.slides.length < 6) throw new Error(`问题 ${question.number} 的内容不足 6 页`);
    return {
      questionNumber: question.number,
      question: question.text,
      slides: section.slides.slice(0, 6).map((slide) => ({
        title: cleanText(slide?.title, 40) || "问题解释",
        body: cleanText(slide?.body, 1600),
        sourceRefs: Array.isArray(slide?.sourceRefs) ? slide.sourceRefs.map((item) => cleanText(item, 160)).filter(Boolean).slice(0, 5) : [],
      })),
    };
  });
  return { deckTitle: cleanText(deck.deckTitle, 80), sections };
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    if (request.method === "OPTIONS") return json({ ok: true }, 200, origin);
    const url = new URL(request.url);
    if (!env.APP_ACCESS_TOKEN) return json({ ok: false, error: "服务端尚未配置访问口令" }, 503, origin);
    if (request.headers.get("x-pbl-access") !== env.APP_ACCESS_TOKEN) return json({ ok: false, error: "访问口令不正确" }, 401, origin);

    if (request.method === "GET" && url.pathname === "/health") {
      if (!env.MODEL_API_KEY || !env.MODEL_NAME) return json({ ok: false, error: "服务端尚未配置模型密钥或模型名称" }, 503, origin);
      return json({ ok: true, model: env.MODEL_NAME }, 200, origin);
    }

    if (request.method !== "POST" || url.pathname !== "/generate") return json({ error: "Not found" }, 404, origin);
    if (!env.MODEL_API_KEY || !env.MODEL_NAME) return json({ error: "服务端尚未配置 MODEL_API_KEY 或 MODEL_NAME" }, 503, origin);

    try {
      const raw = await request.json();
      const caseText = cleanText(raw.caseText, 20000);
      const keywords = cleanText(raw.keywords, 2000);
      const questions = Array.isArray(raw.questions) ? raw.questions.slice(0, 4).map((item) => ({ number: Number(item?.number), text: cleanText(item?.text, 800) })).filter((item) => item.number >= 1 && item.number <= 4 && item.text) : [];
      let remaining = 180000;
      const documents = Array.isArray(raw.documents) ? raw.documents.slice(0, 20).map((item) => {
        const text = cleanText(item?.text, Math.min(50000, remaining));
        remaining -= text.length;
        return { name: cleanText(item?.name, 180) || "未命名文献", text };
      }).filter((item) => item.text) : [];

      if (!caseText || !questions.length) return json({ error: "病例和问题不能为空" }, 400, origin);
      if (!documents.length) return json({ error: "请至少提供一篇可读取的文献" }, 400, origin);

      const sourceText = documents.map((document, index) => `【文献 ${index + 1}：${document.name}】\n${document.text}`).join("\n\n");
      const system = `你是医学 PBL 循证汇报助手。只能依据用户提供的病例和文献写作，不得捏造研究、数值、指南推荐或参考文献。证据不足时必须明确写“所提供文献不足以确定”。输出必须是合法 JSON，不要使用 Markdown 代码块。`;
      const prompt = `请为以下 PBL 病例生成演示文稿正文。每个问题必须恰好生成 6 张内容页，系统会另行添加问题序号页，因此不要生成封面、序号页或结束页。\n\n每个问题的 6 页依次承担这些功能：\n1. 解释问题和核心概念\n2. 说明相关医学基础或机制\n3. 提取病例中的相关线索\n4. 说明检测标准、判断标准或治疗选择标准\n5. 综合所提供的文献证据\n6. 直接回答问题并说明适用边界\n\n每页 body 使用清晰中文，建议 180 至 450 字。sourceRefs 只能填写下方真实提供的文献名称。\n\n返回格式：\n{"deckTitle":"标题","sections":[{"questionNumber":1,"question":"问题原文","slides":[{"title":"页标题","body":"正文","sourceRefs":["文献名称"]}]}]}\n\n病例：\n${caseText}\n\n关键词：\n${keywords}\n\n问题：\n${questions.map((question) => `${question.number}. ${question.text}`).join("\n")}\n\n文献：\n${sourceText}`;

      const modelResponse = await fetch(modelUrl(env), {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${env.MODEL_API_KEY}` },
        body: JSON.stringify({ model: env.MODEL_NAME, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], temperature: 0.2, max_tokens: Number(env.MAX_OUTPUT_TOKENS || 12000) }),
      });
      const modelResult = await modelResponse.json().catch(() => ({}));
      if (!modelResponse.ok) {
        const message = modelResult?.error?.message || modelResult?.message || `上游模型请求失败（${modelResponse.status}）`;
        return json({ error: message }, 502, origin);
      }

      const content = modelResult?.choices?.[0]?.message?.content;
      const deck = validateDeck(parseModelJson(content), questions);
      return json({ ...deck, model: env.MODEL_NAME, usage: { inputTokens: modelResult?.usage?.prompt_tokens, outputTokens: modelResult?.usage?.completion_tokens } }, 200, origin);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "生成失败" }, 500, origin);
    }
  },
};
