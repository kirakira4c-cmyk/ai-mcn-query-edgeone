const DEFAULT_SYSTEM_PROMPT =
  "你是百度搜索场景营销的热点分析与 Query 策划 Agent。你必须先理解热点是什么、包含哪些人物/作品/事件/争议/规则/数据，再生成相关热点词、脑暴扩散和百度 Query。只输出一个合法 JSON 对象，不要输出 Markdown、代码块、解释文字。不要机械套模板，不要生成新闻标题、营销标题、论文式长句。";

const FEISHU_API_BASE_URL = "https://open.feishu.cn/open-apis";
const FEISHU_EXPORT_FIELDS = [
  { name: "批次ID", type: "text" },
  { name: "生成时间", type: "datetime" },
  { name: "热点标题", type: "text" },
  { name: "Query", type: "text" },
  { name: "搜索意图", type: "text" },
  { name: "分数", type: "number" },
  { name: "推荐理由", type: "text" },
  { name: "导图节点", type: "text" },
  { name: "人工方向", type: "text" },
  { name: "来源链接", type: "text" },
];

let feishuToken = "";
let feishuTokenExpiresAt = 0;

export default function onRequest(context) {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }
  if (context.request.method === "GET") {
    return onRequestGet();
  }
  return sendJson({ error: "Method not allowed" }, 405);
}

export async function onRequestPost(context) {
  const url = new URL(context.request.url);
  const pathname = url.pathname.replace(/^\/api/, "");

  try {
    if (pathname === "/generate") {
      return handleGenerate(context);
    }
    if (pathname === "/expand") {
      return handleExpand(context);
    }
    if (pathname === "/feishu/export") {
      return handleFeishuExport(context);
    }
    return sendJson({ error: "Not found" }, 404);
  } catch (error) {
    return sendJson(
      {
        error: error.message || "Server error",
        detail: error.detail,
      },
      error.statusCode || 500,
    );
  }
}

export function onRequestGet() {
  return sendJson({ error: "Method not allowed" }, 405);
}

async function handleGenerate(context) {
  const config = getRuntimeConfig(context);
  if (!config.AI_API_KEY) {
    return sendJson({ error: "Missing DEEPSEEK_API_KEY or AI_API_KEY." }, 400);
  }

  const body = await readJson(context.request);
  const ai = await requestAiJson(config, buildPrompt(body), {
    temperature: 0.7,
    timeoutMs: 55_000,
  });

  return sendJson({
    model: config.AI_MODEL,
    raw: ai.raw,
    result: ai.result,
  });
}

async function handleExpand(context) {
  const config = getRuntimeConfig(context);
  if (!config.AI_API_KEY) {
    return sendJson({ error: "Missing DEEPSEEK_API_KEY or AI_API_KEY." }, 400);
  }

  const body = await readJson(context.request);
  const ai = await requestAiJson(config, buildExpandPrompt(body), {
    temperature: 0.95,
    timeoutMs: 35_000,
  });

  return sendJson({
    model: config.AI_MODEL,
    raw: ai.raw,
    result: ai.result,
  });
}

async function handleFeishuExport(context) {
  const config = getRuntimeConfig(context);
  if (!config.FEISHU_APP_ID || !config.FEISHU_APP_SECRET || !config.FEISHU_BASE_TOKEN || !config.FEISHU_BASE_TABLE_ID) {
    return sendJson(
      {
        error: "Missing FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_BASE_TOKEN or FEISHU_BASE_TABLE_ID.",
      },
      400,
    );
  }

  const body = await readJson(context.request);
  const queries = Array.isArray(body.queries) ? body.queries : [];
  if (!queries.length) {
    return sendJson({ error: "没有可导入的 Query。" }, 400);
  }

  const fields = await ensureFeishuBaseFields(config);
  const rows = buildFeishuRows(body);
  const chunks = chunkArray(rows, 100);
  const recordIds = [];
  for (const chunk of chunks) {
    const response = await createFeishuBaseRecords(config, chunk, fields);
    const ids = response.data?.record_id_list || response.data?.records?.map((record) => record.record_id) || [];
    recordIds.push(...ids);
  }

  return sendJson({
    ok: true,
    rows: rows.length,
    recordIds,
    url: config.FEISHU_BASE_URL || `https://www.feishu.cn/base/${config.FEISHU_BASE_TOKEN}`,
  });
}

function getRuntimeConfig(context) {
  const env = context.env || {};
  const get = (key, fallback = "") => env[key] || globalThis.process?.env?.[key] || fallback;
  return {
    AI_BASE_URL: get("AI_BASE_URL", "https://api.deepseek.com"),
    AI_MODEL: get("AI_MODEL", "deepseek-v4-flash"),
    AI_API_KEY: get("DEEPSEEK_API_KEY") || get("AI_API_KEY"),
    FEISHU_APP_ID: get("FEISHU_APP_ID"),
    FEISHU_APP_SECRET: get("FEISHU_APP_SECRET"),
    FEISHU_BASE_TOKEN: get("FEISHU_BASE_TOKEN"),
    FEISHU_BASE_TABLE_ID: get("FEISHU_BASE_TABLE_ID"),
    FEISHU_BASE_URL: get("FEISHU_BASE_URL"),
  };
}

async function requestAiJson(config, prompt, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);
  const requestBody = {
    model: config.AI_MODEL,
    messages: [
      {
        role: "system",
        content: DEFAULT_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    response_format: { type: "json_object" },
    temperature: options.temperature,
    stream: false,
  };

  try {
    const response = await fetch(`${config.AI_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.AI_API_KEY}`,
      },
      signal: controller.signal,
      body: JSON.stringify(requestBody),
    });
    const responseText = await response.text();
    const data = parseJsonPayload(responseText);
    if (!response.ok) {
      const error = new Error(data?.error?.message || data?.msg || "AI request failed");
      error.statusCode = response.status;
      error.detail = data || { bodyStart: responseText.slice(0, 300) };
      throw error;
    }
    if (!data) {
      const error = new Error("AI provider returned invalid JSON");
      error.statusCode = 502;
      error.detail = { bodyStart: responseText.slice(0, 300) };
      throw error;
    }

    const raw = data.choices?.[0]?.message?.content || "";
    return {
      raw,
      result: parseJsonFromModel(raw),
    };
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("AI request timed out");
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function ensureFeishuBaseFields(config) {
  const current = await listFeishuBaseFields(config);
  const existingNames = new Set(current.map(getFeishuFieldName).filter(Boolean));
  for (const field of FEISHU_EXPORT_FIELDS) {
    if (existingNames.has(field.name)) continue;
    await createFeishuBaseField(config, field);
  }
  const updated = await listFeishuBaseFields(config);
  const fieldByName = new Map(updated.map((field) => [getFeishuFieldName(field), field]));
  return FEISHU_EXPORT_FIELDS.map((field) => {
    const baseField = fieldByName.get(field.name);
    if (!baseField) {
      throw new Error(`飞书字段缺失：${field.name}`);
    }
    return baseField;
  });
}

async function createFeishuBaseRecords(config, rows, fields) {
  const fieldByName = new Map(fields.map((field) => [getFeishuFieldName(field), field]));
  const records = rows.map((row) => ({
    fields: FEISHU_EXPORT_FIELDS.reduce((result, field, index) => {
      result[field.name] = normalizeFeishuCellValue(field.name, row[index], fieldByName.get(field.name));
      return result;
    }, {}),
  }));

  return requestFeishu(
    config,
    `/bitable/v1/apps/${encodeURIComponent(config.FEISHU_BASE_TOKEN)}/tables/${encodeURIComponent(
      config.FEISHU_BASE_TABLE_ID,
    )}/records/batch_create`,
    {
      method: "POST",
      body: {
        records,
      },
    },
  );
}

function buildFeishuRows(body) {
  const result = body.result || {};
  const input = result.input || {};
  const queries = Array.isArray(body.queries) ? body.queries : [];
  const mindmapNodes = Array.isArray(body.mindmapNodes) ? body.mindmapNodes : [];
  const batchId = `mcn-${Date.now()}`;
  const generatedAt = Date.now();
  const title = input.title || "";
  const manualDirections = input.manualDirections || "";
  const sourceSummary = Array.isArray(input.sources)
    ? input.sources.map((source) => `${source.tag || "来源"}: ${source.value || ""}`).join("\n")
    : "";

  return queries.map((query) => [
    batchId,
    generatedAt,
    title,
    query.text || "",
    query.intent || "",
    Number.isFinite(Number(query.score)) ? Number(query.score) : null,
    query.reason || "",
    findRelatedMindNodes(query.text || "", mindmapNodes),
    manualDirections,
    sourceSummary,
  ]);
}

function findRelatedMindNodes(text, mindmapNodes) {
  const normalizedText = text.replace(/\s+/g, "");
  const matches = mindmapNodes
    .filter((node) => node.type !== "root" && node.label)
    .filter((node) => {
      const label = String(node.label).replace(/\s+/g, "");
      return label.length >= 2 && normalizedText.includes(label);
    })
    .sort((a, b) => b.depth - a.depth)
    .slice(0, 3)
    .map((node) => node.label);

  return Array.from(new Set(matches)).join(" / ");
}

function formatFeishuDateTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:00`;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function listFeishuBaseFields(config) {
  const fields = [];
  let pageToken = "";
  do {
    const search = new URLSearchParams({ page_size: "100" });
    if (pageToken) search.set("page_token", pageToken);
    const response = await requestFeishu(
      config,
      `/bitable/v1/apps/${encodeURIComponent(config.FEISHU_BASE_TOKEN)}/tables/${encodeURIComponent(
        config.FEISHU_BASE_TABLE_ID,
      )}/fields?${search.toString()}`,
    );
    fields.push(...(response.data?.items || []));
    pageToken = response.data?.page_token || "";
    if (!response.data?.has_more) break;
  } while (pageToken);
  return fields;
}

async function createFeishuBaseField(config, field) {
  return requestFeishu(
    config,
    `/bitable/v1/apps/${encodeURIComponent(config.FEISHU_BASE_TOKEN)}/tables/${encodeURIComponent(
      config.FEISHU_BASE_TABLE_ID,
    )}/fields`,
    {
      method: "POST",
      body: {
        field_name: field.name,
        type: field.type === "number" ? 2 : 1,
      },
    },
  );
}

function getFeishuFieldName(field) {
  return field?.field_name || field?.name || "";
}

function getFeishuFieldType(field) {
  return Number(field?.type || field?.field_type || 0);
}

function normalizeFeishuCellValue(fieldName, value, field) {
  const fieldType = getFeishuFieldType(field);

  if (fieldType === 2) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  }

  if (fieldType === 5) {
    if (Number.isFinite(Number(value))) return Number(value);
    const timestamp = Date.parse(String(value || "").replace(" ", "T"));
    return Number.isFinite(timestamp) ? timestamp : Date.now();
  }

  if (value === null || value === undefined) return "";
  if (fieldName === "生成时间" && Number.isFinite(Number(value))) {
    return formatFeishuDateTime(new Date(Number(value)));
  }
  return String(value);
}

async function getFeishuTenantAccessToken(config) {
  if (feishuToken && feishuTokenExpiresAt > Date.now()) {
    return feishuToken;
  }

  const response = await fetch(`${FEISHU_API_BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      app_id: config.FEISHU_APP_ID,
      app_secret: config.FEISHU_APP_SECRET,
    }),
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    const error = new Error(data.msg || "获取飞书 tenant_access_token 失败");
    error.detail = data;
    throw error;
  }

  const expireSeconds = Number(data.expire || 7200);
  feishuToken = data.tenant_access_token;
  feishuTokenExpiresAt = Date.now() + Math.max(60, expireSeconds - 120) * 1000;
  return feishuToken;
}

async function requestFeishu(config, pathname, options = {}) {
  const token = await getFeishuTenantAccessToken(config);
  const response = await fetch(`${FEISHU_API_BASE_URL}${pathname}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0) {
    const error = new Error(data.msg || `飞书 OpenAPI 请求失败：${pathname}`);
    error.detail = data;
    throw error;
  }
  return data;
}

function buildPrompt(payload) {
  return JSON.stringify(
    {
      task: "基于热点、人工方向建议和问题方向配置，生成符合真实用户搜索习惯的热点 Query 策划结果。",
      output_schema: {
        summary: "热点理解，1-2句。必须说明这个热点为什么值得搜。",
        category: "热点分类",
        emotion: "情绪/讨论状态",
        recommendation: "推荐结论",
        reasons: ["推荐或谨慎理由"],
        hotspotAnalysis: {
          core: "这个热点的本质是什么",
          entities: ["涉及的人物、节目、作品、品牌、地点等"],
          userQuestions: ["真实用户看到后会产生的问题"],
          searchOpportunities: ["适合百度搜索承接的机会点"],
        },
        relatedHotspots: [
          {
            label: "相关热点词，例如王濛",
            meta: "为什么相关",
            expansions: [
              {
                label: "下一层扩散词，例如王濛职业生涯",
                meta: "扩散类型，例如人物履历",
              },
            ],
          },
        ],
        questionAngles: [
          {
            type: "问题方向名称",
            intent: "搜索意图",
            fit: "0-100",
            reason: "为什么适合这个方向",
            queries: ["示例 Query"],
          },
        ],
        queries: [
          {
            text: "Query",
            intent: "搜索意图",
            score: "0-100",
            reason: "推荐理由",
          },
        ],
      },
      rules: [
        "不要先套为什么、是什么、规则/机制这些固定方向。必须先拆解热点实体。",
        "如果热点是综艺，例如乘风2026，先拆参演人员、节目赛制、排名、争议、名场面、人物履历、冷知识，不要生成“乘风2026和网友什么关系”这类无意义 Query。",
        "relatedHotspots 是脑暴导图第一圈节点。每个 relatedHotspots.expansions 是点击该节点后出现的下一圈节点。",
        "relatedHotspots.expansions 不必都包含父节点原词，可以跳到相邻概念、同类作品、设定、人物、粉圈黑话、争议、剧情细节、演员八卦。",
        "每个扩散词必须贴合该实体的特征。",
        "人工方向建议优先于系统自动方向。",
        "每个方向生成 5-10 条 Query。",
        "Query 要短、自然、像真实用户吃瓜、八卦、求证时会搜的话，不要带平台或产品字眼。",
        "queries、questionAngles.queries、relatedHotspots.label、relatedHotspots.expansions.label 里禁止出现“百度”“文心助手”“AI总结”“截图”“大字报”等产品化或内容形式词。",
        "relatedHotspots.expansions 要能继续深挖，不要停留在泛泛分类词。",
        "不要生成新闻标题、营销标题、公众号标题、论文式表达。",
      ],
      input: payload,
    },
    null,
    2,
  );
}

function buildExpandPrompt(payload) {
  return JSON.stringify(
    {
      task: "为热点脑暴导图的当前节点继续发散下一层搜索话题词。",
      output_schema: {
        nodes: [
          {
            label: "下一层搜索话题词",
            meta: "扩散理由或类型，8字以内",
          },
        ],
      },
      rules: [
        "输出 6-8 个 nodes。",
        "必须像真实用户会搜的词或短句，适合吃瓜、八卦、追剧、考古、求证、找同类内容。",
        "不要机械使用“当前节点 + 怎么回事/为什么/真实情况”的句式。",
        "至少一半结果不要包含当前节点原词，可以跳到相邻概念、人物、作品、设定、类型、粉圈黑话、争议点、同类作品、演员八卦、原著考古、剧情细节。",
        "越到深层越要发散，不要重复上层路径，不要只改后缀。",
        "禁止出现“百度”“文心助手”“AI总结”“截图”“大字报”等产品化或内容形式词。",
        "不要输出 Markdown，只输出 JSON。",
      ],
      context: {
        rootTopic: payload.rootTopic,
        currentNode: payload.currentNode,
        currentDepth: payload.currentDepth,
        path: payload.path,
        existingLabels: payload.existingLabels,
        hotspotSummary: payload.hotspotSummary,
        hotspotEntities: payload.hotspotEntities,
        manualDirections: payload.manualDirections,
      },
    },
    null,
    2,
  );
}

function parseJsonFromModel(content) {
  const cleaned = String(content || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const extracted = extractJsonObject(cleaned);
    if (!extracted) return null;
    try {
      return JSON.parse(extracted);
    } catch {
      return null;
    }
  }
}

function parseJsonPayload(content) {
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    const extracted = extractJsonObject(String(content));
    if (!extracted) return null;
    try {
      return JSON.parse(extracted);
    } catch {
      return null;
    }
  }
}

function extractJsonObject(content) {
  const start = content.indexOf("{");
  if (start === -1) return "";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < content.length; index += 1) {
    const char = content[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;

    if (depth === 0) {
      return content.slice(start, index + 1);
    }
  }

  return "";
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    const error = new Error("Invalid JSON body");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
