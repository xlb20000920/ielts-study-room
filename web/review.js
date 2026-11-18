const DAY = 86_400_000;

export function judgment(record, index, question, correct) {
  return record.overrides?.[index]?.correct ?? correct(record.answers?.[index], question);
}

export function sameMaterial(a, b) {
  if (!a || !b || a.skill !== b.skill) return false;
  if (a.id === b.id) return true;
  if (a.skill === "listening") return Boolean(a.audio && a.audio === b.audio);
  if (a.skill !== "reading") return false;
  const normalize = text => text?.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  const text = normalize(a.material);
  return Boolean(text && text === normalize(b.material));
}

export function reviewQueue(records, lookup, correct, days = 3, now = Date.now()) {
  const pending = new Map();
  for (const record of records) {
    const group = lookup(record.groupId);
    if (!group || !["reading", "listening"].includes(group.skill)) continue;
    // Only a first answer on unseen material can close a queued review.
    for (const [key, task] of pending) {
      const indices = matchingQuestions(group, task.type);
      if (task.skill !== group.skill || task.due > record.started || !indices.length) continue;
      const alreadySeen = records.some(earlier => earlier.finished <= record.started
        && sameMaterial(lookup(earlier.groupId), group));
      if (!alreadySeen && !sameMaterial(task.group, group)
          && indices.every(index => judgment(record, index, group.questions[index], correct))) pending.delete(key);
    }
    group.questions.forEach((question, index) => {
      const type = question.type || group.type;
      if (!type || judgment(record, index, question, correct)) return;
      const retry = record.retryResult?.[index];
      const independentlyCorrect = retry && !retry.assisted && correct(retry.answer, question);
      const key = `${group.skill}:${type}`;
      const due = record.finished + (independentlyCorrect ? days * DAY : 0);
      if (!pending.has(key) || due < pending.get(key).due) {
        pending.set(key, { group, skill: group.skill, type, due, index, independentlyCorrect });
      }
    });
  }
  return [...pending.values()].filter(item => item.due <= now).sort((a, b) => a.due - b.due);
}

function matchingQuestions(group, type) {
  return group.questions.flatMap((question, index) => (question.type || group.type) === type ? [index] : []);
}

export function practiceEvidence(group, records, lookup, due) {
  const seen = records.some(record => sameMaterial(lookup(record.groupId), group));
  const answered = records.some(record => record.groupId === group.id);
  const check = due.find(item =>
    item.skill === group.skill && matchingQuestions(group, item.type).length && item.group.id !== group.id);
  const label = answered ? "原题重做" : seen ? "熟悉材料中的新题" : "全新材料";
  return { seen, answered, label, check };
}

export function mergeHighlight(ranges, start, end) {
  const all = [...ranges, [start, end]].sort((a, b) => a[0] - b[0]);
  const result = [];
  for (const range of all) {
    const previous = result.at(-1);
    if (previous && previous[1] >= range[0]) previous[1] = Math.max(previous[1], range[1]);
    else result.push([...range]);
  }
  return result;
}

export function clipFor(question, group) {
  const index = group.questions.indexOf(question);
  return group.clips?.[index] || question.clip || group.autoClips?.[index] || null;
}

export function validClip(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
}
