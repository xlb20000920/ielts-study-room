"""Generate conservative listening cues from offline timed transcription."""
import base64
import math
import os
import re
import shutil
import subprocess
import tempfile
from difflib import SequenceMatcher
from pathlib import Path

from coach import CoachError, field

ROOT = Path(__file__).resolve().parent
MODEL = ROOT / "models" / "ggml-tiny.en-q5_1.bin"
WHISPER = ROOT / "bin" / "whisper-cli.exe"
STAMP = r"\d{2}:\d{2}:\d{2}[,.]\d{3}"
WORD = re.compile(r"[a-z]+(?:['’][a-z]+)?|\d+(?:[.:]\d+)?", re.I)
STOP = set("a an and at are as be by can does for from he how in is it of on or she the they to was were what when which who will with you".split())


def tokens(text):
    return [match[0].lower().replace("’", "'") for match in WORD.finditer(text)]


def seconds(stamp):
    h, m, s = stamp.replace(",", ".").split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def read_srt(text):
    segments = []
    for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n").strip()):
        match = re.search(rf"^({STAMP})\s+-->\s+({STAMP})[^\n]*\n(.+)$", block, re.M | re.S)
        if not match:
            continue
        start, end = seconds(match[1]), seconds(match[2])
        words = tokens(match[3])
        if start < end and words:
            segments.append((start, end, words))
    return sorted(segments, key=lambda item: item[0])


def transcribe(encoded, start, end):
    match = re.fullmatch(r"data:audio/[\w.+-]+(?:;codecs=[\w.,-]+)?;base64,([A-Za-z0-9+/=]+)", encoded)
    if not match:
        raise CoachError(422, "题组缺少有效的录音")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg or not MODEL.is_file() or not WHISPER.is_file():
        raise CoachError(503, "本机缺少听力自动定位组件，请检查 FFmpeg、Whisper 程序和转写模型")
    try:
        data = base64.b64decode(match[1], validate=True)
        with tempfile.TemporaryDirectory(prefix="align-", dir=WHISPER.parent) as directory:
            work = Path(directory)
            # whisper.cpp's Windows CLI expects ANSI file arguments. Run it
            # from its own directory and pass only relative ASCII paths so
            # Chinese profile and project names remain supported.
            relative = work.relative_to(WHISPER.parent).as_posix()
            interval = end - start if end is not None else 2900 - start
            if interval <= 0:
                raise CoachError(422, "请确认本题组的录音起止位置")
            audio_filter = f"atrim=start={start}:duration={interval},asetpts=PTS-STARTPTS"
            decode = [ffmpeg, "-nostdin", "-hide_banner", "-v", "error", "-protocol_whitelist",
                      "pipe", "-i", "pipe:0", "-vn", "-af", audio_filter, "-ac", "1", "-ar", "16000",
                      "-c:a", "pcm_s16le", "-y", "-f", "wav", f"{relative}/audio.wav"]
            result = subprocess.run(decode, input=data, cwd=WHISPER.parent, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.PIPE, timeout=120, check=False,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            audio = work / "audio.wav"
            if result.returncode or not audio.is_file() or audio.stat().st_size < 1000:
                raise CoachError(422, "本机无法解码这段录音，请确认 FFmpeg 支持该音频格式")
            command = [str(WHISPER), "-m", "../models/ggml-tiny.en-q5_1.bin", "-f",
                       f"{relative}/audio.wav", "-osrt", "-of", f"{relative}/timed", "-l", "en",
                       "-t", str(max(1, min(2, os.cpu_count() or 1))), "-bs", "2", "-bo", "2",
                       "-ng", "-np"]
            result = subprocess.run(command, cwd=WHISPER.parent, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                    timeout=480, check=False,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            output = work / "timed.srt"
            if result.returncode or not output.is_file():
                raise CoachError(422, "本机听力转写失败，请缩短录音范围后重试")
            return [(left + start, right + start, words)
                    for left, right, words in read_srt(output.read_text(encoding="utf-8-sig"))]
    except subprocess.TimeoutExpired:
        raise CoachError(504, "本地转写超时，请按听力题组设置更短的录音范围后重试") from None
    except (OSError, ValueError):
        raise CoachError(422, "无法准备本地录音或模型") from None


def locate(script, timed):
    words = [match for match in WORD.finditer(script)]
    plain = [match[0].lower().replace("’", "'") for match in words]
    heard = [word for _, _, segment in timed for word in segment]
    offsets = []
    for index, (_, _, segment) in enumerate(timed):
        offsets.extend([index] * len(segment))
    indices = {}
    match_words = SequenceMatcher(None, plain, heard, autojunk=False).get_matching_blocks()
    for match in match_words:
        if match.size < 2:
            continue
        for shift in range(match.size):
            indices[match.a + shift] = offsets[match.b + shift]
    return words, plain, indices


def occurrences(haystack, phrase, indices):
    if not phrase:
        return []
    return [(index, index + len(phrase) - 1) for index, word in enumerate(haystack)
            if word == phrase[0] and haystack[index:index + len(phrase)] == phrase
            and all(token in indices for token in range(index, index + len(phrase)))]


def clip_candidates(script, timed, questions, lower=0, upper=None):
    if not timed:
        return {}
    words, plain, indices = locate(script, timed)
    if len(indices) < 4:
        return {}
    result = {}
    for index, question in enumerate(questions):
        prompt = set(tokens(question.get("prompt", ""))) - STOP
        evidence = tokens(question.get("evidence", ""))
        answers = [tokens(re.sub(r"^[A-H][.)]\s*", "", answer.strip())) for answer in question["answers"]]
        anchors = set(occurrences(plain, evidence, indices)) if len(evidence) >= 3 else set()
        if not anchors:
            anchors = {hit for answer in answers if any(token not in STOP and len(token) > 1 for token in answer)
                       for hit in occurrences(plain, answer, indices)}
        by_segment = {}
        for first, last in anchors:
            left, right = indices[first], indices[last]
            if left > right or timed[right][1] - timed[left][0] > 18:
                continue
            nearby = plain[max(0, first - 14):last + 15]
            score = len(prompt.intersection(nearby))
            key = (left, right)
            prior = by_segment.get(key)
            if prior is None or score > prior[0]:
                by_segment[key] = (score, first, last)
        options = sorted(by_segment.items(), key=lambda item: -item[1][0])
        if not options or (len(options) > 1 and options[0][1][0] - options[1][1][0] < 2):
            continue
        (left, right), _ = options[0]
        first_context = left - 1 if left and timed[left][0] - timed[left - 1][1] < 1.6 else left
        last_context = right + 1 if right + 1 < len(timed) and timed[right + 1][0] - timed[right][1] < 1.6 else right
        start = max(lower, timed[first_context][0] - 0.35)
        end = min(upper, timed[last_context][1] + 0.4) if upper is not None else timed[last_context][1]
        script_hits = [i for i, segment in indices.items() if first_context <= segment <= last_context]
        if end > start and script_hits:
            text = script[words[min(script_hits)].start():words[max(script_hits)].end()]
            result[str(index)] = {"start": round(start, 2), "end": round(end, 2),
                                  "text": text[:3000], "method": "aligned"}
    return result


def align(data):
    script = field(data, "transcript", 60000, True)
    encoded = field(data, "audio", 18_000_000, True)
    queries = data.get("questions")
    if not isinstance(queries, list) or not 1 <= len(queries) <= 60:
        raise CoachError(422, "请先保存需要定位的听力问题与答案")
    questions = []
    for item in queries:
        if not isinstance(item, dict):
            raise CoachError(422, "无法读取听力题目")
        answers = item.get("answers")
        if not isinstance(answers, list) or len(answers) > 12 or not all(isinstance(a, str) and len(a) <= 400 for a in answers):
            raise CoachError(422, "无法读取答案册写法")
        questions.append({"answers": answers, "prompt": field(item, "prompt", 4000),
                          "evidence": field(item, "evidence", 4000)})
    start, end = data.get("start", 0), data.get("end")
    if type(start) not in (int, float) or not math.isfinite(start) or not 0 <= start < 2900:
        raise CoachError(422, "起始秒数无效")
    if end is not None and (type(end) not in (int, float) or not math.isfinite(end) or not start < end <= 2900):
        raise CoachError(422, "结束秒数无效")
    timed = transcribe(encoded, start, end)
    return {"clips": clip_candidates(script, timed, questions, start, end)}
