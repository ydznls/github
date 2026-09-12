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

function configuredModels(env) {
  return {
    flash: env.FLASH_MODEL_NAME || "deepseek-v4-flash",
    pro: env.PRO_MODEL_NAME || "deepseek-v4-pro",
  };
}

function countOccurrences(text, term) {
  if (!term) return 0;
  return text.toLocaleLowerCase().split(term.toLocaleLowerCase()).length - 1;
}

async function textbookLibraryStatus(env) {
  if (!env.TEXTBOOK_DB) return { connected: false, books: 0 };
  try {
    const row = await env.TEXTBOOK_DB.prepare("SELECT COUNT(*) AS books FROM books WHERE searchable = 1").first();
    return { connected: true, books: Number(row?.books || 0) };
  } catch {
    return { connected: false, books: 0 };
  }
}

async function retrieveTextbookDocuments(env, questions) {
  if (!env.TEXTBOOK_DB) return [];
  const requests = [];
  for (const question of questions) {
    for (const term of question.terms.slice(0, 4)) {
      requests.push({
        questionNumber: question.number,
        term,
        statement: env.TEXTBOOK_DB.prepare("SELECT p.book_id, b.title, p.page_number, p.text FROM pages p JOIN books b ON b.id = p.book_id WHERE b.searchable = 1 AND p.text LIKE ? LIMIT 30").bind(`%${term}%`),
      });
    }
  }
  if (!requests.length) return [];
  const responses = await env.TEXTBOOK_DB.batch(requests.map((request) => request.statement));
  const candidates = new Map();
  responses.forEach((response, index) => {
    const request = requests[index];
    for (const row of response?.results || []) {
      const key = `${request.questionNumber}:${row.book_id}:${row.page_number}`;
      const old = candidates.get(key) || { questionNumber: request.questionNumber, bookId: row.book_id, title: row.title, pageNumber: row.page_number, text: row.text, score: 0, matched: new Set() };
      old.score += Math.max(1, countOccurrences(String(row.text || ""), request.term));
      old.matched.add(request.term);
      candidates.set(key, old);
    }
  });
  const documents = [];
  for (const question of questions) {
    const ranked = [...candidates.values()].filter((item) => item.questionNumber === question.number).sort((a, b) => b.matched.size - a.matched.size || b.score - a.score || a.pageNumber - b.pageNumber);
    const perBook = new Map();
    for (const item of ranked) {
      if (documents.filter((document) => document.questionNumber === question.number).length >= 8) break;
      const used = perBook.get(item.bookId) || 0;
      if (used >= 3) continue;
      perBook.set(item.bookId, used + 1);
      documents.push({ name: `${item.title} 第${item.pageNumber}页`, text: cleanText(item.text, 2800), kind: "textbook", discipline: item.title, questionNumber: question.number });
    }
  }
  return documents;
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
      if (!env.MODEL_API_KEY) return json({ ok: false, error: "服务端尚未配置模型密钥" }, 503, origin);
      return json({ ok: true, models: configuredModels(env), textbookLibrary: await textbookLibraryStatus(env) }, 200, origin);
    }

    if (request.method !== "POST" || url.pathname !== "/generate") return json({ error: "Not found" }, 404, origin);
    if (!env.MODEL_API_KEY) return json({ error: "服务端尚未配置 MODEL_API_KEY" }, 503, origin);

    try {
      const raw = await request.json();
      const modelTier = raw.modelTier === "pro" ? "pro" : "flash";
      const modelName = configuredModels(env)[modelTier];
      const caseText = cleanText(raw.caseText, 20000);
      const keywords = cleanText(raw.keywords, 2000);
      const questions = Array.isArray(raw.questions) ? raw.questions.slice(0, 4).map((item) => ({ number: Number(item?.number), text: cleanText(item?.text, 800), terms: Array.isArray(item?.terms) ? item.terms.map((term) => cleanText(term, 60)).filter((term) => term.length > 1).slice(0, 6) : [] })).filter((item) => item.number >= 1 && item.number <= 4 && item.text) : [];
      const fallbackTerms = keywords.split(/[，,、;；\n]/).map((term) => cleanText(term, 60)).filter((term) => term.length > 1).slice(0, 4);
      questions.forEach((question) => { if (!question.terms.length) question.terms = fallbackTerms; });
      let remaining = 110000;
      let documents = Array.isArray(raw.documents) ? raw.documents.slice(0, 20).map((item) => {
        const text = cleanText(item?.text, Math.min(50000, remaining));
        remaining -= text.length;
        return {
          name: cleanText(item?.name, 180) || "未命名文献",
          text,
          kind: item?.kind === "textbook" ? "textbook" : "frontier",
          discipline: item?.discipline === "internal" ? "内科学" : item?.discipline === "surgery" ? "外科学" : "",
          questionNumber: Number(item?.questionNumber) || 0,
        };
      }).filter((item) => item.text) : [];

      if (!caseText || !questions.length) return json({ error: "病例和问题不能为空" }, 400, origin);
      const libraryDocuments = await retrieveTextbookDocuments(env, questions);
      documents = [...documents, ...libraryDocuments];
      if (!documents.length) return json({ error: "教材库没有找到相关内容，且未提供可读取的文献" }, 400, origin);

      const textbookDocuments = documents.filter((document) => document.kind === "textbook");
      const frontierDocuments = documents.filter((document) => document.kind === "frontier");
      const sourceText = documents.map((document, index) => `【资料 ${index + 1}｜${document.kind === "textbook" ? `教材·${document.discipline || "未分类"}` : `前沿文献·问题${document.questionNumber || "未标注"}`}｜${document.name}】\n${document.text}`).join("\n\n");
      const system = `你是医学 PBL 循证汇报助手。只能依据用户提供的病例和文献写作，不得捏造研究、数值、指南推荐或参考文献。证据不足时必须明确写“所提供文献不足以确定”。输出必须是合法 JSON，不要使用 Markdown 代码块。`;
      const prompt = `请为以下 PBL 病例生成演示文稿正文。每个问题必须恰好生成 6 张内容页，系统会另行添加问题序号页，因此不要生成封面、序号页或结束页。\n\n必须执行“教材约70%、前沿约30%”的结构：\n1. 教材定义与问题解释（只从内科学/外科学教材提取）\n2. 教材中的病因、机制或病理生理（只从教材提取）\n3. 教材中的临床表现、病例对应与鉴别要点（只从教材提取）\n4. 教材中的检测标准、诊断标准或常规治疗原则（只从教材提取）\n5. 当前前沿治疗：综合归入本问题的指南、系统评价或临床研究\n6. 直接回答问题：以教材结论为基础，并用前沿证据补充变化、获益、局限与适用人群\n\n教材页不得引用前沿文献替代教材；前沿页不得把其他问题的文献混入本题。如果某类资料不足，对应页面必须明确写“所提供的教材/前沿文献不足以确定”，不得用常识补写。教材共 ${textbookDocuments.length} 份，前沿资料共 ${frontierDocuments.length} 份。每页 body 使用清晰中文，建议 180 至 450 字。sourceRefs 只能填写下方真实提供的资料名称。\n\n返回格式：\n{"deckTitle":"标题","sections":[{"questionNumber":1,"question":"问题原文","slides":[{"title":"页标题","body":"正文","sourceRefs":["资料名称"]}]}]}\n\n病例：\n${caseText}\n\n关键词：\n${keywords}\n\n问题：\n${questions.map((question) => `${question.number}. ${question.text}`).join("\n")}\n\n分类资料：\n${sourceText}`;

      const modelResponse = await fetch(modelUrl(env), {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${env.MODEL_API_KEY}` },
        body: JSON.stringify({ model: modelName, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], temperature: 0.2, max_tokens: Number(env.MAX_OUTPUT_TOKENS || 12000) }),
      });
      const modelResult = await modelResponse.json().catch(() => ({}));
      if (!modelResponse.ok) {
        const message = modelResult?.error?.message || modelResult?.message || `上游模型请求失败（${modelResponse.status}）`;
        return json({ error: message }, 502, origin);
      }

      const content = modelResult?.choices?.[0]?.message?.content;
      const deck = validateDeck(parseModelJson(content), questions);
      return json({ ...deck, model: modelName, modelTier, usage: { inputTokens: modelResult?.usage?.prompt_tokens, outputTokens: modelResult?.usage?.completion_tokens } }, 200, origin);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "生成失败" }, 500, origin);
    }
  },
};
