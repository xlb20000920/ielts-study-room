export const mockOrder = ["listening", "reading", "writing", "speaking"];

export function inspectMock(set) {
  const sections = mockOrder.map(skill => {
    const groups = set.groups.filter(group => group.skill === skill);
    return {
      skill, groups,
      minutes: groups.reduce((sum, group) => sum + group.minutes, 0),
      questions: groups.reduce((sum, group) => sum + group.questions.length, 0)
    };
  });
  const issues = [];
  for (const section of sections) {
    if (!section.groups.length) issues.push({ skill: section.skill, message: "缺少题组" });
    else if (section.groups.some(group => group.pending)) issues.push({ skill: section.skill, message: "还有题组待核对" });
    if (section.groups.length && ["listening", "reading"].includes(section.skill) && section.questions !== 40) {
      issues.push({ skill: section.skill, message: `已导入 ${section.questions} 题，完整模考需要 40 题` });
    }
  }
  const writing = sections.find(section => section.skill === "writing");
  if (writing.groups.length && (writing.groups.length !== 2
      || !["Task 1", "Task 2"].every(type => writing.groups.some(group => group.type === type)))) {
    issues.push({ skill: "writing", message: "完整模考需要各一篇 Task 1 和 Task 2" });
  }
  if (writing.groups.some(group => group.type === "Task 1" && !group.visual)) {
    issues.push({ skill: "writing", message: "Task 1 缺少图表" });
  }
  const listening = sections.find(section => section.skill === "listening");
  const needsRange = listening.groups.some((group, index) => listening.groups.slice(index + 1).some(other =>
    group.audio === other.audio && (!(group.audioEnd > group.audioStart) || !(other.audioEnd > other.audioStart)
      || !(group.audioEnd <= other.audioStart || other.audioEnd <= group.audioStart))));
  if (needsRange) issues.push({ skill: "listening", message: "多个题组共用录音，需要分别设定不重叠的起止位置" });
  const speaking = sections.find(section => section.skill === "speaking");
  if (speaking.groups.length && !["Part 1", "Part 2", "Part 3"].every(type => speaking.groups.some(group => group.type === type))) {
    issues.push({ skill: "speaking", message: "请标明 Part 1、Part 2 和 Part 3" });
  }
  return { sections, issues, groupIds: sections.flatMap(section => {
    const groups = ["writing", "speaking"].includes(section.skill)
      ? [...section.groups].sort((a, b) => a.type.localeCompare(b.type)) : section.groups;
    return groups.map(group => group.id);
  }) };
}

export function normalizeScoreTables(tables) {
  const result = {};
  for (const skill of ["listening", "reading"]) {
    const table = tables?.[skill];
    if (typeof table?.source !== "string" || !table.source.trim() || !Array.isArray(table.bands)) continue;
    if (table.bands.length !== 41 || !table.bands.every(score =>
      Number.isFinite(score) && score >= 0 && score <= 9 && score * 2 === Math.floor(score * 2))) continue;
    if (!table.bands.every((score, index) => index === 0 || score >= table.bands[index - 1])) continue;
    result[skill] = { source: table.source.trim(), bands: [...table.bands] };
  }
  return result;
}

export function mockTotals(records, scoreTables) {
  return mockOrder.map(skill => {
    const attempts = records.filter(record => record.skill === skill);
    const total = attempts.reduce((sum, record) => sum + record.total, 0);
    const right = total - attempts.reduce((sum, record) => sum + record.wrong, 0);
    const elapsed = attempts.reduce((sum, record) => sum + record.elapsed, 0);
    const table = total === 40 ? scoreTables?.[skill] : null;
    return { skill, attempts: attempts.length, total, right, elapsed, band: table?.bands[right], source: table?.source };
  });
}
