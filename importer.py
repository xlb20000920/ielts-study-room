"""Extract local source documents and build conservative, editable question groups."""
import io
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree

DOCUMENTS = {".pdf", ".docx", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".txt"}
NUMBERED = re.compile(r"^\s*(\d{1,3})(?:[.)：:]\s*|\s{2,})(\S.*)$")
KEY_LINE = re.compile(r"^\s*(\d{1,3})(?:[.)：:]\s*|\s+)(\S.*)$")
OPTION = re.compile(r"^\s*[A-H][.)]\s+\S")
BREAK = re.compile(r"^\s*(?:(?:reading passage|passage|section|part)\s+\d+|(?:academic )?(?:writing )?task\s+[12])\b", re.I)
XML_NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}


def command(*args, stdin=None, cwd=None):
    executable = shutil.which(args[0])
    if not executable:
        raise ValueError(f"未找到本机工具 {args[0]}")
    env = os.environ.copy()
    if args[0] == "tesseract":
        # A user-name path encoded incorrectly by Tesseract's Windows shim
        # can still be used by staging the small language file locally.
        prefix = env.get("TESSDATA_PREFIX")
        if cwd and prefix and (Path(prefix) / "eng.traineddata").is_file():
            language = Path(cwd) / "tessdata"
            language.mkdir(exist_ok=True)
            if not (language / "eng.traineddata").exists():
                shutil.copyfile(Path(prefix) / "eng.traineddata", language / "eng.traineddata")
            env["TESSDATA_PREFIX"] = "tessdata"
    result = subprocess.run(
        [executable, *args[1:]], capture_output=True, timeout=60, env=env,
        check=False, input=stdin, cwd=cwd, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode:
        raise ValueError(f"{args[0]} 无法读取这份资料")
    return result.stdout.decode("utf-8", errors="replace")


def extract(name, payload):
    suffix = Path(name).suffix.lower()
    if suffix not in DOCUMENTS:
        raise ValueError("请选择 PDF、DOCX、扫描图或 TXT")
    if suffix == ".txt":
        return [payload.decode("utf-8-sig")], False
    if suffix == ".docx":
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            info = archive.getinfo("word/document.xml")
            if info.file_size > 8_000_000:
                raise ValueError("Word 文档的正文过大")
            tree = ElementTree.fromstring(archive.read(info))
            lines = ["".join(node.text or "" for node in p.findall(".//w:t", XML_NS))
                     for p in tree.findall(".//w:p", XML_NS)]
            return ["\n".join(lines)], any(
                item.startswith("word/media/") for item in archive.namelist())
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / f"source{suffix}"
        source.write_bytes(payload)
        if suffix != ".pdf":
            return [command("tesseract", "stdin", "stdout", "-l", "eng", stdin=payload, cwd=directory)], True
        pages = command("pdftotext", "-layout", "-enc", "UTF-8", str(source), "-").split("\f")
        if pages and not pages[-1].strip():
            pages.pop()
        if len(pages) > 40:
            raise ValueError("一次最多处理 40 页，请按科目拆分 PDF")
        needs_review = False
        for index, page in enumerate(pages):
            if len(page.strip()) >= 45:
                continue
            needs_review = True
            prefix = str(Path(directory) / "page")
            command("pdftoppm", "-f", str(index + 1), "-l", str(index + 1),
                    "-r", "165", "-singlefile", "-png", str(source), prefix)
            pages[index] = command("tesseract", "stdin", "stdout", "-l", "eng",
                                   stdin=Path(f"{prefix}.png").read_bytes(), cwd=directory)
        return pages, needs_review


def answer_key(text):
    answers = {}
    for line in text.splitlines():
        match = KEY_LINE.match(line)
        if not match:
            continue
        number, answer = match.groups()
        variants = [part.strip() for part in re.split(r"\s*/\s*|\s+OR\s+", answer, flags=re.I)]
        if number in answers:
            answers[number] = []
        else:
            answers[number] = [item for item in variants if item and len(item) < 100]
    return answers


def source_groups(title, skill, pages, answers, transcript, uncertain):
    if skill not in {"reading", "listening", "writing", "speaking"}:
        raise ValueError("请选择题卷科目")
    blocks = []
    for page, content in enumerate(pages, 1):
        for line in content.splitlines():
            if not blocks or (BREAK.match(line) and blocks[-1]):
                blocks.append([])
            blocks[-1].append((page, line))
    result = []
    for block in blocks or [[(1, "")]]:
        lines = [line.rstrip() for _, line in block]
        text = "\n".join(lines).strip()
        if not text and len(blocks) > 1:
            continue
        label = lines[0].strip() if lines and BREAK.match(lines[0]) else title
        group = {
            "skill": skill, "title": label or title, "pages": [block[0][0], block[-1][0]],
            "pending": uncertain or not text, "questions": [],
        }
        if skill in {"writing", "speaking"}:
            group["prompt"] = text
            if skill == "writing":
                task = re.search(r"\bTask\s+([12])\b", text, re.I)
                group["type"] = f"Task {task[1]}" if task else ""
                group["pending"] = group["pending"] or not task or task[1] == "1"
            else:
                group["pending"] = True
                part = re.search(r"^\s*Part\s+([123])\b", text, re.I)
                group["type"] = f"Part {part[1]}" if part else ""
                if group["type"] != "Part 2":
                    group["speakingQuestions"] = [
                        re.sub(r"^\s*\d+[.)：:]\s*", "", line).strip()
                        for line in lines if line.rstrip().endswith("?")
                    ]
        else:
            questions = []
            before_questions = []
            instructions = []
            for line in lines:
                match = NUMBERED.match(line)
                if match:
                    number, prompt = match.groups()
                    questions.append({"number": int(number), "prompt": prompt, "answers": answers.get(number, []), "options": []})
                elif not questions:
                    if re.match(r"\s*Questions?\s+\d+", line, re.I) or instructions:
                        instructions.append(line)
                    else:
                        before_questions.append(line)
                elif OPTION.match(line):
                    questions[-1]["options"].append(line.strip())
                elif line.strip():
                    questions[-1]["prompt"] += "\n" + line.strip()
                    # Additional unnumbered text can contain an instruction
                    # or a shared option list. Allow manual review to resolve it.
                    group["pending"] = True
            for question in questions:
                if question["options"]:
                    letters = {item[0]: item for item in question["options"]}
                    question["answers"] = [letters.get(answer, answer) for answer in question["answers"]]
                    if any(answer not in question["options"] for answer in question["answers"]):
                        group["pending"] = True
            numbers = [question["number"] for question in questions]
            group["questions"] = questions
            group["material"] = transcript if skill == "listening" else "\n".join(before_questions).strip()
            group["instructions"] = "\n".join(instructions).strip()
            if group["instructions"]:
                group["pending"] = True
            group["pending"] |= (not questions or any(not question["answers"] for question in questions)
                                 or numbers != list(range(numbers[0], numbers[0] + len(numbers))))
        result.append(group)
    return result
