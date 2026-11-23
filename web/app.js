import { judgment, reviewQueue, practiceEvidence, mergeHighlight, clipFor, validClip } from "./review.js";
import { inspectMock, normalizeScoreTables, mockTotals } from "./mock.js";
import { fixedQuestions, spokenQuestion, allSpokenAnswers, advanceSpeaking } from "./speaking.js";

const main = document.querySelector("#main");
const dialog = document.querySelector("#dialog");
const dialogBody = document.querySelector("#dialog-body");
const status = document.querySelector("#save-status");
const subjects = { listening: "听力", reading: "阅读", speaking: "口语", writing: "写作" };
const baselineMinutes = { listening: 20, reading: 20, speaking: 10, writing: 40 };
const fresh = () => ({ version: 1, sets: [], records: [], session: null, goals: {}, backupAt: null });
let state = fresh();
let revision, token, saveTimer, saveGeneration = 0;
let saveQueue = Promise.resolve();
let failed = false;
let coachConfigured = false;
const coachRequests = new Map();
const alignmentMessages = new Map();
let alignmentQueue = Promise.resolve();

const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[c]);
const day = value => new Date(value).toLocaleDateString("sv-SE");
const allGroups = () => state.sets.flatMap(set => set.groups);
const groupFor = id => allGroups().find(group => group.id === id);
const exposure = () => [...state.records, ...(state.mockHistory || []).flatMap(run => run.entries)];
const nextBaseline = () => Object.keys(subjects).find(skill => !state.records.some(record => record.mode === "baseline" && record.skill === skill));
const page = (title, contents) => `<section class="page"><h1>${title}</h1>${contents}</section>`;
const button = (label, action, cls = "") => `<button type="button" class="${cls}" data-action="${action}">${label}</button>`;

function save(immediate = true) {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  const generation = ++saveGeneration;
  status.textContent = "正在保存…";
  if (!immediate) {
    saveTimer = setTimeout(save, 180);
    return saveQueue;
  }
  const snapshot = JSON.stringify(state);
  saveQueue = saveQueue.then(async () => {
    if (failed) {
      status.textContent = "另一页面已更新记录 · 可从设置导出";
      return false;
    }
    const response = await fetch("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Local-Token": token },
      body: `{"revision":${revision},"state":${snapshot}}`
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 409) failed = true;
      throw new Error(result.error || "写入失败");
    }
    revision = result.revision;
    if (generation === saveGeneration) status.textContent = "已保存到本机";
    return true;
  }).catch(error => {
    status.textContent = `${error.message} · 可从设置导出`;
    return false;
  });
  return saveQueue;
}

function weeklyRecords() {
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  return state.records.filter(record => record.finished >= monday.getTime());
}

function home() {
  const latest = state.records.at(-1);
  const next = nextBaseline();
  const candidates = ready();
  let title = "从第一套资料开始";
  let detail = "把已有的雅思资料加入题库，之后在这里开始摸底和每日练习。";
  let action = '<a class="button primary" href="#library">导入第一套资料 <span aria-hidden="true">→</span></a>';
  if (state.mock) {
    title = state.mock.phase === "review" ? "继续模考复盘" : "继续本次模考";
    detail = state.mock.title;
    action = '<a class="button primary" href="#mock">继续 →</a>';
  } else if (state.sets.length && !state.goals.total) {
    title = "设定你的备考目标";
    detail = "填写总分目标。你也可以为自己格外关注的科目设定目标。";
    action = '<a class="button primary" href="#settings">设置目标 →</a>';
  } else if (state.session) {
    title = state.session.phase === "review" ? "接着上次的复盘" : "接着上次的练习";
    detail = `${subjects[groupFor(state.session.groupId)?.skill] ?? ""} · ${groupFor(state.session.groupId)?.title ?? ""}`;
    const continuing = state.session.phase === "review" && state.session.mode === "practice"
      && day(state.session.submitted) !== day(Date.now())
      && day(state.session.today?.started ?? 0) !== day(Date.now());
    action = continuing ? button("开始今天的任务 →", "duration", "primary")
      : '<a class="button primary" href="#practice">继续学习 →</a>';
  } else if (candidates.length && next) {
    const task = candidates.find(group => group.skill === next && (next !== "writing" || group.type === "Task 2"));
    const practicedToday = latest?.mode === "baseline" && day(latest.finished) === day(Date.now());
    title = practicedToday ? "今天的摸底已完成" : `从${subjects[next]}摸底开始`;
    detail = practicedToday ? `下一科是${subjects[next]}，约 ${baselineMinutes[next]} 分钟。`
      : task ? `约 ${baselineMinutes[next]} 分钟，完成后可以复盘这次表现。`
        : `请先导入可用的${subjects[next]}摸底题组。`;
    action = practicedToday ? '<a class="button primary" href="#history">查看本次记录 →</a>'
      : task ? button("开始摸底 →", "baseline", "primary") : '<a class="button primary" href="#library">打开题库 →</a>';
  } else if (!next && !state.baselineSeen) {
    title = "四科摸底已完成";
    detail = "回看值得优先练习的问题和对应作答。";
    action = '<a class="button primary" href="#baseline-results">查看优先练习项 →</a>';
  } else if (candidates.length) {
    const lead = recommend(240)[0];
    title = lead ? `今天可以练${subjects[lead.group.skill]}` : "开始今天的学习";
    detail = lead?.reason || "选好可用时间，查看今天能完成的练习和复盘。";
    action = button("开始今天的任务 →", "duration", "primary");
  }
  const week = weeklyRecords();
  return `<section class="hero"><div class="eyebrow">IELTS Academic</div>
    <h1>${escape(title)}</h1><p class="lead">${escape(detail)}</p>${action}</section>
    <section class="home-status">
      ${latest ? `<div><h2>上次学到</h2><a href="#history">${subjects[latest.skill]} · ${escape(latest.title)}</a></div>` : ""}
      <div><h2>本周已练</h2><div class="subjects">${Object.entries(subjects).map(([key, label]) => {
        const done = week.some(record => record.skill === key);
        return `<span class="subject" aria-label="${label}${done ? "已练" : "未练"}">${label} ${done ? "✓" : "○"}</span>`;
      }).join("")}</div></div>
    </section>`;
}

function ready() {
  return state.sets.filter(set => !set.reserved).flatMap(set => set.groups.filter(group => !group.pending));
}

function recommend(minutes, omitted = []) {
  const due = reviewQueue(state.records, groupFor, correct, state.goals.reviewDays || 3);
  const week = weeklyRecords();
  return ready().filter(group => group.minutes + Math.max(3, Math.ceil(group.minutes / 3)) <= minutes && !omitted.includes(group.id))
    .map(group => {
      const attempts = state.records.filter(record => record.skill === group.skill).slice(-4);
      const errors = attempts.reduce((count, record) => count + (record.wrong || 0), 0);
      const confirmed = attempts.flatMap(record => Object.values(record.causes || {})).filter(Boolean);
      const repeated = confirmed.find(cause => confirmed.filter(item => item === cause).length >= 2);
      const evidence = practiceEvidence(group, exposure(), groupFor, due);
      const uncovered = !week.some(record => record.skill === group.skill);
      const target = Number(state.goals[group.skill] || 0);
      const checkRank = !evidence.check ? 0 : evidence.seen ? 18 : 34;
      return {
        group, minutes: group.minutes + Math.max(3, Math.ceil(group.minutes / 3)),
        priority: checkRank + Number(!evidence.answered) * 6 + Number(uncovered) * 8 + Math.min(4, errors)
          + (errors && target ? target / 9 : 0) + (repeated ? 2 : 0),
        label: evidence.label, check: evidence.check,
        reason: evidence.check ? `${evidence.seen ? "用熟悉材料巩固" : "换一份材料复查"}「${evidence.check.type}」。`
          : uncovered ? `本周尚未练${subjects[group.skill]}。`
          : repeated ? `你近期多次确认错因为「${repeated}」，安排一次同科巩固。`
          : errors ? `近期${subjects[group.skill]}出现错题，安排一次巩固。`
            : !evidence.answered ? "这组题还没有作答记录。" : "复习已练过的材料。"
      };
    }).sort((a, b) => b.priority - a.priority || a.minutes - b.minutes);
}

function library() {
  const list = state.sets.map(set => `<article class="panel">
    <div class="row spaced"><h2>${escape(set.title)}</h2>
    <label><input type="checkbox" data-reserve="${set.id}" ${set.reserved ? "checked" : ""} ${state.mock?.setId === set.id ? "disabled" : ""}> 留作模考</label></div>
    ${set.reserved ? `<div class="row">
      ${state.mock?.setId === set.id ? '<a class="button primary" href="#mock">继续本次模考 →</a>'
        : button("查看模考安排", `mock-check:${set.id}`)}
    </div>` : ""}
    ${set.groups.map(group => `<div class="row spaced">
      <p>${subjects[group.skill]} · ${escape(group.title)} · 约 ${group.minutes} 分钟${group.pending ? " · 待核对" : ""}${group.pages ? ` · 原卷第 ${group.pages[0]}–${group.pages[1]} 页` : ""}</p>
      <div class="row">${!set.reserved && !group.pending && !state.session && !state.mock ? button("练这组", `group:${group.id}`) : ""}
        ${button("核对题组", `edit:${group.id}`)}
        ${canAlign(group) ? button("自动匹配片段", `align:${group.id}`) : ""}</div>
      ${canAlign(group) ? alignmentStatus(group) : ""}
    </div>`).join("")}</article>`).join("");
  return page("题库", `<form id="source-import" class="panel">
    <h2>导入原卷</h2>
    <label>加入套题 <select name="set"><option value="">新建套题</option>${state.sets.map(set =>
      `<option value="${set.id}">${escape(set.title)}</option>`).join("")}</select></label>
    <label>新套题名称 <input name="title" maxlength="120"></label>
    <label>科目 <select name="skill">${Object.entries(subjects).map(([key, label]) =>
      `<option value="${key}">${label}</option>`).join("")}</select></label>
    <div class="split">
      <label>题卷 <input name="paper" type="file" accept=".pdf,.docx,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.txt" required></label>
      <label>答案册 <input name="answers" type="file" accept=".pdf,.docx,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.txt"></label>
      <label>听力文字稿 <input name="transcript" type="file" accept=".pdf,.docx,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.txt"></label>
      <label>听力录音 <input name="audio" type="file" accept=".mp3,.wav,.m4a,.ogg,.webm,audio/*"></label>
    </div>
    <label><input name="reserved" type="checkbox"> 新套题留作模考</label>
    <button class="primary">提取题组</button>
    <p id="source-result" role="status"></p>
  </form><div class="panel"><h2>导入整理后的题组</h2>
    <p class="muted">选择按题组整理的 JSON 文件。</p><input id="import-set" type="file" accept=".json,application/json">
    <p id="import-result" role="status"></p></div>${list || '<p class="muted">题库为空。</p>'}`);
}

function normalizeSet(data) {
  if (!data || typeof data.title !== "string" || !data.title.trim() || !Array.isArray(data.groups) || !data.groups.length) {
    throw new Error("套题须包含名称和至少一个题组");
  }
  return {
    id: crypto.randomUUID(), title: data.title.trim(), reserved: data.reserved === true,
    scoreTables: normalizeScoreTables(data.scoreTables),
    groups: data.groups.map((group, index) => {
      if (!group || !Object.hasOwn(subjects, group.skill) || typeof group.title !== "string" || !group.title.trim()) {
        throw new Error(`第 ${index + 1} 个题组缺少有效的科目或名称`);
      }
      const text = value => typeof value === "string" ? value : "";
      const questions = (Array.isArray(group.questions) ? group.questions : []).map(question => {
        if (!question || !text(question.prompt).trim()) throw new Error(`${group.title} 有题目缺少题干`);
        const clip = validClip(question.clip?.start, question.clip?.end) ? question.clip : null;
        return { prompt: question.prompt, number: Number.isInteger(question.number) ? question.number : null,
          type: text(question.type), clip, options: Array.isArray(question.options) ? question.options.filter(option => typeof option === "string") : [],
          answers: Array.isArray(question.answers) ? question.answers.filter(answer => typeof answer === "string" && answer.trim()) : [],
          evidence: text(question.evidence), wordLimit: Number.isInteger(question.wordLimit) && question.wordLimit > 0 ? question.wordLimit : null };
      });
      const audioValue = text(group.audio);
      const media = /^data:audio\/[\w.+-]+;base64,[A-Za-z0-9+/=]+$/.test(audioValue)
        || /^\/audio\/[A-Za-z0-9._/-]+$/.test(audioValue) ? audioValue : "";
      const material = text(group.material);
      const prompt = text(group.prompt);
      const objective = group.skill === "reading" || group.skill === "listening";
      const visual = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(text(group.visual)) ? group.visual : "";
      const incomplete = objective ? !questions.length || questions.some(q => !q.answers.length)
        || (group.skill === "reading" ? !material.trim() : !media) : !prompt.trim();
      return { id: crypto.randomUUID(), skill: group.skill, title: group.title, type: text(group.type), material, prompt,
        questions, audio: media, visual, instructions: text(group.instructions),
        speakingQuestions: Array.isArray(group.speakingQuestions)
          ? group.speakingQuestions.map(value => text(value).trim()).filter(Boolean) : [],
        audioStart: Number.isFinite(group.audioStart) && group.audioStart >= 0 ? group.audioStart : 0,
        audioEnd: Number.isFinite(group.audioEnd) && group.audioEnd > (group.audioStart || 0) ? group.audioEnd : null,
        pages: Array.isArray(group.pages) && group.pages.length === 2 && group.pages.every(Number.isInteger) ? group.pages : null,
        minutes: Number.isInteger(group.minutes) && group.minutes > 0 ? group.minutes : baselineMinutes[group.skill],
        pending: group.pending === true || incomplete };
    })
  };
}

async function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("无法读取选中的文件"));
    reader.readAsDataURL(file);
  });
}

async function importSource(form, fields) {
  const output = form.querySelector("#source-result");
  const submit = form.querySelector("button");
  submit.disabled = true;
  output.textContent = "正在读取原卷和配套资料…";
  try {
    const existing = state.sets.find(set => set.id === fields.set);
    const title = existing?.title || fields.title.trim();
    if (!title) throw new Error("为新套题填写名称");
    const files = [fields.paper, fields.answers, fields.transcript, fields.audio].filter(file => file.size);
    if (files.reduce((size, file) => size + file.size, 0) > 9 * 1024 * 1024) {
      throw new Error("这次选择的原卷和附件合计超过 9 MB，请按科目拆分");
    }
    const documents = {};
    for (const role of ["paper", "answers", "transcript"]) {
      const file = fields[role];
      if (file.size) documents[role] = { name: file.name, base64: (await readDataUrl(file)).split(",")[1] };
    }
    const response = await fetch("/api/import", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Local-Token": token },
      body: JSON.stringify({ title, skill: fields.skill, ...documents })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法提取题组");
    const importId = crypto.randomUUID();
    const audio = fields.audio.size ? await readDataUrl(fields.audio) : "";
    const set = normalizeSet({ title, reserved: Boolean(fields.reserved), groups: data.groups.map(group => ({ ...group, audio })) });
    set.sources = [{ id: importId, documents }];
    for (const group of set.groups) group.sourceId = importId;
    if (existing) {
      existing.groups.push(...set.groups);
      (existing.sources ??= []).push(...set.sources);
    } else state.sets.push(set);
    if (!(await save())) {
      if (existing) {
        existing.groups.splice(-set.groups.length);
        existing.sources.pop();
      } else state.sets.pop();
      throw new Error("资料未能保存。请缩小附件或检查本机服务状态");
    }
    if (form.isConnected) {
      render();
      document.querySelector("#source-result").textContent =
        `已加入 ${set.groups.length} 组，其中 ${set.groups.filter(group => group.pending).length} 组待核对。`;
    }
    for (const group of set.groups.filter(item => !item.pending && canAlign(item))) queueAlignment(group);
  } catch (error) { output.textContent = error.message; }
  finally { submit.disabled = false; }
}

const canAlign = group => group.skill === "listening" && Boolean(group.audio && group.material.trim() && group.questions.length);

function alignmentStatus(group) {
  const detail = alignmentMessages.get(group.id);
  const count = Object.keys(group.autoClips || {}).length;
  return `<span data-align-status="${group.id}" class="muted" role="status">${escape(detail?.text ||
    (count ? `已自动定位 ${count} / ${group.questions.length} 题` : ""))}</span>`;
}

function queueAlignment(group, showResult = false) {
  if (!canAlign(group) || alignmentMessages.get(group.id)?.running) return;
  const update = (text, running = true) => {
    alignmentMessages.set(group.id, { text, running });
    document.querySelectorAll(`[data-align-status="${group.id}"]`).forEach(element => { element.textContent = text; });
  };
  update("等待本机转写…");
  const payload = { audio: group.audio, transcript: group.material, start: group.audioStart ?? 0,
    end: group.audioEnd ?? null, questions: group.questions.map(({ prompt, answers, evidence }) => ({ prompt, answers, evidence })) };
  const originalQuestions = group.questions;
  alignmentQueue = alignmentQueue.then(async () => {
    try {
      update("正在本机转写并匹配片段…");
      const response = await fetch("/api/align", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Local-Token": token }, body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "片段匹配失败");
      if (groupFor(group.id) !== group || group.material !== payload.transcript || group.questions !== originalQuestions
        || (group.audioStart ?? 0) !== payload.start || (group.audioEnd ?? null) !== payload.end) {
        update("题组已更新，可以重新匹配。", false);
        return;
      }
      const existing = group.autoClips;
      group.autoClips = result.clips;
      if (!(await save())) {
        group.autoClips = existing;
        throw new Error("片段未能保存，可以重新匹配");
      }
      const count = Object.keys(result.clips).length;
      update(count ? `已自动定位 ${count} / ${group.questions.length} 题`
        : "未找到可靠片段，可从题组开头回听或手动设置。", false);
      if (showResult && state.session?.groupId === group.id && location.hash === "#practice") render();
    } catch (error) { update(error.message || "本地匹配失败", false); }
  });
}

function editGroup(groupId) {
  const group = groupFor(groupId);
  const set = state.sets.find(item => item.groups.includes(group));
  const documents = set?.sources?.find(item => item.id === group.sourceId)?.documents ?? {};
  const labels = { paper: "题卷", answers: "答案册", transcript: "文字稿" };
  const docs = Object.keys(documents).map(role => button(labels[role], `source:${groupId}:${role}`)).join("");
  const objective = ["reading", "listening"].includes(group.skill);
  const field = (name, label, value, multiline = false) => `<label>${label}
    ${multiline ? `<textarea class="edit-lines" name="${name}" rows="3">${escape(value)}</textarea>`
      : `<input name="${name}" value="${escape(value)}">`}</label>`;
  modal("核对题组", `<div class="row">${docs}</div>
    <p class="muted">对照原件，修正题干、选项和答案。确认完整后，可开放练习。</p>
    <form id="edit-form" data-id="${group.id}">
      ${field("title", "题组名称", group.title)}
      ${field("type", "题型", group.type)}
      <label>作答分钟数 <input name="minutes" type="number" min="1" max="240" required value="${group.minutes}"></label>
      ${group.skill === "listening" ? `<label>本组从录音第几秒开始 <input name="audioStart" type="number"
        step=".01" min="0" value="${group.audioStart ?? 0}"></label>
        <label>本组录音结束秒数 <input name="audioEnd" type="number" step=".01" min="0" value="${group.audioEnd ?? ""}"></label>` : ""}
      <label>题目配图 <input name="visualFile" type="file" accept="image/png,image/jpeg,image/webp"></label>
      ${group.visual ? '<p>已保存配图。选择新图可替换。</p>' : ""}
      ${objective ? `${field("material", group.skill === "reading" ? "阅读原文" : "听力文字稿", group.material, true)}
      ${field("instructions", "作答说明", group.instructions, true)}
      <div id="question-editor">${group.questions.map(questionEditor).join("")}</div>
      <p>${button("添加一题", "add-question")}</p>` : field("prompt", "题目", group.prompt, true)}
      ${group.skill === "speaking" && group.type !== "Part 2"
        ? field("speakingQuestions", "逐题播放的问题（每行一题）", group.speakingQuestions?.join("\n"), true) : ""}
      <label><input type="checkbox" name="approved" ${group.pending ? "" : "checked"}> 核对通过</label>
      <p id="edit-error" role="status"></p><button class="primary">保存核对结果</button>
    </form>`);
}

function questionEditor(question = {}) {
  return `<fieldset data-question-editor><legend>单题</legend>
    <label>原卷题号 <input data-field="number" type="number" min="1" value="${escape(question.number)}"></label>
    <label>题干 <textarea class="edit-lines" data-field="prompt" rows="2">${escape(question.prompt)}</textarea></label>
    <label>题型 <input data-field="type" value="${escape(question.type)}"></label>
    <label>选项（每行一个，填空题可留空）<textarea class="edit-lines" data-field="options" rows="2">${escape(question.options?.join("\n"))}</textarea></label>
    <label>正确答案（每行一种写法）<textarea class="edit-lines" data-field="answers" rows="2">${escape(question.answers?.join("\n"))}</textarea></label>
    <label>答案依据 <textarea class="edit-lines" data-field="evidence" rows="2">${escape(question.evidence)}</textarea></label>
    <label>字数上限 <input data-field="wordLimit" type="number" min="1" value="${escape(question.wordLimit)}"></label>
    <input data-field="clip" type="hidden" value="${escape(JSON.stringify(question.clip ?? null))}">
    ${button("移除此题", "remove-question")}</fieldset>`;
}

function collectQuestions(form) {
  const lines = value => value.split("\n").map(line => line.trim()).filter(Boolean);
  return [...form.querySelectorAll("[data-question-editor]")].map(editor => {
    const get = key => editor.querySelector(`[data-field="${key}"]`).value.trim();
    return {
      number: Number(get("number")) || null, prompt: get("prompt"), type: get("type"), clip: JSON.parse(get("clip")),
      options: lines(get("options")),
      answers: lines(get("answers")), evidence: get("evidence"), wordLimit: Number(get("wordLimit")) || null
    };
  });
}

function downloadSource(groupId, role) {
  const group = groupFor(groupId);
  const set = state.sets.find(item => item.groups.includes(group));
  const file = set?.sources?.find(item => item.id === group.sourceId)?.documents?.[role];
  if (!file) return;
  const bytes = Uint8Array.from(atob(file.base64), character => character.charCodeAt(0));
  const type = /\.pdf$/i.test(file.name) ? "application/pdf"
    : /\.png$/i.test(file.name) ? "image/png"
      : /\.jpe?g$/i.test(file.name) ? "image/jpeg" : "application/octet-stream";
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  if (type === "application/octet-stream") {
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
  } else window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function settings() {
  const field = (key, label, required = false) => `<label>${label} <input name="${key}" type="number" min="0.5" max="9" step="0.5" value="${escape(state.goals[key])}" ${required ? "required" : ""}></label>`;
  const backup = state.backupAt ? `上次导出：${day(state.backupAt)}` : "尚未导出备份";
  const due = !state.backupAt || Date.now() - state.backupAt > 7 * 86400000;
  return page("设置", `<form id="goals" class="panel"><h2>分数目标</h2>${field("total", "总分", true)}
    <div class="row">${Object.entries(subjects).map(([key, label]) => field(key, label)).join("")}</div>
    <label>独立改对后隔几天复查 <input name="reviewDays" type="number" min="1" max="30" value="${state.goals.reviewDays || 3}" required></label>
    <button class="primary">保存目标</button></form>
    <section class="panel"><h2>在线反馈</h2><p>${coachConfigured ? "已配置在线分析。按下分析按钮时才发送相关材料。"
      : "在线分析尚未配置。设置本机 OPENAI_API_KEY 后，重新启动自习室。"} </p></section>
    <section class="panel"><h2>本机备份</h2><p>${backup}${due ? " · 可以备份当前进度" : ""}</p>
    ${button("导出备份", "backup")} ${button("恢复备份", "restore")}
    <input id="restore-file" type="file" accept=".json,application/json" hidden></section>`);
}

function history() {
  const ordinary = state.records.length ? [...state.records].reverse().map(recordCard).join("")
    : '<p class="muted">完成一次摸底或日常练习后，可以在这里回看。</p>';
  const mocks = state.mockHistory?.length ? `<h2>模考记录</h2>${[...state.mockHistory].reverse().map(run =>
    `<article class="panel"><h3>${escape(run.title)}</h3><p>${day(run.finished)}${run.interrupted ? " · 中途结束" : ""}</p>
      <a href="#mock-result/${run.id}">查看四科结果 →</a></article>`).join("")}` : "";
  return page("学习记录", ordinary + mocks);
}

function recordCard(record) {
  const group = groupFor(record.groupId);
  return `<details class="panel" ${state.focusRecord === record.finished ? "open" : ""}><summary>${day(record.finished)} · ${subjects[record.skill]} · ${escape(record.title)}
    ${record.total ? ` · ${record.total - record.wrong}/${record.total}` : ""}</summary>
    <p>${modeNames[record.mode] || "日常练习"} · 实际用时 ${Math.ceil(record.elapsed / 60000)} 分钟
    ${record.materialStatus ? ` · ${escape(record.materialStatus)}` : ""}</p>
    ${record.atLimit && record.text !== record.atLimit.text ? `<details><summary>查看到时稿</summary>
      <p class="prose">${escape(record.atLimit.text || "到时尚未填写")}</p></details>` : ""}
    ${record.text ? `<p class="prose">${escape(record.text)}</p>` : ""}
    ${record.skill === "speaking" && group ? speakingRecordings(record, group, false) : ""}
    ${record.feedback ? feedbackPanel(record, false) : ""}
    ${record.answers ? groupFor(record.groupId)?.questions.map((q, i) =>
      `<p>${q.number ?? i + 1}. ${escape(q.prompt)} · 首答 ${escape(record.answers[i] || "未作答")}${record.retry?.[i] ? ` · 重答 ${escape(record.retry[i])}` : ""}
       ${record.atLimit && record.atLimit.answers[i] !== record.answers[i] ? " · 超时后填写或修改" : ""}
       ${record.retryResult?.[i] ? ` · ${retryLabel(record.retryResult[i])}` : ""}
       ${record.causes?.[i] ? ` · ${escape(record.causes[i])}` : ""}
       ${record.overrides?.[i] ? ` · 复核依据：${escape(record.overrides[i].reason)}` : ""}</p>`).join("") ?? "" : ""}
    </details>`;
}

function baselineResults() {
  const records = state.records.filter(record => record.mode === "baseline");
  const weakest = records.filter(record => record.total && record.wrong)
    .sort((a, b) => b.wrong / b.total - a.wrong / a.total).slice(0, 2);
  const items = weakest.map(record => {
    const group = groupFor(record.groupId);
    const example = group?.questions.findIndex((q, index) => !firstCorrect(record, index, q));
    return `<article class="panel"><h2>${subjects[record.skill]} · ${escape(group?.type || record.title)}</h2>
      <p>本次摸底 ${record.total} 题中，首答有 ${record.wrong} 题需要订正。${example >= 0 ? `例如第 ${group.questions[example].number ?? example + 1} 题。` : ""}</p>
      ${button("回看本次作答", `record-detail:${record.finished}`)}</article>`;
  });
  return page("摸底后优先练什么", `${items.join("") || "<p>听读摸底暂时没有集中错题，接下来会轮换练习四科。</p>"}
    <p class="muted">这些建议来自本次短测。写作摸底只覆盖 Task 2。</p>
    ${button("开始今天的任务 →", "baseline-next", "primary")}`);
}

const modeNames = { baseline: "摸底", mock: "模考" };

function newSession(group, mode) {
  const evidence = practiceEvidence(group, exposure(), groupFor, []);
  return { groupId: group.id, mode, phase: "answer", started: Date.now(),
    materialStatus: mode === "mock" ? "" : evidence.label, limit: mode === "baseline" ? baselineMinutes[group.skill] : group.minutes,
    answers: {}, flags: {}, retry: {}, retryResult: {}, shown: {}, text: "" };
}

function start(group, mode) {
  if (state.session || state.mock) return;
  state.session = newSession(group, mode);
  save();
  if (dialog.open) dialog.close();
  location.hash = "practice";
}

function inspectMockDialog(setId) {
  const set = state.sets.find(item => item.id === setId && item.reserved);
  if (!set) return;
  const { sections, issues } = inspectMock(set);
  const schedule = sections.map(section => `<li>${subjects[section.skill]} · ${section.groups.length} 组
    ${section.questions ? ` · ${section.questions} 题` : ""} · 约 ${section.minutes} 分钟</li>`).join("");
  const problems = issues.map(issue => `<li>${subjects[issue.skill]} · ${escape(issue.message)}</li>`).join("");
  modal("模考安排", `<h3>${escape(set.title)}</h3><ol>${schedule}</ol>
    <p>按原题组顺序作答，每组按导入时设定的时间计时。交完四科后统一复盘。</p>
    ${problems ? `<h3>开考前需补齐</h3><ul>${problems}</ul>` :
      state.session || state.mock ? "<p>请先完成进行中的任务。</p>" : button("开始模考 →", `mock-start:${setId}`, "primary")}`);
}

function openMock(setId) {
  const set = state.sets.find(item => item.id === setId && item.reserved);
  if (!set || state.session || state.mock) return;
  const inspection = inspectMock(set);
  if (inspection.issues.length) return;
  state.mock = { id: crypto.randomUUID(), setId: set.id, title: set.title, groupIds: inspection.groupIds,
    scoreTables: set.scoreTables, index: 0, phase: "answer", entries: [], started: Date.now() };
  dialog.close();
  nextMockGroup();
}

function mockLobby() {
  const run = state.mock;
  if (!run) return page("模考", '<p>从题库进入已保留的套题。</p><a href="#library">打开题库 →</a>');
  const group = groupFor(run.groupIds[run.index]);
  if (!group) return page("模考", "<p>无法读取当前题组，请检查题库或恢复备份。</p>");
  const review = run.phase === "review";
  return page(escape(run.title), `<article class="panel">
    <h2>${review ? "模考已交卷 · 开始复盘" : "下一组题"}</h2>
    <p>第 ${run.index + 1} 组，共 ${run.groupIds.length} 组 · ${subjects[group.skill]} · ${escape(group.title)}</p>
    ${!review ? `<p>作答约 ${group.minutes} 分钟，开始后计时。</p>` : ""}
    ${state.session ? '<a class="button primary" href="#practice">继续本组 →</a>'
      : button(review ? "复盘本组 →" : "开始本组 →", "mock-next", "primary")}
    ${button(review ? "结束复盘" : "中途结束", "mock-stop-check")}
    </article>`);
}

function nextMockGroup() {
  const run = state.mock;
  if (!run || state.session) return;
  const group = groupFor(run.groupIds[run.index]);
  if (!group) return;
  state.session = run.phase === "review" ? { ...run.entries[run.index], phase: "review" } : newSession(group, "mock");
  save();
  location.hash = "practice";
}

function packRecord(session, group) {
  return { ...session, title: group.title, skill: group.skill, finished: Date.now(),
    elapsed: session.submitted - session.started, total: group.questions.length,
    wrong: group.questions.filter((q, i) => !firstCorrect(session, i, q)).length };
}

function submitMock() {
  const run = state.mock;
  const session = state.session;
  run.entries[run.index] = packRecord(session, groupFor(session.groupId));
  run.index += 1;
  if (run.index === run.groupIds.length) {
    run.index = 0;
    run.phase = "review";
  }
  state.session = null;
  save();
  location.hash = "mock";
}

function finishMock(record) {
  const run = state.mock;
  run.entries[run.index] = record;
  run.index += 1;
  state.session = null;
  if (run.index < run.groupIds.length) {
    save();
    location.hash = "mock";
    return;
  }
  archiveMock(run);
}

function archiveMock(run, interrupted = false) {
  const result = { ...run, phase: "done", interrupted, finished: Date.now() };
  (state.mockHistory ??= []).push(result);
  state.session = null;
  state.mock = null;
  if (dialog.open) dialog.close();
  save();
  location.hash = `mock-result/${result.id}`;
}

function stopMock() {
  const run = state.mock;
  const session = state.session;
  if (!run || recordingSession) return;
  if (session) {
    session.submitted ??= Date.now();
    for (const [index, answer] of Object.entries(session.retry)) {
      if (answer.trim() && !session.retryResult?.[index]) storeRetry(session, groupFor(session.groupId), index);
    }
    run.entries[run.index] = packRecord(session, groupFor(session.groupId));
  }
  archiveMock(run, run.phase === "answer");
}

function mockResult(id) {
  const run = state.mockHistory?.find(item => item.id === id);
  if (!run) return page("模考结果", '<p>找不到这次模考。</p><a href="#history">返回学习记录</a>');
  const summary = mockTotals(run.entries, run.scoreTables).map(item => `<article class="panel">
    <h2>${subjects[item.skill]}</h2>
    <p>${!item.attempts ? "未开始" : item.total ? `答对 ${item.right} / ${item.total}` : "已保存作答"}${item.attempts ? ` · 用时 ${Math.ceil(item.elapsed / 60000)} 分钟` : ""}</p>
    ${item.band !== undefined ? `<p>换算分 ${item.band} · 依据 ${escape(item.source)}</p>` : ""}</article>`).join("");
  return page(escape(run.title), `<p>${day(run.finished)} · ${run.interrupted ? "模考中途结束，仅统计已保存的题组" : "模考结果"}</p><div class="split">${summary}</div>
    <h2>各组作答与复盘</h2>${run.entries.map(recordCard).join("")}<a href="#history">返回学习记录</a>`);
}

function correct(answer, question) {
  const normalize = value => String(value || "").trim().toLowerCase().replace(/\s+/g, " ")
    .replace(/\b(colour|colours|favourite|centre|centres|theatre)\b/g, match => ({
      colour: "color", colours: "colors", favourite: "favorite", centre: "center", centres: "centers", theatre: "theater"
    })[match]);
  const value = normalize(answer);
  if (question.wordLimit && value.split(" ").length > question.wordLimit) return false;
  return question.answers.some(expected => normalize(expected) === value);
}

const wordCount = text => text.trim().split(/\s+/).filter(Boolean).length;

function markedText(text, highlights = []) {
  let cursor = 0;
  let output = "";
  for (const [start, end] of highlights) {
    if (start < cursor || end <= start || end > text.length) continue;
    output += `${escape(text.slice(cursor, start))}<mark tabindex="0" title="取消高亮"
      data-action="remove-highlight:${start}">${escape(text.slice(start, end))}</mark>`;
    cursor = end;
  }
  return output + escape(text.slice(cursor));
}

const firstCorrect = (session, i, q) => judgment(session, i, q, correct);
const assisted = (session, i) => Boolean(session.shown[i] || session.transcript || session.transcriptHints?.[i]);
const retryLabel = result => result ? `已提交 · ${result.correct ? "答对" : "仍有误"} · ${result.assisted ? "使用过提示" : "独立重答"}` : "";

function coachStatus(id) {
  return `<p class="muted" data-coach-status="${id}" role="status">${coachRequests.has(id) ? "正在分析…" : ""}</p>`;
}

function feedbackPanel(session, active = true) {
  const speaking = (session.skill || groupFor(session.groupId)?.skill) === "speaking";
  const points = session.feedback?.points;
  if (!Array.isArray(points)) return active ? `<section class="panel"><h2>本次反馈</h2>
    ${button(speaking ? "分析本次录音" : "分析本次作文", "coach-feedback", "primary")}
    ${coachStatus("feedback")}</section>` : "";
  if (!points.length) return `<section class="panel"><p>在线反馈没有找到可以可靠指出的片段。</p>
    ${active ? button("重试分析", "coach-feedback") + coachStatus("feedback") : ""}</section>`;
  return `<section aria-label="重点反馈">${points.map((point, index) => {
    const redo = session.redos?.[index];
    const modelVisible = Boolean(redo?.submitted || redo?.recording);
    return `<article class="panel"><h2>${index === 0 ? "优先改这一处" : "再改这一处"}</h2>
      <blockquote class="prose">${escape(point.quote)}</blockquote>
      ${speaking ? `<p class="muted">第 ${(point.turn ?? 0) + 1} 段 · 约 ${point.start.toFixed(1)}–${point.end.toFixed(1)} 秒</p>
        ${active ? button("回听对应片段", `coach-play:${index}`) : ""}` : ""}
      <p>${escape(point.comment)}</p><p>${escape(point.exercise)}</p>
      ${speaking ? `${redo?.recording ? `<p>重说录音</p><audio controls src="${escape(redo.recording)}"></audio>` : ""}
        ${active ? button(redo?.recording ? "再录一次" : "重说一次", `coach-record:${index}`) : ""}` :
        active && !redo?.submitted ? `<label>我的改写<textarea class="edit-lines" rows="4" data-rewrite="${index}">${escape(redo?.text)}</textarea></label>
        ${button("提交改写", `coach-rewrite:${index}`)}` :
        redo?.text ? `<h3>我的改写</h3><p class="prose">${escape(redo.text)}</p>` : ""}
      ${modelVisible ? `<h3>参考表达</h3><p class="prose">${escape(point.example)}</p>` : ""}
    </article>`;
  }).join("")}</section>`;
}

function writingCheckPanel(session) {
  const check = session.writingCheck;
  return `<section><div class="row">${button("检查拼写和语法", "coach-check")}${coachStatus("check")}</div>
    ${check ? `<div class="panel"><h3>这次检查的提示</h3>
      ${check.issues.length ? `<ul>${check.issues.map(issue => `<li>
        <strong>${escape(issue.quote)}</strong> · ${escape(issue.hint)}</li>`).join("")}</ul>`
        : "<p>这次没有定位到明确的拼写或语法问题。</p>"}</div>` : ""}</section>`;
}

function speakingPrompt(session, group) {
  if (session.phase === "review") return `<article class="panel"><h2>本轮口语</h2>
    <p>共保存 ${allSpokenAnswers(session, group).length} 段回答。可以回听每个回答，或按反馈练习。</p></article>`;
  const question = spokenQuestion(session, group);
  const part2 = group.type === "Part 2" && !question.generated;
  const daily = session.mode === "practice";
  const position = question.generated ? `AI 追问 · 第 ${session.followupCount} 题`
    : `题库题 · 第 ${(session.speakingIndex || 0) + 1} / ${fixedQuestions(group).length} 题`;
  const prep = !session.recording && part2;
  return `<article class="panel"><h2>${part2 ? "Part 2 话题卡" : position}</h2>
    ${part2 ? `<p class="prose">${escape(question.prompt)}</p>`
      : `<div class="row">${button("播放英文问题", "speaking-prompt")}
        ${daily ? button(session.questionVisible ? "隐藏英文题干" : "显示英文题干", "speaking-visible") : ""}</div>`
      + (daily && session.questionVisible ? `<p class="prose">${escape(question.prompt)}</p>` : "")}
    ${prep ? `<div class="row">${session.prepUntil ? "" : button("开始 1 分钟准备", "speaking-prep")}
      <p id="prep-clock" role="status" class="muted"></p></div>` : ""}
    <p id="voice-status" role="status" class="muted"></p></article>`;
}

function speakingRecordings(session, group, active) {
  return allSpokenAnswers(session, group).map((turn, index) => `<div class="panel">
    <p>${turn.generated ? "AI 追问" : "题库题"} · 第 ${index + 1} 段回答</p>
    <p class="prose">${escape(turn.prompt)}</p>
    <audio controls ${active ? `id="speaking-turn-${index}"` : ""} src="${escape(turn.recording)}"></audio>
  </div>`).join("");
}

function speakingArea(session, group) {
  const reviewing = session.phase === "review";
  const more = (session.speakingIndex || 0) + 1 < fixedQuestions(group).length && !session.followup;
  const canFollow = !more && session.mode === "practice" && (session.followupCount || 0) < 2;
  return `<div><article class="panel"><h2>你的回答</h2><p id="mic-status" role="status"></p>
    ${reviewing ? `${speakingRecordings(session, group, true)}
      ${allSpokenAnswers(session, group).length ? feedbackPanel(session) : ""}` : `
      ${session.recording ? `<audio id="speaking-audio" controls src="${escape(session.recording)}"></audio>` : ""}
      <div class="row">${button(session.recording ? "重录本题" : "开始录音", "record")}
        ${button("测试麦克风", "mic-test")}
        ${session.recording && more ? button("下一道题库题", "speaking-next") : ""}
        ${session.recording && canFollow ? button("请 AI 追问", "speaking-followup") : ""}</div>
        <meter id="mic-meter" min="0" max="0.45" value="0" aria-label="麦克风输入音量" hidden></meter>
        ${canFollow && session.recording ? `<p class="muted">会用当前回答生成一道临时问题。</p>${coachStatus("followup")}` : ""}`}</article></div>`;
}

function reviewQuestion(session, group, q, i) {
  const result = session.retryResult?.[i];
  const clip = group.skill === "listening" ? clipFor(q, group) : null;
  const override = session.overrides?.[i];
  const explanation = session.explanations?.[i];
  return `<fieldset><legend>${q.number ?? i + 1}. ${escape(q.prompt)}</legend>
    <p>原答案：${escape(session.answers[i] || "未作答")} · ${firstCorrect(session, i, q) ? "答对" : "待订正"}${override ? "（已复核）" : ""}</p>
    ${group.skill === "listening" ? `<div class="row">
      ${clip ? button("听本题片段", `clip:${i}`) : ""}
      ${button(clip ? "调整片段" : "设置本题片段", `clip-edit:${i}`)}</div>
      ${clip?.text ? `<details data-clip-transcript="${i}" ${session.transcriptHints?.[i] ? "open" : ""}>
        <summary>看本题片段原文</summary><p class="prose">${escape(clip.text)}</p></details>` : ""}` : ""}
    <label>重答 ${q.options.length ? `<select data-retry="${i}" ${result ? "disabled" : ""}><option value="">选择答案</option>
      ${q.options.map(option => `<option value="${escape(option)}" ${session.retry[i] === option ? "selected" : ""}>${escape(option)}</option>`).join("")}</select>`
      : `<input data-retry="${i}" value="${escape(session.retry[i])}" ${result ? "readonly" : ""}>`}</label>
    ${result ? `<p>${retryLabel(result)}</p>` : button("提交重答", `retry:${i}`)}
    ${session.shown[i] ? `<p>答案册：${escape(q.answers.join(" / "))}</p>
      ${q.evidence || clip?.text ? `<p class="prose">${escape(q.evidence || clip.text)}</p>` : ""}
      <div class="row">${button("复核判定", `override:${i}`)}
      ${explanation ? "" : button("解释一下", `coach-explain:${i}`)}</div>
      ${explanation ? `<details open><summary>AI 中文讲解</summary>
        <p>${escape(explanation.explanation)}</p>
        ${explanation.cause ? `<p>可能的错因 · ${escape(explanation.cause)}</p>
          ${button("确认这个错因", `coach-cause:${i}`)}` : ""}</details>` : coachStatus(`explain-${i}`)}` : button("看答案与依据", `reveal:${i}`)}
    <label>确认错因 <select data-cause="${i}"><option value="">未确认</option>${(group.skill === "listening"
      ? ["没听清单词", "漏听改口", "跟丢题号", "拼写或格式"] : ["没找到依据", "读错限定词", "没识别同义替换", "拼写或格式"])
      .concat(explanation?.cause ? [explanation.cause] : []).filter((value, index, values) => values.indexOf(value) === index)
      .map(cause => `<option ${session.causes?.[i] === cause ? "selected" : ""}>${escape(cause)}</option>`).join("")}
    </select></label></fieldset>`;
}

function practice() {
  const session = state.session;
  const group = session && groupFor(session.groupId);
  if (!group) return page("练习", '<p>当前没有进行中的任务。</p><a href="#home">返回首页</a>');
  const reviewing = session.phase === "review";
  const strictListening = session.mode === "baseline" || session.mode === "mock";
  const visual = group.visual ? `<img class="task-visual" src="${escape(group.visual)}" alt="本题图表或地图">` : "";
  const objective = ["listening", "reading"].includes(group.skill);
  const tasks = group.questions.map((q, i) => ({ q, i }));
  const reviewTasks = tasks.filter(({ q, i }) => !correct(session.answers[i], q) || session.flags[i] || session.overrides?.[i])
    .sort((a, b) => Number(firstCorrect(session, a.i, a.q)) - Number(firstCorrect(session, b.i, b.q)));
  const questions = (reviewing ? reviewTasks : tasks).map(({ q, i }) => {
    if (reviewing) {
      return reviewQuestion(session, group, q, i);
    }
    const input = q.options.length ? q.options.map(option => `<label>
      <input type="radio" name="q${i}" data-answer="${i}" value="${escape(option)}" ${session.answers[i] === option ? "checked" : ""}>
      ${escape(option)}</label>`).join("") : `<label>答案 <input data-answer="${i}" value="${escape(session.answers[i])}"></label>`;
    return `<fieldset id="question-${i}"><legend>${q.number ?? i + 1}. ${escape(q.prompt)}</legend>${input}
      <label><input type="checkbox" data-flag="${i}" ${session.flags[i] ? "checked" : ""}> 没把握</label></fieldset>`;
  }).join("");
  const left = group.skill === "reading" ? `<div><div class="row highlight-toolbar">
    ${button("标黄选中文字", "highlight")}<span class="muted" id="highlight-status" role="status"></span></div>
    ${visual}<article id="reading-text" class="panel scroll-panel prose">${markedText(group.material, session.highlights)}</article></div>`
    : group.skill === "listening" ? `<article class="panel"><h2>录音</h2>
      ${reviewing || !strictListening ? `<audio id="review-audio" controls src="${escape(group.audio)}"></audio>
        ${reviewing ? `<div>${button("从这组题开头回听", "clip:group")}</div>` : ""}`
        : `<audio id="baseline-audio" src="${escape(group.audio)}"></audio>${button(session.played ? "已播放" : "播放录音", "play")}`}
      ${reviewing && group.material ? `<details id="transcript" ${session.transcript ? "open" : ""}><summary>看这段原文</summary><p class="prose">${escape(group.material)}</p></details>` : ""}
      ${reviewing && canAlign(group) ? `<div class="row">${button("自动匹配片段", `align:${group.id}`)}
        ${alignmentStatus(group)}</div>` : ""}
      ${visual}
      </article>` : group.skill === "speaking" ? speakingPrompt(session, group) : `<article class="panel"><h2>题目</h2><p class="prose">${escape(group.prompt)}</p>
      ${visual}</article>`;
  const right = objective ? `<section id="question-scroll" class="scroll-panel" aria-label="题目">
    ${group.instructions ? `<p class="notice prose">${escape(group.instructions)}</p>` : ""}${questions || "<p>这组题没有待订正项。</p>"}</section>`
    : group.skill === "writing" ? `<label>作文<textarea id="essay" lang="en" spellcheck="false" ${reviewing ? "readonly" : ""}>${escape(session.text)}</textarea></label>
      <p id="count" class="muted">${wordCount(session.text)} 词</p>
      ${reviewing && session.text.trim() ? feedbackPanel(session) : !reviewing && session.mode === "practice" ? writingCheckPanel(session) : ""}`
      : speakingArea(session, group);
  return page(escape(group.title), `<div class="row spaced">
    <p class="muted">${modeNames[session.mode] || "日常练习"} · ${subjects[group.skill]}</p>
    <p id="timer" class="muted"></p></div><div class="split">${left}${right}</div>
    ${objective && !reviewing ? `<nav class="question-nav" aria-label="题号">${tasks.map(({ q, i }) =>
      `<button type="button" class="question-link" data-question-index="${i}" data-action="jump:${i}">${q.number ?? i + 1}</button>`).join("")}</nav>` : ""}
    ${button(reviewing ? "完成复盘" : session.mode === "mock" ? "提交本组" : "交卷", reviewing ? "finish" : "submit", "primary")}
    <a class="button" href="#home">保存并返回</a>`);
}

function updateQuestionNav() {
  for (const link of document.querySelectorAll("[data-question-index]")) {
    const index = link.dataset.questionIndex;
    const label = state.session.flags[index] ? "没把握" : state.session.answers[index]?.trim() ? "已答" : "未答";
    link.dataset.state = label;
    link.setAttribute("aria-label", `第 ${link.textContent} 题，${label}`);
    link.title = label;
  }
}

function tick() {
  const timer = document.querySelector("#timer");
  if (!timer || !state.session || state.session.phase !== "answer") return;
  const seconds = Math.ceil((state.session.limit * 60000 - (Date.now() - state.session.started)) / 1000);
  if (seconds <= 0 && !state.session.atLimit) {
    state.session.atLimit = { answers: { ...state.session.answers }, text: state.session.text };
    save();
  }
  const absolute = Math.abs(seconds);
  timer.textContent = `${seconds < 0 ? "时间已到，可以继续 · 超时" : "剩余"} ${Math.floor(absolute / 60)}:${String(absolute % 60).padStart(2, "0")}`;
  const prep = document.querySelector("#prep-clock");
  if (prep && state.session.prepUntil) {
    const left = Math.max(0, Math.ceil((state.session.prepUntil - Date.now()) / 1000));
    prep.textContent = left ? `准备剩余 ${left} 秒，也可以提前开始作答。` : "准备时间已到，可以录音。";
  }
}

function render() {
  const [route, argument] = (location.hash.slice(1) || "home").split("/");
  const positions = ["#reading-text", "#question-scroll"].map(selector => [selector, document.querySelector(selector)?.scrollTop]);
  const pages = { home, library, settings, history, practice, mock: mockLobby, "mock-result": mockResult, "baseline-results": baselineResults };
  main.innerHTML = (Object.hasOwn(pages, route) ? pages[route] : home)(argument);
  document.body.classList.toggle("exam-focus", route === "practice" && ["baseline", "mock"].includes(state.session?.mode) && state.session?.phase === "answer");
  for (const [selector, top] of positions) {
    const element = document.querySelector(selector);
    if (element && top) element.scrollTop = top;
  }
  document.querySelectorAll("nav a").forEach(link => {
    if (link.hash === `#${route}`) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const transcript = document.querySelector("#transcript");
  transcript?.addEventListener("toggle", () => {
    if (transcript.open && state.session && !state.session.transcript) {
      state.session.transcript = true;
      save();
    }
  });
  document.querySelectorAll("[data-clip-transcript]").forEach(element => element.addEventListener("toggle", () => {
    if (!element.open || !state.session) return;
    const index = element.dataset.clipTranscript;
    const hints = state.session.transcriptHints ??= {};
    if (!hints[index]) {
      hints[index] = true;
      save();
    }
  }));
  tick();
  updateQuestionNav();
}

function modal(title, contents) {
  dialogBody.innerHTML = `<h2 id="dialog-title">${title}</h2>${contents}
    <form method="dialog"><button>关闭</button></form>`;
  if (!dialog.open) dialog.showModal();
}

function preview(minutes, omitted = []) {
  if (state.session?.phase === "review") {
    const session = state.session;
    const group = groupFor(session.groupId);
    const reviewCount = group.questions.filter((q, i) =>
      (!firstCorrect(session, i, q) || session.flags[i]) && !session.retryResult?.[i] && !session.shown[i]).length;
    const estimate = Math.min(minutes, Math.max(3, reviewCount * 2));
    const [next] = recommend(minutes - estimate, [group.id]);
    return modal("今天的任务", `<div class="panel"><h3>先完成上次的${subjects[group.skill]}复盘</h3>
      <p>${escape(group.title)} · 预计约 ${estimate} 分钟</p>
      ${next ? `<p>如果时间有余，再练${subjects[next.group.skill]}。完成复盘后，可以更换这项任务。</p>` : ""}
      ${button("接着复盘 →", `resume-review:${minutes}`, "primary")}</div>`);
  }
  const [best, alternative] = recommend(minutes, omitted);
  if (!best) return modal("今天的任务", '<p>当前没有适合这个时间段的可用题组。</p>');
  modal("今天的任务", `<div class="panel"><h3>${subjects[best.group.skill]} · ${escape(best.group.title)}</h3>
    <p>练习与复盘约 ${best.minutes} 分钟 · ${best.label}</p><p>${escape(best.reason)}</p>
    ${button("开始 →", `group:${best.group.id}`, "primary")}
    ${alternative ? button("换一项", `swap:${minutes}:${[...omitted, best.group.id].join(",")}`) : ""}</div>`);
}

function finish() {
  const session = state.session;
  const group = groupFor(session.groupId);
  for (const [index, answer] of Object.entries(session.retry)) {
    if (answer.trim() && !session.retryResult?.[index]) storeRetry(session, group, index);
  }
  const record = packRecord(session, group);
  if (session.mode === "mock") return finishMock(record);
  state.records.push(record);
  state.session = null;
  save();
  const remaining = session.today && Math.floor(session.today.minutes - (Date.now() - session.today.started) / 60000);
  if (remaining >= 5) {
    location.hash = "home";
    if (recommend(remaining, [group.id]).length) preview(remaining, [group.id]);
  } else location.hash = session.mode === "baseline" && !nextBaseline() ? "baseline-results" : "history";
}

function storeRetry(session, group, index) {
  const answer = session.retry[index]?.trim();
  if (!answer) return false;
  (session.retryResult ??= {})[index] = { answer, assisted: assisted(session, index),
    correct: correct(answer, group.questions[index]) };
  return true;
}

function applyHighlight() {
  const selection = getSelection();
  const article = document.querySelector("#reading-text");
  const message = document.querySelector("#highlight-status");
  if (!selection?.rangeCount || selection.isCollapsed) {
    message.textContent = "请先在原文里选中文字";
    return;
  }
  const range = selection.getRangeAt(0);
  if (!article.contains(range.startContainer) || !article.contains(range.endContainer)) return;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(article);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  const end = start + range.toString().length;
  if (!range.toString().trim()) return;
  state.session.highlights = mergeHighlight(state.session.highlights ?? [], start, end);
  selection.removeAllRanges();
  save();
  const top = article.scrollTop;
  article.innerHTML = markedText(groupFor(state.session.groupId).material, state.session.highlights);
  article.scrollTop = top;
  message.textContent = "已标黄";
}

function listenTo(index) {
  const player = document.querySelector("#review-audio");
  const group = groupFor(state.session.groupId);
  const clip = index === "group" ? null : clipFor(group.questions[index], group);
  const play = () => {
    const start = clip?.start ?? group.audioStart ?? 0;
    if (start >= player.duration || (clip && clip.end > player.duration + 0.1)) {
      status.textContent = "片段超出音频长度，请调整时间";
      return;
    }
    player.currentTime = start;
    player.ontimeupdate = () => {
      const end = clip?.end ?? group.audioEnd;
      if (end && player.currentTime >= end) {
        player.pause();
        player.ontimeupdate = null;
      }
    };
    player.play().catch(() => { status.textContent = "录音无法播放"; });
  };
  if (player.readyState) play();
  else player.addEventListener("loadedmetadata", play, { once: true });
}

function editClip(index) {
  const group = groupFor(state.session.groupId);
  const clip = clipFor(group.questions[index], group);
  const player = document.querySelector("#review-audio");
  const position = Number((player.currentTime || 0).toFixed(2));
  const end = clip?.end ?? Math.min(Number.isFinite(player.duration) ? player.duration : position + 10, position + 10);
  modal("设置本题片段", `<p>可参考播放器位置。时间以秒为单位。</p><form id="clip-form" data-index="${index}">
    <label>开始 <input name="start" type="number" step="0.01" min="0" required value="${clip?.start ?? position}"></label>
    <label>结束 <input name="end" type="number" step="0.01" min="0" required value="${Number(end.toFixed(2))}"></label>
    <p id="clip-error" role="status"></p><button class="primary">保存并试听</button></form>`);
}

async function requestCoach(trigger, id, payload, apply) {
  if (coachRequests.has(id)) return;
  const session = state.session;
  coachRequests.set(id, session);
  const update = message => {
    if (state.session === session) {
      const line = document.querySelector(`[data-coach-status="${id}"]`);
      if (line) line.textContent = message;
    }
  };
  trigger.disabled = true;
  update("正在分析，原作已保留…");
  try {
    if (!(await save())) throw new Error("原作暂未保存，请先检查本机保存状态");
    const response = await fetch("/api/coach", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Local-Token": token }, body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "分析失败，可以重试");
    coachRequests.delete(id);
    if (state.session === session) {
      apply(result);
      save();
      if (location.hash === "#practice") render();
    }
  } catch (error) { update(error.message || "在线分析暂不可用，可以重试"); }
  finally {
    coachRequests.delete(id);
    trigger.disabled = false;
  }
}

function requestFeedback(trigger) {
  const session = state.session;
  const group = groupFor(session.groupId);
  const speaking = group.skill === "speaking";
  const payload = speaking
    ? { kind: "speaking", turns: allSpokenAnswers(session, group).map((turn, index) => {
      const player = document.querySelector(`#speaking-turn-${index}`);
      return { prompt: turn.prompt, recording: turn.recording,
        duration: Number.isFinite(player?.duration) ? player.duration : turn.duration };
    }) }
    : { kind: "writing", text: session.text, prompt: group.prompt, visual: group.visual };
  requestCoach(trigger, "feedback", payload, result => { session.feedback = result; });
}

function playFeedback(index) {
  const point = state.session.feedback.points[index];
  const player = document.querySelector(`#speaking-turn-${point?.turn ?? 0}`);
  if (!player || !point) return;
  const play = () => {
    player.currentTime = point.start;
    player.ontimeupdate = () => {
      if (player.currentTime >= point.end) {
        player.pause();
        player.ontimeupdate = null;
      }
    };
    player.play().catch(() => { status.textContent = "录音无法播放"; });
  };
  if (player.readyState) play();
  else player.addEventListener("loadedmetadata", play, { once: true });
}

function playSpeakingQuestion() {
  const output = document.querySelector("#voice-status");
  const voice = window.speechSynthesis?.getVoices().find(item => item.localService && /^en[-_]/i.test(item.lang));
  if (!voice) {
    output.textContent = "浏览器暂未找到本机英文语音，请检查 Windows 的英语语音包后重试。";
    return;
  }
  const session = state.session;
  const question = spokenQuestion(session, groupFor(session.groupId));
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(question.prompt);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.rate = 0.92;
  utterance.onstart = () => { output.textContent = "正在播放问题"; };
  utterance.onend = () => { output.textContent = ""; };
  utterance.onerror = () => { output.textContent = "英文问题播放失败，请重试。"; };
  speechSynthesis.speak(utterance);
}

function nextSpeaking(followup) {
  if (recordingSession) return;
  window.speechSynthesis?.cancel();
  return advanceSpeaking(state.session, groupFor(state.session.groupId), followup);
}

let recorder, recordingSession;
let micTest;

function stopMicTest() {
  const test = micTest;
  if (!test) return;
  micTest = undefined;
  clearInterval(test.interval);
  test.stream?.getTracks().forEach(track => track.stop());
  test.context?.close().catch(() => {});
}

async function testMicrophone(trigger) {
  if (recordingSession || micTest) return;
  const test = {};
  micTest = test;
  const meter = document.querySelector("#mic-meter");
  const message = document.querySelector("#mic-status");
  trigger.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (micTest !== test || !meter.isConnected) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    test.stream = stream;
    test.context = new AudioContext();
    await test.context.resume();
    if (micTest !== test) return;
    const input = test.context.createMediaStreamSource(stream);
    const analyser = test.context.createAnalyser();
    input.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    let peak = 0;
    const started = performance.now();
    message.textContent = "测试中，请说一句话。";
    meter.hidden = false;
    test.interval = setInterval(() => {
      analyser.getFloatTimeDomainData(buffer);
      const level = Math.sqrt(buffer.reduce((total, sample) => total + sample * sample, 0) / buffer.length);
      meter.value = level;
      peak = Math.max(peak, level);
      if (performance.now() - started >= 5000) {
        stopMicTest();
        message.textContent = peak > 0.005 ? "已检测到麦克风输入。" : "未检测到清晰的麦克风输入。";
        trigger.disabled = false;
      }
    }, 80);
  } catch {
    if (micTest === test) stopMicTest();
    message.textContent = "无法测试麦克风，请检查浏览器权限。";
  } finally {
    if (micTest !== test) trigger.disabled = false;
  }
}

async function record(trigger, pointIndex = null) {
  if (coachRequests.has("followup")) return;
  if (recorder?.state === "recording") {
    recorder.stop();
    trigger.disabled = true;
    return;
  }
  const message = document.querySelector("#mic-status");
  const requestedSession = state.session;
  stopMicTest();
  const meter = document.querySelector("#mic-meter");
  if (meter) meter.hidden = true;
  const micButton = document.querySelector('[data-action="mic-test"]');
  if (micButton) micButton.disabled = false;
  window.speechSynthesis?.cancel();
  trigger.disabled = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const expectedPhase = pointIndex === null ? "answer" : "review";
    if (requestedSession !== state.session || !trigger.isConnected || state.session?.phase !== expectedPhase) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    recordingSession = requestedSession;
    recorder = new MediaRecorder(stream);
    const started = performance.now();
    const chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    recorder.onstop = () => {
      stream.getTracks().forEach(track => track.stop());
      const duration = (performance.now() - started) / 1000;
      const reader = new FileReader();
      reader.onload = () => {
        if (state.session === recordingSession) {
          if (pointIndex === null) {
            state.session.recording = reader.result;
            state.session.recordingDuration = duration;
          } else (state.session.redos ??= {})[pointIndex] = { recording: reader.result, duration };
          save();
          render();
        }
        recordingSession = null;
      };
      reader.readAsDataURL(new Blob(chunks, { type: recorder.mimeType }));
    };
    recorder.start();
    trigger.textContent = "停止录音并保存";
    message.textContent = "正在录音";
  } catch {
    stream?.getTracks().forEach(track => track.stop());
    message.textContent = "无法录音，请检查麦克风和浏览器权限。";
  }
  trigger.disabled = false;
}

document.addEventListener("click", event => {
  const trigger = event.target.closest("[data-action]");
  if (!trigger) return;
  const [action, arg, extras] = trigger.dataset.action.split(":");
  switch (action) {
    case "baseline": {
      const skill = nextBaseline();
      const group = ready().find(item => item.skill === skill && (skill !== "writing" || item.type === "Task 2"));
      if (group) start(group, "baseline");
      break;
    }
    case "baseline-next":
      state.baselineSeen = true;
      save();
      location.hash = "home";
      document.querySelector('[data-action="duration"]')?.focus();
      break;
    case "record-detail":
      state.focusRecord = Number(arg);
      location.hash = "history";
      break;
    case "mock-check": inspectMockDialog(arg); break;
    case "mock-start": openMock(arg); break;
    case "mock-next": nextMockGroup(); break;
    case "mock-stop-check":
      if (!recordingSession) modal("结束本次模考", `<p>已经作答的题组会保留在模考记录里。</p>
        ${button("结束并保存", "mock-stop", "primary")}`);
      break;
    case "mock-stop": stopMock(); break;
    case "duration":
      modal("今天能学多久？", `<p>包含作答、订正和复练。</p><div class="row">${[15, 30, 45, 60].map(n => button(`${n} 分钟`, `preview:${n}`)).join("")}</div>
      <form id="custom"><label>自定义分钟数 <input name="minutes" type="number" min="5" max="240" required></label><button>预览</button></form>`);
      break;
    case "preview": preview(Number(arg)); break;
    case "swap": preview(Number(arg), extras.split(",")); break;
    case "resume-review":
      state.session.today = { started: Date.now(), minutes: Number(arg) };
      save();
      dialog.close();
      location.hash = "practice";
      break;
    case "edit": editGroup(arg); break;
    case "add-question": {
      const editor = document.querySelector("#question-editor");
      editor.insertAdjacentHTML("beforeend", questionEditor());
      editor.lastElementChild.querySelector("input").focus();
      break;
    }
    case "remove-question": trigger.closest("[data-question-editor]").remove(); break;
    case "source": downloadSource(arg, extras); break;
    case "align": {
      const group = groupFor(arg);
      if (group) queueAlignment(group, true);
      break;
    }
    case "jump": {
      const item = document.querySelector(`#question-${arg}`);
      document.querySelector("#question-scroll").scrollTop += item.getBoundingClientRect().top
        - document.querySelector("#question-scroll").getBoundingClientRect().top - 4;
      item.querySelector("input")?.focus({ preventScroll: true });
      break;
    }
    case "highlight": applyHighlight(); break;
    case "remove-highlight":
      state.session.highlights = state.session.highlights.filter(([start]) => start !== Number(arg));
      save();
      render();
      break;
    case "clip": listenTo(arg); break;
    case "clip-edit": editClip(arg); break;
    case "retry":
      if (storeRetry(state.session, groupFor(state.session.groupId), arg)) {
        save();
        render();
      } else trigger.insertAdjacentText("afterend", " 请先填写重答内容");
      break;
    case "coach-feedback": requestFeedback(trigger); break;
    case "coach-check": {
      const session = state.session;
      if (session.mode !== "practice" || !session.text.trim()) {
        document.querySelector('[data-coach-status="check"]').textContent = "请先写下需要检查的内容";
        break;
      }
      const text = session.text;
      requestCoach(trigger, "check", { kind: "check", text }, result => { session.writingCheck = { ...result, text }; });
      break;
    }
    case "coach-explain": {
      const session = state.session;
      const group = groupFor(session.groupId);
      const question = group.questions[arg];
      requestCoach(trigger, `explain-${arg}`, { kind: "explain", prompt: question.prompt,
        answer: question.answers.join(" / "), attempt: session.answers[arg] || "",
        source: (question.evidence || (group.skill === "listening" && clipFor(question, group)?.text) || group.material).slice(0, 27000) },
      result => { (session.explanations ??= {})[arg] = result; });
      break;
    }
    case "coach-cause":
      (state.session.causes ??= {})[arg] = state.session.explanations[arg].cause;
      save();
      render();
      break;
    case "coach-rewrite": {
      const rewrite = state.session.redos?.[arg];
      if (!rewrite?.text?.trim()) {
        trigger.insertAdjacentText("afterend", " 请先写下你的改写");
        break;
      }
      rewrite.submitted = true;
      save();
      render();
      break;
    }
    case "coach-play": playFeedback(arg); break;
    case "coach-record": record(trigger, arg); break;
    case "mic-test": testMicrophone(trigger); break;
    case "speaking-prompt": playSpeakingQuestion(); break;
    case "speaking-prep":
      state.session.prepUntil = Date.now() + 60000;
      save();
      render();
      break;
    case "speaking-visible":
      state.session.questionVisible = !state.session.questionVisible;
      save();
      render();
      break;
    case "speaking-next":
      if (nextSpeaking()) {
        save();
        render();
      }
      break;
    case "speaking-followup": {
      const session = state.session;
      if (recordingSession || session.mode !== "practice" || !session.recording || (session.followupCount || 0) >= 2) break;
      const group = groupFor(session.groupId);
      requestCoach(trigger, "followup", { kind: "followup", prompt: spokenQuestion(session, group).prompt,
        recording: session.recording }, result => nextSpeaking(result.question));
      break;
    }
    case "group": {
      const group = ready().find(item => item.id === arg);
      if (group) start(group, "practice");
      break;
    }
    case "reveal": {
      state.session.shown[arg] = true;
      save();
      render();
      break;
    }
    case "override": {
      const group = groupFor(state.session.groupId);
      const previous = state.session.overrides?.[arg];
      modal("手动复核首答", `<p>原答案：${escape(state.session.answers[arg] || "未作答")}</p>
        <p>答案册：${escape(group.questions[arg].answers.join(" / "))}</p>
        <form id="override-form" data-index="${arg}">
          <label>判定 <select name="verdict"><option value="auto">按答案册自动判定</option>
            <option value="right" ${previous?.correct === true ? "selected" : ""}>判为正确</option>
            <option value="wrong" ${previous?.correct === false ? "selected" : ""}>判为错误</option></select></label>
          <label>复核依据 <input name="reason" value="${escape(previous?.reason)}"></label>
          <p id="override-error" role="status"></p><button class="primary">保存复核结果</button>
        </form>`);
      break;
    }
    case "submit":
      if (recordingSession) return modal("录音尚未保存", "<p>请结束录音并等待保存。</p>");
      if (coachRequests.size) return modal("正在分析", "<p>分析完成后可以提交。</p>");
      state.session.submitted = Date.now();
      if (state.session.mode === "mock") return submitMock();
      state.session.phase = "review";
      save();
      render();
      break;
    case "finish":
      if (recordingSession || coachRequests.size) return modal("处理尚未完成", "<p>请结束录音或等待分析完成。</p>");
      finish();
      break;
    case "record": record(trigger); break;
    case "play": {
      const audio = document.querySelector("#baseline-audio");
      if (state.session.played) break;
      const session = state.session;
      const group = groupFor(session.groupId);
      trigger.disabled = true;
      const play = () => {
        if (!trigger.isConnected || session !== state.session) return;
        if (group.audioStart >= audio.duration || (group.audioEnd && group.audioEnd > audio.duration + 0.1)) {
          trigger.disabled = false;
          status.textContent = "录音时间范围有误";
          return;
        }
        audio.currentTime = group.audioStart || 0;
        audio.ontimeupdate = () => {
          if (group.audioEnd && audio.currentTime >= group.audioEnd) audio.pause();
        };
        audio.play().then(() => {
          session.played = true;
          trigger.textContent = "已播放";
          save();
        }).catch(() => { trigger.disabled = false; status.textContent = "录音无法播放"; });
      };
      if (audio.readyState) play();
      else audio.addEventListener("loadedmetadata", play, { once: true });
      break;
    }
    case "backup": {
      state.backupAt = Date.now();
      const url = URL.createObjectURL(new Blob([JSON.stringify(state)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `IELTS-备份-${day(Date.now())}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      save();
      render();
      break;
    }
    case "restore": document.querySelector("#restore-file").click(); break;
  }
});

document.addEventListener("submit", async event => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(event.target));
  if (event.target.id === "goals") {
    state.goals = Object.fromEntries(Object.entries(fields).filter(([, value]) => value).map(([key, value]) => [key, Number(value)]));
    save();
    location.hash = "home";
  } else if (event.target.id === "source-import") await importSource(event.target, fields);
  else if (event.target.id === "clip-form") {
    const index = event.target.dataset.index;
    const start = Number(fields.start);
    const end = Number(fields.end);
    const player = document.querySelector("#review-audio");
    if (!validClip(start, end) || (Number.isFinite(player.duration) && end > player.duration + 0.1)) {
      document.querySelector("#clip-error").textContent = "请输入录音范围内的开始和结束时间";
      return;
    }
    const group = groupFor(state.session.groupId);
    (group.clips ??= {})[index] = { start, end };
    save();
    dialog.close();
    render();
    listenTo(index);
  } else if (event.target.id === "override-form") {
    const index = event.target.dataset.index;
    const overrides = state.session.overrides ??= {};
    if (fields.verdict === "auto") delete overrides[index];
    else if (fields.reason.trim()) overrides[index] = { correct: fields.verdict === "right", reason: fields.reason.trim() };
    else {
      document.querySelector("#override-error").textContent = "请填写复核依据";
      return;
    }
    save();
    dialog.close();
    render();
  }
  else if (event.target.id === "edit-form") {
    const group = groupFor(event.target.dataset.id);
    try {
      if (state.mock?.groupIds.includes(group.id)) throw new Error("本次模考仍在进行，题组暂不可修改");
      if (fields.visualFile?.size > 2 * 1024 * 1024) throw new Error("图表请使用 2 MB 以内的图片");
      const visual = fields.visualFile?.size ? await readDataUrl(fields.visualFile) : group.visual;
      const audioStart = fields.audioStart === undefined ? group.audioStart : Number(fields.audioStart || 0);
      const audioEnd = fields.audioEnd === undefined ? group.audioEnd : fields.audioEnd ? Number(fields.audioEnd) : null;
      if (audioEnd !== null && audioEnd !== undefined && !validClip(audioStart, audioEnd)) throw new Error("录音结束必须在开始之后");
      const updated = normalizeSet({ title: group.title, groups: [{
        ...group, ...fields, minutes: Number(fields.minutes), questions: collectQuestions(event.target),
        speakingQuestions: typeof fields.speakingQuestions === "string" ? fields.speakingQuestions.split("\n") : group.speakingQuestions,
        visual, audioStart, audioEnd, pending: !fields.approved
      }] }).groups[0];
      if (fields.visualFile?.size && !updated.visual) throw new Error("图表须使用 PNG、JPEG 或 WebP");
      if (fields.approved && updated.pending) throw new Error("题组仍缺少题干、答案或必要的原文和录音");
      if (state.session?.groupId === group.id || exposure().some(record => record.groupId === group.id)) {
        throw new Error("这组题已有作答，保留原题以便回看记录");
      }
      const { id, sourceId } = group;
      const original = { ...group };
      Object.assign(group, updated, { id, sourceId });
      if (!(await save())) {
        Object.assign(group, original);
        throw new Error("保存失败");
      }
      dialog.close();
      render();
    } catch (error) { document.querySelector("#edit-error").textContent = error.message; }
  } else if (event.target.id === "custom") preview(Number(fields.minutes));
  else if (!event.target.id && dialog.open) dialog.close();
});

document.addEventListener("input", event => {
  if (!state.session) return;
  const field = event.target;
  if (field.id === "essay") {
    state.session.text = field.value;
    document.querySelector("#count").textContent = `${wordCount(field.value)} 词`;
  } else if (field.dataset.rewrite !== undefined) {
    (state.session.redos ??= {})[field.dataset.rewrite] = { text: field.value };
  } else if (field.dataset.answer !== undefined) state.session.answers[field.dataset.answer] = field.value;
  else if (field.dataset.retry !== undefined) state.session.retry[field.dataset.retry] = field.value;
  else if (field.dataset.flag !== undefined) state.session.flags[field.dataset.flag] = field.checked;
  else if (field.dataset.cause !== undefined) (state.session.causes ??= {})[field.dataset.cause] = field.value;
  else return;
  updateQuestionNav();
  save(false);
});

document.addEventListener("pointerdown", event => {
  if (event.target.closest('[data-action="highlight"]')) event.preventDefault();
});

document.addEventListener("keydown", event => {
  if (event.target.matches("mark[data-action]") && ["Enter", " "].includes(event.key)) {
    event.preventDefault();
    event.target.click();
  }
});

document.addEventListener("change", async event => {
  const field = event.target;
  if (field.dataset.reserve) {
    state.sets.find(set => set.id === field.dataset.reserve).reserved = field.checked;
    save();
    render();
  } else if (field.id === "import-set" && field.files[0]) {
    try {
      if (field.files[0].size > 10 * 1024 * 1024) throw new Error("一次导入限 10 MB");
      const set = normalizeSet(JSON.parse(await field.files[0].text()));
      state.sets.push(set);
      await save();
      render();
      document.querySelector("#import-result").textContent = `已导入 ${set.groups.length} 组，其中 ${set.groups.filter(group => group.pending).length} 组待核对。`;
    } catch (error) { document.querySelector("#import-result").textContent = error.message; }
  } else if (field.id === "restore-file" && field.files[0]) {
    try {
      const backup = JSON.parse(await field.files[0].text());
      if (backup?.version !== 1 || !Array.isArray(backup.sets) || !Array.isArray(backup.records) || !backup.goals) throw new Error("备份格式无效");
      modal("恢复备份", `<p>备份包含 ${backup.sets.length} 套资料和 ${backup.records.length} 条学习记录。恢复会替换当前数据。</p>
        <button id="confirm-restore" class="primary">恢复这份备份</button>`);
      document.querySelector("#confirm-restore").onclick = async event => {
        const button = event.currentTarget;
        button.disabled = true;
        const previous = state;
        state = backup;
        if (!(await save())) {
          state = previous;
          button.disabled = false;
          button.insertAdjacentText("afterend", " 恢复未保存，请检查本机服务或备份大小");
          return;
        }
        dialog.close();
        render();
      };
    } catch (error) { status.textContent = error.message; }
  }
});

window.addEventListener("hashchange", () => {
  stopMicTest();
  if (recorder?.state === "recording") recorder.stop();
  window.speechSynthesis?.cancel();
  render();
});
window.addEventListener("pagehide", () => {
  if (saveTimer && status.textContent === "正在保存…" && !failed) {
    clearTimeout(saveTimer);
    fetch("/api/state", { method: "PUT", keepalive: true,
      headers: { "Content-Type": "application/json", "X-Local-Token": token },
      body: JSON.stringify({ revision, state }) }).catch(() => {});
  }
});

try {
  const response = await fetch("/api/state");
  if (!response.ok) throw new Error("本机服务暂不可用");
  const result = await response.json();
  state = result.state || fresh();
  token = result.token;
  revision = result.revision;
  render();
  fetch("/api/coach").then(response => response.json()).then(result => {
    coachConfigured = Boolean(result.configured);
    if (location.hash === "#settings" && !main.contains(document.activeElement)) render();
  }).catch(() => {});
  setInterval(tick, 1000);
} catch {
  main.innerHTML = page("无法读取学习空间", "<p>请通过启动脚本打开网站，再刷新页面。</p>");
}
