#!/usr/bin/env python3
"""产物预览:把 xlsx / docx / md / csv / html 转成结构化 JSON 给前端渲染"""
import json, os, sys, zipfile

def xlsx_preview(path):
    try:
        import openpyxl
    except Exception:
        return {"type": "raw", "note": "openpyxl 不可用"}
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    sheets = []
    for ws in wb.worksheets:
        rows = []
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            vals = ["" if v is None else (str(v) if not isinstance(v, (int, float)) else v) for v in row]
            while vals and vals[-1] == "":
                vals.pop()
            rows.append(vals)
            if i > 400:
                break
        sheets.append({"name": ws.title, "rows": rows})
    wb.close()
    return {"type": "sheet", "sheets": sheets}

def docx_preview(path):
    try:
        import docx
        from docx.shared import Pt
    except Exception:
        return {"type": "raw", "note": "python-docx 不可用"}
    d = docx.Document(path)
    paras = []
    for p in d.paragraphs:
        if not p.text.strip():
            continue
        runs = []
        for r in p.runs:
            if not r.text:
                continue
            hi = False
            try:
                hi = bool(r.font.highlight_color)
            except Exception:
                pass
            runs.append({
                "t": r.text,
                "b": bool(r.bold),
                "font": r.font.name or "",
                "size": (r.font.size.pt if r.font.size else None),
                "hl": hi,
            })
        paras.append({"style": p.style.name if p.style else "", "align": str(p.alignment or ""), "text": p.text, "runs": runs})
    tables = []
    for t in d.tables:
        rows = []
        for row in t.rows:
            rows.append([c.text.strip() for c in row.cells])
        tables.append({"rows": rows})
    return {"type": "doc", "paragraphs": paras, "tables": tables}

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"type": "raw", "note": "缺参数"}))
        return
    path = sys.argv[1]
    if not os.path.isfile(path):
        print(json.dumps({"type": "raw", "note": "文件不存在"}))
        return
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext in (".xlsx", ".xlsm"):
            out = xlsx_preview(path)
        elif ext == ".docx":
            out = docx_preview(path)
        elif ext == ".md":
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                out = {"type": "md", "content": f.read(400000)}
        elif ext in (".txt", ".csv", ".log", ".json", ".jsonl"):
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read(400000)
            if ext == ".csv":
                lines = content.splitlines()
                rows = [l.split(",") for l in lines[:400]]
                out = {"type": "sheet", "sheets": [{"name": "CSV", "rows": rows}]}
            else:
                out = {"type": "text", "content": content}
        elif ext in (".html", ".htm"):
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                out = {"type": "html", "content": f.read(600000)}
        else:
            out = {"type": "raw", "note": "暂不支持预览该格式", "size": os.path.getsize(path)}
    except Exception as e:
        out = {"type": "raw", "note": f"解析失败:{e}"}
    print(json.dumps(out, ensure_ascii=False))

if __name__ == "__main__":
    main()
