const STORAGE_KEY = "search-content-copilot-library";

const state = {
  currentResult: null,
  library: loadLibrary(),
  mindmap: {
    nodes: [],
    edges: [],
    selectedId: null,
    nextId: 1,
    removedLabels: new Set(),
    zoom: 1,
  },
};

const form = document.querySelector("#topicForm");
const summaryPanel = document.querySelector("#summaryPanel");
const resultGrid = document.querySelector("#resultGrid");
const queryList = document.querySelector("#queryList");
const saveBtn = document.querySelector("#saveBtn");
const libraryList = document.querySelector("#libraryList");
const clearLibraryBtn = document.querySelector("#clearLibraryBtn");
const copyQueriesBtn = document.querySelector("#copyQueriesBtn");
const exportFeishuBtn = document.querySelector("#exportFeishuBtn");
const feishuExportStatus = document.querySelector("#feishuExportStatus");
const addSourceBtn = document.querySelector("#addSourceBtn");
const suggestSourceBtn = document.querySelector("#suggestSourceBtn");
const sourceList = document.querySelector("#sourceList");
const questionDirectionGroup = document.querySelector("#questionDirectionGroup");
const queryDirectionConfig = window.QUERY_DIRECTION_CONFIG || [];
const mindmapSection = document.querySelector("#mindmapSection");
const mindmapCanvas = document.querySelector("#mindmapCanvas");
const mindmapLines = document.querySelector("#mindmapLines");
const mindmapNodes = document.querySelector("#mindmapNodes");
const expandSelectedNodeBtn = document.querySelector("#expandSelectedNodeBtn");
const collapseSelectedNodeBtn = document.querySelector("#collapseSelectedNodeBtn");
const resetMindmapBtn = document.querySelector("#resetMindmapBtn");
const zoomOutBtn = document.querySelector("#zoomOutBtn");
const zoomInBtn = document.querySelector("#zoomInBtn");
const zoomValue = document.querySelector("#zoomValue");
const submitButton = form.querySelector('button[type="submit"]');

addSourceBtn.addEventListener("click", () => {
  addSourceRow();
});

suggestSourceBtn.addEventListener("click", () => {
  suggestSocialSources();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const audiences = formData.getAll("audience").map(String);
  const input = {
    title: String(formData.get("topicTitle") || "").trim(),
    manualDirections: String(formData.get("manualDirections") || "").trim(),
    selectedDirectionIds: formData.getAll("questionDirection").map(String),
    sources: collectSources(),
    context: collectSources().map((source) => `${source.tag} ${source.value}`).join("\n"),
    audience: audiences.length ? audiences : ["吃瓜群众"],
    queryCount: Number(formData.get("queryCount") || 50),
  };

  if (!input.title) {
    return;
  }

  if (!input.sources.length) {
    addSuggestedSocialSources(input.title);
    input.sources = collectSources();
    input.context = input.sources.map((source) => `${source.tag} ${source.value}`).join("\n");
  }

  renderGeneratingState(input);
  submitButton.disabled = true;
  try {
    state.currentResult = await generatePlanSmart(input);
    renderResult(state.currentResult);
  } finally {
    submitButton.disabled = false;
  }
});

saveBtn.addEventListener("click", () => {
  if (!state.currentResult) {
    return;
  }

  const exists = state.library.some((item) => item.id === state.currentResult.id);
  state.library = exists
    ? state.library.map((item) => (item.id === state.currentResult.id ? state.currentResult : item))
    : [state.currentResult, ...state.library];
  saveLibrary(state.library);
  renderLibrary();
});

clearLibraryBtn.addEventListener("click", () => {
  state.library = [];
  saveLibrary(state.library);
  renderLibrary();
});

copyQueriesBtn.addEventListener("click", async () => {
  if (!state.currentResult) {
    return;
  }

  const text = getVisibleQueries(state.currentResult).map((item) => item.text).join("\n");
  await copyText(text);
  copyQueriesBtn.textContent = "已复制";
  setTimeout(() => {
    copyQueriesBtn.textContent = "复制";
  }, 1200);
});

exportFeishuBtn.addEventListener("click", async () => {
  if (!state.currentResult) return;

  exportFeishuBtn.disabled = true;
  exportFeishuBtn.textContent = "导入中";
  feishuExportStatus.textContent = "";
  try {
    const response = await fetch(getApiPath("/api/feishu/export"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        result: state.currentResult,
        queries: getVisibleQueries(state.currentResult),
        mindmapNodes: getVisibleMindNodes().map((node) => ({
          label: node.label,
          meta: node.meta,
          type: node.type,
          depth: node.depth,
        })),
      }),
    });
    const data = await readJsonResponse(response);
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || "飞书导入失败");
    }
    feishuExportStatus.innerHTML = data.url
      ? `已导入 ${data.rows} 条。<a href="${escapeHtml(data.url)}" target="_blank" rel="noreferrer">打开飞书表格</a>`
      : `已导入 ${data.rows} 条。`;
    exportFeishuBtn.textContent = "已导入";
  } catch (error) {
    feishuExportStatus.textContent = error.message || "飞书导入失败";
    exportFeishuBtn.textContent = "沉淀到飞书";
  } finally {
    exportFeishuBtn.disabled = false;
    setTimeout(() => {
      exportFeishuBtn.textContent = "沉淀到飞书";
    }, 1600);
  }
});

expandSelectedNodeBtn.addEventListener("click", () => {
  const selected = state.mindmap.nodes.find((node) => node.id === state.mindmap.selectedId);
  if (selected) {
    expandMindNode(selected.id);
  }
});

resetMindmapBtn.addEventListener("click", () => {
  if (state.currentResult) {
    initializeMindmap(state.currentResult);
    renderQueryList(state.currentResult);
  }
});

collapseSelectedNodeBtn.addEventListener("click", () => {
  const selected = state.mindmap.nodes.find((node) => node.id === state.mindmap.selectedId);
  if (selected) {
    collapseMindNode(selected.id);
  }
});

zoomOutBtn.addEventListener("click", () => {
  setMindmapZoom(state.mindmap.zoom - 0.1);
});

zoomInBtn.addEventListener("click", () => {
  setMindmapZoom(state.mindmap.zoom + 0.1);
});

async function generatePlanSmart(input) {
  if (!canUseAiServer()) {
    const localResult = generatePlan(input);
    localResult.generationMode = "本地规则";
    return localResult;
  }

  const localFallback = generatePlan({ ...input });
  try {
    const aiResult = await generateAiPlan(input);
    return normalizeAiResult(aiResult, localFallback);
  } catch (error) {
    localFallback.generationMode = "本地规则";
    localFallback.aiError = error.message || "AI 生成失败，已使用本地规则。";
    return localFallback;
  }
}

function canUseAiServer() {
  return location.protocol === "http:" || location.protocol === "https:";
}

function getApiPath(path) {
  const apiPath = path.startsWith("/") ? path : `/${path}`;
  const match = location.pathname.match(/^\/app\/app_[^/]+/);
  return match ? `${match[0]}${apiPath}` : apiPath;
}

async function generateAiPlan(input) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 50_000);

  try {
    const response = await fetch(getApiPath("/api/generate"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        input,
        directionConfig: queryDirectionConfig,
        historicalCases: window.HISTORICAL_QUERY_CASES || [],
      }),
    });
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(data?.error || "AI request failed");
    }
    if (!data?.result) {
      throw new Error("AI 返回内容不是可解析 JSON");
    }
    return data.result;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("AI 请求超过 50 秒未返回，已使用本地规则。");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const extracted = extractJsonObjectFromText(text);
    if (!extracted) return null;
    try {
      return JSON.parse(extracted);
    } catch {
      return null;
    }
  }
}

function extractJsonObjectFromText(content) {
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

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(start, index + 1);
      }
    }
  }

  return "";
}

function normalizeAiResult(aiResult, fallback) {
  const queries = Array.isArray(aiResult.queries)
    ? aiResult.queries.map((item, index) => ({
        id: `${index + 1}`,
        text: sanitizeQueryText(item.text || item.query || ""),
        intent: item.intent || "搜索意图",
        score: Number(item.score || 80),
        reason: item.reason || "AI 根据热点和方向建议推荐。",
      }))
    : fallback.queries;
  const questionAngles = Array.isArray(aiResult.questionAngles)
    ? aiResult.questionAngles.map((item) => ({
        type: item.type || item.direction || "问题方向",
        intent: item.intent || "搜索意图",
        fit: Number(item.fit || item.score || 80),
        reason: item.reason || "AI 根据热点判断适合这个方向。",
        queries: Array.isArray(item.queries) ? item.queries.map(sanitizeQueryText).filter(Boolean) : [],
      }))
    : fallback.questionAngles;

  return {
    ...fallback,
    generationMode: "AI 模型",
    summary: aiResult.summary || fallback.summary,
    category: aiResult.category || aiResult.detected_category || fallback.category,
    emotion: aiResult.emotion || fallback.emotion,
    recommendation: aiResult.recommendation || fallback.recommendation,
    hotspotAnalysis: aiResult.hotspotAnalysis || fallback.hotspotAnalysis || null,
    relatedHotspots: Array.isArray(aiResult.relatedHotspots)
      ? aiResult.relatedHotspots.map(sanitizeRelatedHotspot).filter((item) => item.label)
      : fallback.relatedHotspots || [],
    reasons: Array.isArray(aiResult.reasons) ? aiResult.reasons : fallback.reasons,
    questionAngles,
    intents: Array.from(new Set(questionAngles.map((angle) => angle.intent))),
    queries: queries.filter((query) => query.text),
    queryGroups: groupQueriesByIntent(queries.filter((query) => query.text)),
    xhs: Array.isArray(aiResult.xhs) ? aiResult.xhs : fallback.xhs,
  };
}

function generatePlan(input) {
  normalizeInput(input);
  const sourceText = input.sources.map((source) => `${source.tag} ${source.value}`).join(" ");
  const keywords = extractKeywords(`${input.title} ${input.context} ${sourceText}`);
  const subject = detectPrimarySubject(input.title, keywords);
  const second = keywords[1] || "网友";
  const third = keywords[2] || "原因";
  const score = calculateScore(input);
  const questionAngles = buildQuestionAngles(input, subject, second, third);
  const intents = Array.from(new Set(questionAngles.map((angle) => angle.intent)));
  const queries = buildQueries(input, subject, second, third, questionAngles);

  return {
    id: createId(),
    createdAt: new Date().toISOString(),
    input,
    summary: buildSummary(input, subject, second, third),
    category: detectCategory(input),
    emotion: detectEmotion(input.context || input.title),
    score,
    recommendation: score >= 75 ? "推荐优先制作" : score >= 60 ? "可制作，需加强角度" : "谨慎制作",
    hotspotAnalysis: null,
    relatedHotspots: [],
    reasons: buildReasons(input, score),
    questionAngles,
    intents,
    queries,
    queryGroups: groupQueriesByIntent(queries),
    xhs: buildXhsDirections(input, subject, second, third, questionAngles),
  };
}

function buildSummary(input, subject, second, third) {
  const sourceHint = input.sources.length ? `已记录 ${input.sources.length} 条来源，可按官方信息和用户讨论拆开核查。` : "目前缺少明确来源，建议至少补一条官方来源或用户讨论链接。";
  const contextHint = input.context ? `背景信息显示，可从“${third}”“${second}”里找一个真实疑问切入。` : "目前缺少详细背景，建议补充事件经过、争议点和评论区高频说法。";
  const manualHint = input.manualDirections ? `已收到人工方向建议：“${input.manualDirections}”，本次会优先按人工意见扩散 Query。` : "未填写人工方向时，系统会自动推荐适合的提问方向。";
  return `围绕“${input.title}”，先判断用户会从哪些角度产生疑问，再按方向生成短 Query。不要复述热点，不写新闻标题或 SEO 词。${manualHint}${contextHint}${sourceHint}`;
}

function calculateScore(input) {
  let score = 58;
  if (input.context.length > 80) score += 12;
  if (input.sources.length) score += 8;
  if (input.sources.some((source) => source.tag === "官方来源")) score += 6;
  if (input.sources.some((source) => source.tag === "用户讨论")) score += 4;
  if (/热搜|争议|回应|道歉|曝光|官宣|翻车|涨价|降价|离婚|结婚|新品|AI/i.test(input.title + input.context)) score += 12;
  if (input.context.length > 240) score += 6;
  return Math.max(45, Math.min(92, score));
}

function buildReasons(input, score) {
  const reasons = [];
  reasons.push(score >= 75 ? "话题具备搜索动机，适合拆成多组百度 Query。" : "可以生成选题，但需要补充更多细节提升可信度。");
  reasons.push(input.sources.length ? "已有多条来源线索，方便区分官方信息和用户讨论。" : "缺少明确来源，发布前需要人工确认事实。");
  reasons.push(input.context.length > 120 ? "背景文本较充分，可提炼讨论点和传播角度。" : "背景信息偏短，Query 会更依赖通用搜索意图。");
  return reasons;
}

function buildQuestionAngles(input, subject, second, third) {
  const topic = cleanTopic(input.title);
  const text = `${input.title} ${input.context} ${input.sources.map((source) => source.value).join(" ")}`;
  const manualTokens = parseDirectionTokens(input.manualDirections);
  const manuallyMatchedConfigs = getManualDirectionConfigs(manualTokens);
  const selectedConfigs = queryDirectionConfig.filter((config) => input.selectedDirectionIds.includes(config.id));
  const autoConfigs = filterDirectionConfigsForHotspot(queryDirectionConfig, text)
    .map((config) => ({
      config,
      fit: scoreDirectionFit(config, text, input, manualTokens),
    }))
    .sort((a, b) => b.fit - a.fit)
    .map((item) => item.config);

  const preferredConfigs = uniqueConfigs([...manuallyMatchedConfigs, ...selectedConfigs]);
  const configs = preferredConfigs.length ? preferredConfigs : autoConfigs.slice(0, 5);
  const angles = configs.map((config) => buildDirectionAngle(config, input, subject, second, third, text, preferredConfigs.length > 0));

  const customAngles = manualTokens
    .filter((token) => !angles.some((angle) => angle.type.includes(token) || angle.queries.some((query) => query.includes(token))))
    .map((token) => buildCustomDirectionAngle(token, input, subject, second, third));

  return [...customAngles, ...angles]
    .sort((a, b) => b.fit - a.fit)
    .slice(0, preferredConfigs.length ? 8 : 5);
}

function filterDirectionConfigsForHotspot(configs, text) {
  if (/乘风|浪姐|综艺/.test(text)) {
    return configs.filter((config) => !["relationship", "what"].includes(config.id));
  }
  return configs;
}

function buildDirectionAngle(config, input, subject, second, third, text, isManual) {
  const customQueries = buildHotspotSpecificDirectionQueries(config, input);
  if (customQueries.length) {
    return {
      type: config.name,
      intent: config.intent,
      fit: isManual ? 99 : scoreDirectionFit(config, text, input, []),
      reason: `${config.description}${isManual ? " 已按人工选择优先生成。" : ""}`,
      queries: customQueries.slice(0, 8),
    };
  }

  const field = detectField(input, subject);
  const context = detectContextToken(input, subject, second, third, config);
  const queries = config.queryTemplates
    .map((template) => fillQueryTemplate(template, { hotspot: cleanTopic(input.title), subject, secondary: second, context, field }))
    .concat(getHistoricalQueries(input.title, subject, config))
    .map(normalizeQuery)
    .filter(Boolean);
  const fit = isManual ? 99 : scoreDirectionFit(config, text, input, []);

  return {
    type: config.name,
    intent: config.intent,
    fit,
    reason: `${config.description}${isManual ? " 已按人工选择优先生成。" : ""}`,
    queries: dedupeQueries(queries.map((textValue) => ({ text: textValue }))).map((item) => item.text).slice(0, 8),
  };
}

function buildHotspotSpecificDirectionQueries(config, input) {
  const text = `${input.title} ${input.context}`;
  if (!/乘风|浪姐|综艺/.test(text)) return [];

  const map = {
    background: ["乘风2026参演名单", "乘风2026姐姐名单", "乘风2026嘉宾背景", "乘风2026姐姐早期经历"],
    trivia: ["乘风2026姐姐冷知识", "王濛人大硕士", "唐艺昕第一部戏是什么", "黄灿灿冷知识"],
    achievement: ["王濛有多少世界冠军", "王濛跨界成绩", "刘雨昕唱跳实力", "乘风2026姐姐代表作"],
    status: ["王濛在短道速滑是什么水平", "刘雨昕唱功怎么样", "乘风2026姐姐业务能力", "王濛领导力"],
    mechanism: ["乘风2026赛制", "乘风2026成团规则", "乘风2026投票规则", "乘风2026排名规则"],
    timeline: ["乘风2026赛程", "乘风2026成团时间", "王濛陈凯琳时间线", "乘风2026播出时间"],
    data: ["乘风2026排名", "乘风2026热度", "乘风2026豆瓣评分", "乘风2026成团名单"],
    decision: ["乘风2026值得追吗", "乘风2026看点", "乘风2026哪一期好看", "乘风2026推荐看谁"],
    controversy: ["乘风2026争议", "乘风2026为什么被骂", "乘风2026评价两极", "乘风2026豆瓣评分低原因"],
  };

  return map[config.id] || [];
}

function buildCustomDirectionAngle(token, input, subject, second, third) {
  const queries = [
    `${subject}${token}`,
    `${subject} ${token}`,
    `${cleanTopic(input.title)} ${token}`,
    `${subject}${token}怎么样`,
    `${subject}${token}是什么`,
  ].map(normalizeQuery);

  return {
    type: `人工方向：${token}`,
    intent: "人工指定",
    fit: 100,
    reason: "来自人工方向建议，生成时优先围绕这个词扩散。",
    queries: dedupeQueries(queries.map((textValue) => ({ text: textValue }))).map((item) => item.text).slice(0, 5),
  };
}

function fillQueryTemplate(template, values) {
  return template
    .replaceAll("{hotspot}", values.hotspot)
    .replaceAll("{subject}", values.subject)
    .replaceAll("{secondary}", values.secondary)
    .replaceAll("{context}", values.context)
    .replaceAll("{field}", values.field);
}

function scoreDirectionFit(config, text, input, manualTokens) {
  let score = 58;
  if (hasAny(text, config.keywords || [])) score += 28;
  if (manualTokens.some((token) => config.name.includes(token) || config.keywords?.some((keyword) => keyword.includes(token) || token.includes(keyword)))) score += 36;
  if (input.selectedDirectionIds.includes(config.id)) score += 40;
  if (/明星|演员|歌手|粉丝|综艺|电影|演唱会|舞台/.test(text) && ["background", "trivia", "achievement", "status", "slang"].includes(config.id)) score += 8;
  if (/世界杯|赛事|比赛|奖金|规则|球队|球员/.test(text) && ["mechanism", "data", "trivia"].includes(config.id)) score += 12;
  if (/游戏|剧情|角色|结局|设定|IP|正史/.test(text) && ["what", "relationship", "timeline", "mechanism"].includes(config.id)) score += 12;
  if (/票|买|位置|值得|什么时候|哪里/.test(text) && config.id === "decision") score += 20;
  return Math.max(45, Math.min(99, score));
}

function parseDirectionTokens(value) {
  return String(value || "")
    .split(/[、,，/／\n;；]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function getManualDirectionConfigs(tokens) {
  if (!tokens.length) return [];

  return queryDirectionConfig.filter((config) =>
    tokens.some((token) => {
      const haystack = `${config.name} ${config.description} ${(config.keywords || []).join(" ")}`;
      return (
        haystack.includes(token) ||
        token.includes(config.name.replace(/\/.*/, "")) ||
        (config.keywords || []).some((keyword) => token.includes(keyword) || keyword.includes(token))
      );
    }),
  );
}

function uniqueConfigs(configs) {
  const seen = new Set();
  return configs.filter((config) => {
    if (seen.has(config.id)) return false;
    seen.add(config.id);
    return true;
  });
}

function detectField(input, subject) {
  const text = `${input.title} ${input.context}`;
  if (/KPOP|韩国|爱豆|练习生/.test(text)) return "KPOP";
  if (/世界杯|足球|球队|球员/.test(text)) return "足球";
  if (/华语|歌手|演唱会|舞台|唱功/.test(text)) return "华语女歌手";
  if (/短道速滑|冠军|奥运|体育/.test(text)) return "短道速滑";
  if (/游戏|剧情|角色/.test(text)) return "游戏";
  return subject;
}

function detectContextToken(input, subject, second, third, config) {
  const text = `${input.title} ${input.context}`;
  if (config.id === "slang") {
    const slang = text.match(/叫([\u4e00-\u9fa5A-Za-z0-9]{2,8})/) || text.match(/粉丝叫([\u4e00-\u9fa5A-Za-z0-9]{2,8})/);
    if (slang) return slang[1];
  }
  if (config.id === "relationship") return second;
  if (config.id === "what") return third;
  return third || second || "这个";
}

function getHistoricalQueries(title, subject, config) {
  const cases = window.HISTORICAL_QUERY_CASES || [];
  const matched = cases.find((item) => title.includes(item.hotspot) || item.hotspot.includes(subject) || title.includes(subject));
  if (!matched) return [];

  return matched.queries.filter((query) => {
    const text = `${config.name} ${config.intent} ${(config.keywords || []).join(" ")}`;
    return (
      hasAny(query, config.keywords || []) ||
      (config.id === "background" && /履历|专业|出道|经历/.test(query)) ||
      (config.id === "trivia" && /冷知识|原名|蛋糕|打游戏/.test(query)) ||
      (config.id === "relationship" && /关系|结局|子女|合作/.test(query)) ||
      (config.id === "status" && /地位|水平|怎么样/.test(query)) ||
      (config.id === "mechanism" && /规则|奖金|怎么分配|多少/.test(query)) ||
      text.includes(query)
    );
  });
}

function buildQueries(input, subject, second, third, questionAngles) {
  const angleQueries = questionAngles.flatMap((angle) =>
    angle.queries.map((query) => ({
      intent: angle.intent,
      text: query,
      score: angle.fit,
      reason: angle.reason,
    })),
  );
  const topic = cleanTopic(input.title);
  const officialSource = input.sources.find((source) => source.tag === "官方来源");
  const discussionSource = input.sources.find((source) => source.tag === "用户讨论");
  const audienceQueries = buildAudienceQueries(input.audience, topic, subject).map(([intent, text]) => ({
    intent,
    text,
    score: 78,
    reason: "根据目标人群补充的搜索问题。",
  }));
  const templates = [
    ...angleQueries,
    ...audienceQueries,
  ];

  if (officialSource) templates.push({ intent: "求证/澄清", text: `${topic} 官方回应`, score: 88, reason: "已有官方来源，适合做事实核查。" });
  if (discussionSource) templates.push({ intent: "网友讨论", text: `${topic} 大家在讨论什么`, score: 84, reason: "已有用户讨论来源，适合做评论区延展。" });

  const expanded = [];
  const modifiers = ["经历", "背景", "评价", "资料", "百科", "为什么", "冷知识", "时间线"];
  while (expanded.length < input.queryCount) {
    const base = templates[expanded.length % templates.length];
    const round = Math.floor(expanded.length / templates.length);
    const modifier = modifiers[round % modifiers.length];
    expanded.push({
      intent: base.intent,
      text: round === 0 ? normalizeQuery(base.text) : normalizeQuery(`${base.text} ${modifier}`),
      score: Math.max(68, (base.score || 76) - round * 4),
      reason: round === 0 ? base.reason : "用于补充同方向的长尾搜索问题。",
    });
  }

  return dedupeQueries(expanded).slice(0, input.queryCount).map((item, index) => ({
    ...item,
    id: `${index + 1}`,
    intent: item.intent,
  }));
}

function buildXhsDirections(input, subject, second, third, questionAngles) {
  const titleMap = {
    考古求科普: `突然开始考古${subject}，求科普`,
    冷知识发现: `这感觉真的是${subject}的冷知识了`,
    实力履历: `感觉${subject}是真正的全面强者`,
    关系时间线: `原来${subject}和${second}还有这层关系`,
    争议求证: `真心求问，${subject}这事是真的吗`,
    入坑安利: `被${subject}圈粉了，求安利`,
    行程后续: `${subject}最近是不是真的很忙`,
    数据表现: `感觉${subject}这个热度算 top 了吧`,
  };

  return questionAngles.map((angle) => ({
    title: titleMap[angle.type] || `原来${subject}还有这一面`,
    note: `${angle.type} · ${angle.reason}`,
  }));
}

function initializeMindmap(result) {
  state.mindmap = {
    nodes: [],
    edges: [],
    selectedId: null,
    nextId: 1,
    removedLabels: new Set(),
    zoom: state.mindmap.zoom || 1,
  };

  const root = createMindNode({
    label: result.input.title,
    type: "root",
    meta: "热点根节点",
    depth: 0,
    payload: { resultId: result.id },
  });
  state.mindmap.nodes.push(root);
  state.mindmap.selectedId = root.id;
  mindmapSection.hidden = false;
  expandMindNode(root.id);
}

async function expandMindNode(nodeId) {
  const node = state.mindmap.nodes.find((item) => item.id === nodeId);
  if (!node || !state.currentResult || node.expanding) return;

  state.mindmap.selectedId = nodeId;

  if (!node.expanded) {
    node.expanding = true;
    layoutMindmap();
    renderMindmap();
    try {
      const children = dedupeMindChildren(await buildMindChildren(node, state.currentResult)).slice(0, 8);
      children.forEach((child) => {
        const childNode = createMindNode({
          ...child,
          label: sanitizeQueryText(child.label),
          depth: node.depth + 1,
          parentId: node.id,
        });
        if (!childNode.label) return;
        state.mindmap.nodes.push(childNode);
        state.mindmap.edges.push({ from: node.id, to: childNode.id });
      });
      node.expanded = true;
    } finally {
      node.expanding = false;
    }
  }

  layoutMindmap();
  renderMindmap();
}

function selectMindNode(nodeId) {
  const node = state.mindmap.nodes.find((item) => item.id === nodeId);
  if (!node) return;
  state.mindmap.selectedId = nodeId;
  layoutMindmap();
  renderMindmap();
}

function removeMindNode(nodeId) {
  const node = state.mindmap.nodes.find((item) => item.id === nodeId);
  if (!node || node.type === "root") return;

  const idsToRemove = new Set([nodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    state.mindmap.edges.forEach((edge) => {
      if (idsToRemove.has(edge.from) && !idsToRemove.has(edge.to)) {
        idsToRemove.add(edge.to);
        changed = true;
      }
    });
  }

  state.mindmap.nodes.forEach((item) => {
    if (idsToRemove.has(item.id)) {
      state.mindmap.removedLabels.add(item.label);
    }
  });
  state.mindmap.nodes = state.mindmap.nodes.filter((item) => !idsToRemove.has(item.id));
  state.mindmap.edges = state.mindmap.edges.filter((edge) => !idsToRemove.has(edge.from) && !idsToRemove.has(edge.to));
  state.mindmap.selectedId = node.parentId || state.mindmap.nodes[0]?.id || null;
  layoutMindmap();
  renderMindmap();
  if (state.currentResult) renderQueryList(state.currentResult);
}

function collapseMindNode(nodeId) {
  const node = state.mindmap.nodes.find((item) => item.id === nodeId);
  if (!node || !node.expanded) return;

  const idsToRemove = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    state.mindmap.edges.forEach((edge) => {
      if ((edge.from === nodeId || idsToRemove.has(edge.from)) && !idsToRemove.has(edge.to)) {
        idsToRemove.add(edge.to);
        changed = true;
      }
    });
  }

  state.mindmap.nodes = state.mindmap.nodes.filter((item) => !idsToRemove.has(item.id));
  state.mindmap.edges = state.mindmap.edges.filter((edge) => !idsToRemove.has(edge.from) && !idsToRemove.has(edge.to));
  node.expanded = false;
  state.mindmap.selectedId = node.id;
  layoutMindmap();
  renderMindmap();
}

async function buildMindChildren(node, result) {
  if (node.type === "root") {
    const related = buildRelatedHotspots(result);
    if (related.length) return related;
    return result.questionAngles.map((angle) => ({
      label: angle.type,
      type: "direction",
      meta: `${angle.intent} · ${angle.fit || 80} 分`,
      payload: { angleType: angle.type },
    }));
  }

  if (node.type === "hotspot") {
    const localChildren = buildHotspotExpansion(node.label, result);
    const hasPreparedAiExpansions = Array.isArray(node.payload?.aiExpansions) && node.payload.aiExpansions.length;
    return hasPreparedAiExpansions ? localChildren : generateMindExpansion(node, result, localChildren);
  }

  if (node.type === "direction") {
    if (node.payload?.seed && node.payload?.configId) {
      const config = queryDirectionConfig.find((item) => item.id === node.payload.configId);
      if (config) {
        const localChildren = config.queryTemplates.slice(0, 8).map((template) => ({
          label: normalizeQuery(
            fillQueryTemplate(template, {
              hotspot: node.payload.seed,
              subject: node.payload.seed,
              secondary: "相关人物",
              context: "冷知识",
              field: node.payload.seed,
            }),
          ),
          type: "query",
          meta: config.intent,
          payload: { query: template },
        }));
        return generateMindExpansion(node, result, localChildren);
      }
    }
    const angle = result.questionAngles.find((item) => item.type === node.payload?.angleType || item.intent === node.payload?.intent);
    const queries = angle?.queries?.length
      ? angle.queries
      : result.queries.filter((query) => query.intent === node.payload?.intent).map((query) => query.text);
    const localChildren = queries.slice(0, 8).map((query) => ({
      label: query,
      type: "query",
      meta: angle?.intent || node.payload?.intent || "Query",
      payload: { query },
    }));
    return generateMindExpansion(node, result, localChildren);
  }

  if (node.type === "query") {
    return generateMindExpansion(node, result, buildDeepDiveExpansion(node, result));
  }

  return generateMindExpansion(node, result, buildActionExpansion(node, result));
}

async function generateMindExpansion(node, result, fallbackChildren) {
  if (!canUseAiServer()) {
    return fallbackChildren;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 38_000);
  try {
    const response = await fetch(getApiPath("/api/expand"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        rootTopic: result.input.title,
        currentNode: node.label,
        currentDepth: node.depth,
        path: getMindPath(node).map((item) => item.label),
        existingLabels: state.mindmap.nodes.map((item) => item.label),
        hotspotSummary: result.summary,
        hotspotEntities: result.hotspotAnalysis?.entities || [],
        manualDirections: result.input.manualDirections || "",
      }),
    });
    const data = await readJsonResponse(response);
    if (!response.ok || !Array.isArray(data?.result?.nodes)) {
      return fallbackChildren;
    }
    const aiChildren = data.result.nodes
      .map((item) => ({
        label: sanitizeQueryText(item.label),
        type: "query",
        meta: item.meta || "发散搜索",
        payload: { seed: item.label, query: item.label },
      }))
      .filter((item) => item.label);

    return aiChildren.length ? aiChildren : fallbackChildren;
  } catch {
    return fallbackChildren;
  } finally {
    clearTimeout(timeoutId);
  }
}

function getMindPath(node) {
  const path = [];
  let cursor = node;
  while (cursor) {
    path.unshift(cursor);
    cursor = state.mindmap.nodes.find((item) => item.id === cursor.parentId);
  }
  return path;
}

function buildRelatedHotspots(result) {
  if (Array.isArray(result.relatedHotspots) && result.relatedHotspots.length) {
    return result.relatedHotspots.slice(0, 8).map((item) => ({
      label: sanitizeQueryText(item.label),
      type: "hotspot",
      meta: item.meta || "AI 相关热点词",
      payload: {
        seed: sanitizeQueryText(item.label),
        aiExpansions: Array.isArray(item.expansions) ? item.expansions : [],
      },
    }));
  }

  const title = result.input.title;
  const context = result.input.context || "";
  const pool = [];

  if (/乘风|浪姐/.test(title + context)) {
    pool.push("王濛", "黄灿灿", "唐艺昕", "刘雨昕", "孙怡陈瑶", "乘风2026赛制", "姐姐冷知识", "成团后发展");
  }
  if (/宋威龙/.test(title + context)) {
    pool.push("海外人气", "长腿老头时期", "于正纠纷", "粉丝辣条", "出道经历", "打游戏", "釜山电影节");
  }
  if (/侯明昊/.test(title + context)) {
    pool.push("男团经历", "待播剧", "曾舜晞关系", "唱功", "SM练习生", "长生骨传言", "近期行程");
  }
  if (/蔡依林/.test(title + context)) {
    pool.push("海外热度", "英语专业", "蛋糕作品", "履历", "冷知识", "华语女歌手地位", "舞蹈经历");
  }
  if (/世界杯/.test(title + context)) {
    pool.push("奖金分配", "红黄牌规则", "越位规则", "球员身价", "球队背景", "KPOP类比", "世界杯冷知识");
  }

  if (!pool.length) {
    result.questionAngles.forEach((angle) => pool.push(angle.type));
    result.queries.slice(0, 6).forEach((query) => pool.push(query.text));
  }

  return Array.from(new Set(pool)).slice(0, 8).map((label) => ({
    label: sanitizeQueryText(label),
    type: "hotspot",
    meta: "相关热点词",
    payload: { seed: label },
  }));
}

function buildHotspotExpansion(label, result) {
  const node = state.mindmap.nodes.find((item) => item.label === label);
  if (Array.isArray(node?.payload?.aiExpansions) && node.payload.aiExpansions.length) {
    return node.payload.aiExpansions.slice(0, 8).map((item) => ({
      label: sanitizeQueryText(item.label),
      type: "query",
      meta: item.meta || "AI 扩散关键词",
      payload: { seed: label, query: item.label },
    }));
  }

  return getSemanticExpansions(label, result).map((item) => ({
    label: item.label,
    type: item.type || "query",
    meta: item.meta || "扩散关键词",
    payload: { seed: label, query: item.label },
  }));
}

function getSemanticExpansions(label, result) {
  const dictionary = {
    王濛: [
      ["王濛职业生涯", "人物履历"],
      ["王濛浪姐排名", "节目表现"],
      ["王濛教练水平", "专业评价"],
      ["王濛有多少世界冠军", "成就数据"],
      ["王濛人大硕士", "教育背景"],
      ["王濛退役后做什么", "后续发展"],
      ["王濛跨界成绩", "跨界经历"],
      ["王濛领导力", "人物评价"],
    ],
    黄灿灿: [
      ["黄灿灿武大校花", "人物背景"],
      ["黄灿灿冷知识", "冷知识"],
      ["黄灿灿浪姐表现", "节目表现"],
      ["黄灿灿发夹收藏", "兴趣爱好"],
      ["黄灿灿代表作", "履历作品"],
      ["黄灿灿为什么又火了", "热度原因"],
    ],
    唐艺昕: [
      ["唐艺昕第一部戏是什么", "早期作品"],
      ["唐艺昕演过甄嬛传吗", "作品考古"],
      ["唐艺昕祺贵人多少岁", "角色信息"],
      ["唐艺昕代表作", "履历作品"],
      ["唐艺昕浪姐表现", "节目表现"],
    ],
    刘雨昕: [
      ["刘雨昕为什么最近这么火", "热度原因"],
      ["刘雨昕街舞经历", "专业背景"],
      ["刘雨昕科切拉", "海外舞台"],
      ["刘雨昕唱跳实力", "能力评价"],
      ["刘雨昕奢侈品代言", "商业价值"],
    ],
    孙怡陈瑶: [
      ["孙怡陈瑶什么关系", "人物关系"],
      ["孙怡陈瑶合作过吗", "合作经历"],
      ["孙怡陈瑶浪姐时间线", "时间线"],
      ["孙怡陈瑶为什么好磕", "CP讨论"],
    ],
    乘风2026赛制: [
      ["乘风2026赛制", "规则机制"],
      ["乘风2026成团规则", "规则机制"],
      ["乘风2026投票规则", "规则机制"],
      ["乘风2026淘汰规则", "规则机制"],
      ["乘风2026成团后发展", "后续"],
    ],
    姐姐冷知识: [
      ["乘风2026姐姐冷知识", "冷知识"],
      ["乘风2026姐姐学历", "人物背景"],
      ["乘风2026姐姐早期经历", "人物考古"],
      ["乘风2026姐姐跨界经历", "跨界"],
      ["乘风2026姐姐代表作", "履历作品"],
    ],
    成团后发展: [
      ["乘风2026成团后团有什么发展", "后续"],
      ["乘风2026成团名单", "结果"],
      ["乘风2026团体活动", "后续"],
      ["乘风2026芒果内部活动", "后续"],
    ],
  };

  const matchedKey = Object.keys(dictionary).find((key) => label.includes(key) || key.includes(label));
  if (matchedKey) {
    return dictionary[matchedKey].map(([itemLabel, meta]) => ({ label: itemLabel, meta, type: "query" }));
  }

  return buildGenericSemanticExpansions(label, result);
}

function buildGenericSemanticExpansions(label, result) {
  const base = sanitizeQueryText(label.replace(/相关搜索/g, "")).trim();
  const topic = cleanTopic(result.input.title);
  return buildAssociativePool(base, topic, result).map(([itemLabel, meta]) => ({ label: itemLabel, meta, type: "query" }));
}

function buildActionExpansion(node, result = state.currentResult) {
  const seed = node.payload?.seed || node.label;
  if (node.payload?.action === "headline") {
    return [
      `原来${seed}还有这一面`,
      `不拉踩纯好奇，${seed}到底是什么水平`,
    ].map((label) => ({ label, type: "action", meta: "大字报备选", payload: { seed: label } }));
  }

  return buildDeepDiveExpansion({ label: seed, payload: { seed } }, result);
}

function buildDeepDiveExpansion(node, result = state.currentResult) {
  const seed = sanitizeQueryText(node.payload?.seed || node.label);
  const topic = cleanTopic(result?.input?.title || "");
  return buildAssociativePool(seed, topic, result).map(([label, meta]) => ({
    label,
    type: "query",
    meta,
    payload: { seed: label, query: label },
  }));
}

function buildAssociativePool(seed, topic, result) {
  const text = `${seed} ${topic} ${result?.summary || ""}`;
  const pools = [];

  if (/原著|小说|文学|作者|IP|书粉/.test(text)) {
    pools.push(
      ["小说结局和剧版一样吗", "原著考古"],
      ["酸涩文学推荐", "同类作品"],
      ["骨科设定小说", "设定联想"],
      ["同类型救赎文", "同类作品"],
      ["男女主人设分析", "人设"],
      ["原著作者其他作品", "作者考古"],
      ["书粉为什么吵", "粉圈讨论"],
      ["改编删了哪些剧情", "剧版改编"],
    );
  }

  if (/剧情|结局|细节|名场面|反转|台词|剧版/.test(text)) {
    pools.push(
      [`${topic}细节剧情`, "剧情细节"],
      ["结局到底什么意思", "结局解析"],
      ["最虐名场面", "名场面"],
      ["删减剧情有哪些", "剧版改编"],
      ["伏笔时间线", "细节考古"],
      ["男女主为什么分开", "情感线"],
      ["路人看不懂的地方", "补课"],
      ["高能片段在哪一集", "追剧"],
    );
  }

  if (/人设|设定|骨科|禁忌|CP|关系|好嗑|疯批|救赎/.test(text)) {
    pools.push(
      ["骨科是什么意思", "设定科普"],
      ["伪骨科和真骨科区别", "设定科普"],
      ["疯批男主人设", "人设"],
      ["救赎文学为什么上头", "类型联想"],
      ["禁忌感CP推荐", "同类作品"],
      ["男女主关系时间线", "关系线"],
      ["好嗑但不能说的设定", "粉圈黑话"],
      ["类似CP有哪些", "同类关系"],
    );
  }

  if (/演员|主演|角色|履历|八卦|粉丝|路透|营业/.test(text)) {
    pools.push(
      ["主演以前演过什么", "演员履历"],
      ["男女主演现实关系", "演员八卦"],
      ["片场路透是真的吗", "路透求证"],
      ["演员吻戏反应", "花絮"],
      ["粉丝为什么吵架", "粉圈讨论"],
      ["角色和本人反差", "演员考古"],
      ["待播剧有哪些", "后续"],
      ["谁的演技被夸最多", "路人评价"],
    );
  }

  if (/野狗骨头|热播剧|剧|短剧/.test(text)) {
    pools.push(
      ["野狗骨头原著小说", "原著"],
      ["野狗骨头讲的什么", "剧情补课"],
      ["野狗骨头演员表", "演员"],
      ["野狗骨头结局", "结局"],
      ["类似野狗骨头的小说", "同类作品"],
      ["骨科设定的其他作品", "设定联想"],
      ["野狗骨头男女主人设", "人设"],
      ["野狗骨头为什么突然火", "热度原因"],
    );
  }

  if (!pools.length) {
    pools.push(
      [`${seed}怎么回事`, "事件脉络"],
      ["网友为什么吵", "争议"],
      ["路人怎么评价", "路人讨论"],
      ["后续怎么样了", "后续"],
      ["同类作品推荐", "同类"],
      ["人物关系时间线", "关系"],
      ["黑历史是真的吗", "考古"],
      ["最出圈的梗", "热梗"],
    );
  }

  return dedupeMindPairs(pools).slice(0, 8);
}

function dedupeMindPairs(pairs) {
  const seen = new Set();
  return pairs.filter(([label]) => {
    const key = sanitizeQueryText(label).replace(/\s+/g, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeMindChildren(children) {
  const seen = new Set();
  return children.filter((child) => {
    const label = sanitizeQueryText(child.label);
    const key = label.replace(/\s+/g, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    child.label = label;
    return true;
  });
}

function createMindNode(options) {
  const id = `mind-${state.mindmap.nextId}`;
  state.mindmap.nextId += 1;
  return {
    id,
    label: options.label,
    type: options.type,
    meta: options.meta,
    depth: options.depth,
    parentId: options.parentId || null,
    payload: options.payload || {},
    expanded: false,
    expanding: false,
    x: 0,
    y: 0,
  };
}

function layoutMindmap() {
  const visibleNodes = getVisibleMindNodes();
  const maxDepth = Math.max(...visibleNodes.map((node) => node.depth), 0);
  const groups = visibleNodes.reduce((acc, node) => {
    acc[node.depth] = acc[node.depth] || [];
    acc[node.depth].push(node);
    return acc;
  }, {});
  const columnWidth = 245;
  const rowGap = 104;
  const leftPadding = 52;
  const topPadding = 44;
  const maxRows = Math.max(...Object.values(groups).map((items) => items.length), 1);
  const width = Math.max(960, leftPadding * 2 + (maxDepth + 1) * columnWidth);
  const height = Math.max(620, topPadding * 2 + maxRows * rowGap);

  Object.entries(groups).forEach(([depth, nodes]) => {
    const columnX = leftPadding + Number(depth) * columnWidth;
    const columnHeight = (nodes.length - 1) * rowGap;
    const startY = Math.max(topPadding, height / 2 - columnHeight / 2 - 40);
    nodes.forEach((node, index) => {
      node.x = columnX;
      node.y = startY + index * rowGap;
    });
  });

  mindmapLines.setAttribute("width", width);
  mindmapLines.setAttribute("height", height);
  mindmapLines.setAttribute("viewBox", `0 0 ${width} ${height}`);
  mindmapLines.style.width = `${width}px`;
  mindmapLines.style.height = `${height}px`;
  mindmapNodes.style.width = `${width}px`;
  mindmapNodes.style.height = `${height}px`;
  applyMindmapZoom(width, height);
}

function renderMindmap() {
  const visibleNodes = getVisibleMindNodes();
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const nodeById = new Map(visibleNodes.map((node) => [node.id, node]));
  const visibleEdges = state.mindmap.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  mindmapLines.innerHTML = visibleEdges
    .filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to))
    .map((edge) => {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to) return "";
      const x1 = from.x + 90;
      const y1 = from.y + 36;
      const x2 = to.x + 90;
      const y2 = to.y + 36;
      return `<path d="M ${x1} ${y1} C ${x1 + 70} ${y1}, ${x2 - 70} ${y2}, ${x2} ${y2}" fill="none" stroke="#b8c3d4" stroke-width="2" />`;
    })
    .join("");

  const edgeControls = visibleEdges
    .map((edge) => {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to || !from.expanded) return "";
      const x = (from.x + to.x) / 2 + 82;
      const y = (from.y + to.y) / 2 + 24;
      return `<button class="mind-edge-toggle" type="button" title="折叠这一层" data-collapse-node-id="${escapeHtml(from.id)}" style="left:${x}px; top:${y}px;">−</button>`;
    })
    .join("");

  mindmapNodes.innerHTML = edgeControls + visibleNodes
    .map(
      (node) => `
        <div class="mind-node ${escapeHtml(node.type)} ${node.expanding ? "expanding" : ""} ${node.id === state.mindmap.selectedId ? "active" : ""}" data-node-id="${escapeHtml(node.id)}" role="button" tabindex="0" style="left:${node.x}px; top:${node.y}px;">
          ${node.type !== "root" ? `<button class="mind-node-remove" type="button" aria-label="删除 ${escapeHtml(node.label)}" data-remove-node-id="${escapeHtml(node.id)}">×</button>` : ""}
          ${node.type !== "root" ? `<button class="mind-node-add" type="button" aria-label="加入 Query 汇总：${escapeHtml(node.label)}" data-add-node-id="${escapeHtml(node.id)}">+</button>` : ""}
          <span class="mind-node-title">${escapeHtml(node.label)}</span>
          <span class="mind-node-meta">${escapeHtml(node.expanding ? "正在发散..." : node.meta || "")}</span>
        </div>
      `,
    )
    .join("");

  mindmapNodes.querySelectorAll(".mind-node").forEach((button) => {
    button.addEventListener("click", (event) => {
      if (event.target.closest(".mind-node-remove, .mind-node-add")) return;
      selectMindNode(button.dataset.nodeId);
    });
    button.addEventListener("dblclick", (event) => {
      if (event.target.closest(".mind-node-remove, .mind-node-add")) return;
      expandMindNode(button.dataset.nodeId);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter") expandMindNode(button.dataset.nodeId);
      if (event.key === "Delete" || event.key === "Backspace") removeMindNode(button.dataset.nodeId);
    });
  });

  mindmapNodes.querySelectorAll(".mind-node-remove").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      removeMindNode(button.dataset.removeNodeId);
    });
  });

  mindmapNodes.querySelectorAll(".mind-node-add").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      addMindNodeToQueries(button.dataset.addNodeId);
      button.textContent = "✓";
      setTimeout(() => {
        button.textContent = "+";
      }, 900);
    });
  });

  mindmapNodes.querySelectorAll(".mind-edge-toggle").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      collapseMindNode(button.dataset.collapseNodeId);
    });
  });

  const activeNode = state.mindmap.nodes.find((node) => node.id === state.mindmap.selectedId);
  if (activeNode) {
    mindmapCanvas.scrollTo({
      left: Math.max(activeNode.x - 80, 0),
      top: Math.max(activeNode.y - 80, 0),
      behavior: "smooth",
    });
  }
}

function addMindNodeToQueries(nodeId) {
  const node = state.mindmap.nodes.find((item) => item.id === nodeId);
  if (!node || !state.currentResult) return;

  const text = normalizeQuery(node.label);
  if (!text) return;

  const exists = state.currentResult.queries.some((query) => query.text.replace(/\s+/g, "") === text.replace(/\s+/g, ""));
  if (!exists) {
    state.currentResult.queries.push({
      id: `mind-${node.id}`,
      text,
      intent: node.meta || "导图选题",
      score: 90,
      reason: "从热点脑暴导图手动加入。",
    });
  }

  renderQueryList(state.currentResult);
  resultGrid.hidden = false;
  resultGrid.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setMindmapZoom(value) {
  state.mindmap.zoom = Math.max(0.6, Math.min(1.6, Number(value.toFixed(2))));
  layoutMindmap();
  renderMindmap();
}

function applyMindmapZoom(width, height) {
  const zoom = state.mindmap.zoom || 1;
  mindmapLines.style.zoom = zoom;
  mindmapNodes.style.zoom = zoom;
  mindmapLines.style.transform = "";
  mindmapNodes.style.transform = "";
  mindmapLines.style.width = `${width}px`;
  mindmapLines.style.height = `${height}px`;
  mindmapNodes.style.width = `${width}px`;
  mindmapNodes.style.height = `${height}px`;
  zoomValue.textContent = `${Math.round(zoom * 100)}%`;
}

function getVisibleMindNodes() {
  const selected = state.mindmap.nodes.find((node) => node.id === state.mindmap.selectedId) || state.mindmap.nodes[0];
  if (!selected) return [];

  const pathIds = new Set();
  let cursor = selected;
  while (cursor) {
    pathIds.add(cursor.id);
    cursor = state.mindmap.nodes.find((node) => node.id === cursor.parentId);
  }

  const visibleIds = new Set(pathIds);
  state.mindmap.nodes.forEach((node) => {
    if (node.depth <= 1) visibleIds.add(node.id);
    if (pathIds.has(node.parentId)) visibleIds.add(node.id);
    if (node.parentId === selected.parentId) visibleIds.add(node.id);
  });

  return state.mindmap.nodes
    .filter((node) => visibleIds.has(node.id))
    .sort((a, b) => a.depth - b.depth || compareMindSiblingOrder(a, b, selected));
}

function compareMindSiblingOrder(a, b, selected) {
  return state.mindmap.nodes.indexOf(a) - state.mindmap.nodes.indexOf(b);
}

function detectCategory(input) {
  const text = `${input.title} ${input.context} ${input.sources.map((source) => source.value).join(" ")}`;
  if (/品牌|新品|价格|门店|消费|买|卖/.test(text)) return "消费/品牌";
  if (/明星|演员|歌手|粉丝|综艺|电影/.test(text)) return "娱乐";
  if (/学校|学生|高考|考研|家长|老师/.test(text)) return "教育";
  if (/AI|模型|科技|手机|汽车|芯片/.test(text)) return "科技";
  if (/政策|官方|通报|城市|民生/.test(text)) return "社会/民生";
  return "综合热点";
}

function detectEmotion(text) {
  if (/震惊|离谱|翻车|怒|吵|争议|曝光/.test(text)) return "高讨论/争议";
  if (/暖|感动|治愈|帮助/.test(text)) return "正向/共情";
  if (/为什么|原因|真假|回应/.test(text)) return "求证/好奇";
  return "中性/待判断";
}

function extractKeywords(text) {
  const cleaned = text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => word.length >= 2 && word.length <= 14)
    .filter((word) => !["这个", "那个", "因为", "所以", "一个", "什么", "怎么回事", "官方来源", "用户讨论"].includes(word));

  return Array.from(new Set(cleaned)).slice(0, 8);
}

function normalizeInput(input) {
  if (!Array.isArray(input.sources)) {
    input.sources = input.source ? [{ tag: "其他来源", value: input.source }] : [];
  }

  if (!Array.isArray(input.audience)) {
    input.audience = input.audience ? [input.audience] : ["吃瓜群众"];
  }

  input.manualDirections = input.manualDirections || "";
  input.selectedDirectionIds = Array.isArray(input.selectedDirectionIds) ? input.selectedDirectionIds : [];
}

function detectPrimarySubject(title, keywords) {
  const compactTitle = cleanTopic(title).replace(/\s+/g, "");
  const beforeEvent = compactTitle
    .replace(/(北京|上海|广州|深圳|杭州|成都|重庆|武汉|南京|西安|长沙|郑州|天津|苏州)/g, "")
    .replace(/(演唱会|发布会|见面会|直播|热搜|回应|道歉|争议|官宣|活动|电影|综艺|采访|舞台|新歌|专辑).*$/, "");

  if (/^[\u4e00-\u9fa5]{2,6}$/.test(beforeEvent)) {
    return beforeEvent.length > 4 ? beforeEvent.slice(0, 3) : beforeEvent;
  }

  const spacedTitle = cleanTopic(title).split(/\s+/).find((part) => /^[\u4e00-\u9fa5A-Za-z0-9]{2,12}$/.test(part));
  if (spacedTitle) {
    return spacedTitle;
  }

  return keywords[0] || cleanTopic(title);
}

function cleanTopic(title) {
  return title.replace(/[，。！？!?；;：:]+$/g, "").trim();
}

function normalizeQuery(value) {
  return sanitizeQueryText(value)
    .replace(/\s+/g, " ")
    .replace(/ ?怎么回事/g, " 怎么回事")
    .replace(/ ?时间线/g, " 时间线")
    .trim();
}

function sanitizeQueryText(value) {
  return String(value || "")
    .replace(/百度\s*AI\s*总结/gi, "")
    .replace(/百度了一下发现/g, "")
    .replace(/百度一下/g, "")
    .replace(/百度/g, "")
    .replace(/文心助手怎么看/g, "")
    .replace(/文心助手/gi, "")
    .replace(/AI\s*总结/gi, "")
    .replace(/AI问答/gi, "")
    .replace(/大字报标题/g, "")
    .replace(/截图建议/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeRelatedHotspot(item) {
  return {
    ...item,
    label: sanitizeQueryText(item.label),
    expansions: Array.isArray(item.expansions)
      ? item.expansions.map((expansion) => ({
          ...expansion,
          label: sanitizeQueryText(expansion.label),
        }))
      : [],
  };
}

function hasAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function buildAudienceQueries(audiences, topic, subject) {
  const map = {
    吃瓜群众: [
      ["发生了什么", `${subject} 瓜完整经过`],
      ["网友讨论", `${subject} 为什么上热搜`],
    ],
    理性求证: [
      ["发生了什么", `${subject} 官方回应`],
      ["人物背景", `${subject} 资料`],
    ],
    学生: [
      ["人物背景", `${subject} 学历`],
      ["快速了解", `${subject} 简单解释`],
    ],
    家长: [
      ["人物评价", `${subject} 对孩子有什么影响`],
      ["冷知识", `${subject} 家长知道`],
    ],
    粉丝: [
      ["官方回应", `${subject}本人回应`],
      ["后续进展", `${subject}后续行程受影响吗`],
    ],
    路人: [
      ["人物背景", `${subject} 路人版介绍`],
      ["快速了解", `${subject} 三句话看懂`],
    ],
    上班族: [
      ["人物成就", `${subject} 职业经历`],
      ["人物评价", `${subject} 职场怎么看`],
    ],
  };

  return audiences.flatMap((audience) => map[audience] || []);
}

function dedupeQueries(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.text.replace(/\s+/g, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function groupQueriesByIntent(queries) {
  return Object.values(
    queries.reduce((groups, query) => {
      if (!groups[query.intent]) {
        groups[query.intent] = {
          direction: query.intent,
          queries: [],
        };
      }
      groups[query.intent].queries.push({
        query: query.text,
        intent: query.intent,
        score: query.score,
        reason: query.reason,
      });
      return groups;
    }, {}),
  );
}

function splitLines(value) {
  return value
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function addSourceRow(source = { tag: "用户讨论", value: "" }) {
  const row = document.createElement("div");
  row.className = `source-row ${source.auto ? "source-row-auto" : ""}`;
  row.innerHTML = `
    <select class="source-tag" aria-label="来源标签">
      ${["官方来源", "用户讨论", "媒体报道", "平台热榜", "品牌资料", "其他来源"]
        .map((tag) => `<option value="${tag}" ${tag === source.tag ? "selected" : ""}>${tag}</option>`)
        .join("")}
    </select>
    <input class="source-value" type="text" value="${escapeHtml(source.value)}" placeholder="粘贴链接、搜索词或来源说明" />
    <span class="source-auto-badge ${source.auto ? "" : "is-empty"}">${source.auto ? "自动" : ""}</span>
    <button class="icon-button" type="button" aria-label="删除来源">×</button>
  `;

  row.querySelector(".icon-button").addEventListener("click", () => {
    if (sourceList.children.length <= 1) {
      row.querySelector(".source-value").value = "";
      row.querySelector(".source-tag").value = "用户讨论";
      return;
    }
    row.remove();
  });

  sourceList.appendChild(row);
}

function suggestSocialSources() {
  const topic = document.querySelector("#topicTitle").value.trim();
  if (!topic) return;
  addSuggestedSocialSources(topic);
}

function addSuggestedSocialSources(topic) {
  const existing = new Set(collectSources().map((source) => source.value));
  buildSocialSourceSuggestions(topic).forEach((source) => {
    if (!existing.has(source.value)) {
      addSourceRow(source);
      existing.add(source.value);
    }
  });
}

function buildSocialSourceSuggestions(topic) {
  const keyword = cleanTopic(topic);
  const encoded = encodeURIComponent(keyword);
  return [
    {
      tag: "用户讨论",
      value: `微博搜索：${keyword} https://s.weibo.com/weibo?q=${encoded}`,
      auto: true,
    },
    {
      tag: "用户讨论",
      value: `小红书搜索：${keyword} https://www.xiaohongshu.com/search_result?keyword=${encoded}`,
      auto: true,
    },
    {
      tag: "用户讨论",
      value: `抖音搜索：${keyword} https://www.douyin.com/search/${encoded}`,
      auto: true,
    },
    {
      tag: "媒体报道",
      value: `B站搜索：${keyword} https://search.bilibili.com/all?keyword=${encoded}`,
      auto: true,
    },
    {
      tag: "平台热榜",
      value: `百度搜索：${keyword} 热搜 讨论 https://www.baidu.com/s?wd=${encodeURIComponent(`${keyword} 热搜 讨论`)}`,
      auto: true,
    },
  ];
}

function collectSources() {
  return Array.from(sourceList.querySelectorAll(".source-row"))
    .map((row) => ({
      tag: row.querySelector(".source-tag").value,
      value: row.querySelector(".source-value").value.trim(),
    }))
    .filter((source) => source.value);
}

function renderDirectionOptions() {
  questionDirectionGroup.innerHTML = queryDirectionConfig
    .map(
      (direction) => `
        <label title="${escapeHtml(direction.description)}">
          <input type="checkbox" name="questionDirection" value="${escapeHtml(direction.id)}" />
          <span class="direction-name">${escapeHtml(direction.name)}</span>
          <span class="direction-desc">${escapeHtml(direction.description)}</span>
        </label>
      `,
    )
    .join("");
}

function renderResult(result) {
  normalizeInput(result.input);
  result.questionAngles = Array.isArray(result.questionAngles) ? result.questionAngles : [];
  result.intents = Array.isArray(result.intents) ? result.intents : [];
  state.mindmap.removedLabels = new Set();
  summaryPanel.innerHTML = `
    <div class="summary-layout">
      <article class="summary-card">
        <h3>热点理解</h3>
        <p>${escapeHtml(result.summary)}</p>
      </article>
      <article class="summary-card">
        <h3>生成方式</h3>
        <p>${escapeHtml(result.generationMode || "本地规则")}</p>
        ${result.aiError ? `<p class="error-note">${escapeHtml(result.aiError)}</p>` : ""}
      </article>
      <article class="summary-card">
        <h3>传播价值</h3>
        <div class="score-row">
          <div class="score">${result.score}</div>
          <div>
            <strong>${escapeHtml(result.recommendation)}</strong>
            <p class="score-note">${escapeHtml(result.category)} · ${escapeHtml(result.emotion)}</p>
          </div>
        </div>
      </article>
      <article class="summary-card">
        <h3>推荐原因</h3>
        <div class="stack-list">
          ${result.reasons.map((reason) => `<p>${escapeHtml(reason)}</p>`).join("")}
        </div>
      </article>
      <article class="summary-card">
        <h3>搜索意图</h3>
        <div class="tag-row">
          ${result.intents.map((intent) => `<span class="tag">${escapeHtml(intent)}</span>`).join("")}
        </div>
      </article>
      <article class="summary-card">
        <h3>适合提问方向</h3>
        <div class="angle-list">
          ${renderQuestionAngles(result.questionAngles)}
        </div>
      </article>
      <article class="summary-card">
        <h3>已记录素材</h3>
        <div class="source-summary">
          ${renderSourceSummary(result.input)}
        </div>
      </article>
    </div>
  `;

  renderQueryList(result);
  resultGrid.hidden = false;
  feishuExportStatus.textContent = "";
  initializeMindmap(result);
}

function renderQueryList(result) {
  const queries = getVisibleQueries(result);
  queryList.innerHTML = queries
    .map(
      (query, index) => `
        <div class="query-item">
          <span class="query-index">${index + 1}</span>
          <div>
            <p class="query-text">${escapeHtml(query.text)}</p>
            <span class="intent">${escapeHtml(query.intent)} · ${query.score || 76} 分</span>
            <span class="query-reason">${escapeHtml(query.reason || "符合真实用户搜索习惯。")}</span>
          </div>
          <button class="ghost-button query-copy" type="button" data-query="${escapeHtml(query.text)}">复制</button>
        </div>
      `,
    )
    .join("");

  queryList.querySelectorAll(".query-copy").forEach((button) => {
    button.addEventListener("click", async () => {
      await copyText(button.dataset.query || "");
      button.textContent = "已复制";
      setTimeout(() => {
        button.textContent = "复制";
      }, 1000);
    });
  });
}

function getVisibleQueries(result) {
  const removedLabels = Array.from(state.mindmap.removedLabels || []);
  if (!removedLabels.length) return result.queries;

  return result.queries.filter((query) => {
    const text = `${query.text} ${query.intent} ${query.reason}`.replace(/\s+/g, "");
    return !removedLabels.some((label) => {
      const key = label.replace(/\s+/g, "");
      return key.length >= 2 && text.includes(key);
    });
  });
}

function renderGeneratingState(input) {
  summaryPanel.innerHTML = `
    <div class="empty-state">
      <h3>正在分析热点</h3>
      <p>正在调用 AI 拆解“${escapeHtml(input.title)}”，生成期间请稍等。</p>
      <p class="score-note">如果模型响应较慢，通常需要 10-30 秒。</p>
    </div>
  `;
  resultGrid.hidden = true;
  mindmapSection.hidden = true;
}

function renderQuestionAngles(angles = []) {
  if (!angles.length) {
    return `<p class="score-note">暂无明确提问方向。</p>`;
  }

  return angles
    .map(
      (angle) => `
        <div class="angle-item">
          <div class="angle-head">
            <strong>${escapeHtml(angle.type)}</strong>
            <span>${angle.fit} 分</span>
          </div>
          <p>${escapeHtml(angle.reason)}</p>
          <div class="tag-row">
            <span class="tag">${escapeHtml(angle.intent)}</span>
            ${angle.queries.slice(0, 2).map((query) => `<span class="tag muted-tag">${escapeHtml(query)}</span>`).join("")}
          </div>
        </div>
      `,
    )
    .join("");
}

function renderSourceSummary(input) {
  const sourceItems = input.sources.map(
    (source) => `
      <div class="source-pill">
        <b>${escapeHtml(source.tag)}</b>
        <span>${escapeHtml(source.value)}</span>
      </div>
    `,
  );
  const items = [...sourceItems];
  return items.length ? items.join("") : `<p class="score-note">暂无来源或背景素材。</p>`;
}

function renderLibrary() {
  if (!state.library.length) {
    libraryList.innerHTML = `<div class="empty-library">暂无保存内容</div>`;
    return;
  }

  libraryList.innerHTML = state.library
    .map((item) => {
      normalizeInput(item.input);
      return `
        <button class="library-item" type="button" data-id="${item.id}">
          <span class="library-title">${escapeHtml(item.input.title)}</span>
          <span class="meta">${formatTime(item.createdAt)} · ${item.score} 分 · ${escapeHtml(item.category)}</span>
        </button>
      `;
    })
    .join("");

  libraryList.querySelectorAll(".library-item").forEach((button) => {
    button.addEventListener("click", () => {
      const selected = state.library.find((item) => item.id === button.dataset.id);
      if (!selected) return;
      state.currentResult = selected;
      fillForm(selected.input);
      renderResult(selected);
    });
  });
}

function fillForm(input) {
  normalizeInput(input);
  document.querySelector("#topicTitle").value = input.title;
  document.querySelector("#manualDirections").value = input.manualDirections;
  sourceList.innerHTML = "";
  if (input.sources.length) {
    input.sources.forEach((source) => addSourceRow(source));
  } else {
    addSourceRow();
  }
  document.querySelectorAll('input[name="audience"]').forEach((checkbox) => {
    checkbox.checked = input.audience.includes(checkbox.value);
  });
  document.querySelectorAll('input[name="questionDirection"]').forEach((checkbox) => {
    checkbox.checked = input.selectedDirectionIds.includes(checkbox.value);
  });
  document.querySelector("#queryCount").value = String(input.queryCount);
}

function loadLibrary() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveLibrary(items) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

function createId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `item-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function copyText(text) {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Some local file contexts block the Clipboard API.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

renderDirectionOptions();
addSourceRow();
renderLibrary();
