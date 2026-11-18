export function fixedQuestions(group) {
  if (group.type === "Part 2") return [group.prompt];
  if (group.speakingQuestions?.length) return group.speakingQuestions;
  return [group.prompt];
}

export function spokenQuestion(session, group) {
  if (session.followup) return { prompt: session.followup, generated: true };
  const questions = fixedQuestions(group);
  return { prompt: questions[session.speakingIndex || 0] || group.prompt, generated: false };
}

export function allSpokenAnswers(session, group) {
  const result = [...(session.spoken || [])];
  if (session.recording) result.push({ ...spokenQuestion(session, group),
    recording: session.recording, duration: session.recordingDuration });
  return result;
}

export function advanceSpeaking(session, group, followup) {
  if (!session.recording) return false;
  if (!followup && (session.followup || (session.speakingIndex || 0) >= fixedQuestions(group).length - 1)) return false;
  (session.spoken ??= []).push({ ...spokenQuestion(session, group),
    recording: session.recording, duration: session.recordingDuration });
  if (followup) {
    session.followup = followup;
    session.followupCount = (session.followupCount || 0) + 1;
  } else session.speakingIndex = (session.speakingIndex || 0) + 1;
  delete session.recording;
  delete session.recordingDuration;
  session.questionVisible = false;
  return true;
}
