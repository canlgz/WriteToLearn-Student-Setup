#!/usr/bin/env python3
# LINE rich menu（2500×1686）：2×3 卡片＋底列 3 顆。隨手寫→查脈絡→生歷程。
# 首格＝探索寫(/explore，開鍵盤預填)，合併原「隨手記」。需 Pillow+WQY+NotoColorEmoji。
import base64, io, re
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 2500, 1686
CJK = "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"
EMOJI = "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"
def font(sz): return ImageFont.truetype(CJK, sz)
ef = ImageFont.truetype(EMOJI, 109)
INK = (38, 43, 56); MUTED = (122, 135, 148); CARD = (255, 255, 255)
AMBER = (224, 168, 62); TEAL = (42, 143, 176); GREEN = (46, 160, 67); TEAL_DK = (26, 68, 128)

def tint(c, a): return tuple(int(255 + (c[i] - 255) * a) for i in range(3))
def emoji(ch, size):
    im = Image.new("RGBA", (136, 136), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((4, 4), ch, font=ef, embedded_color=True)
    return im.resize((size, size), Image.LANCZOS)
def hgrad(w, h, c0, c1):
    base = Image.new("RGB", (w, 1)); px = base.load()
    for x in range(w):
        t = x / (w - 1); px[x, 0] = tuple(int(c0[i] + (c1[i] - c0[i]) * t) for i in range(3))
    return base.resize((w, h))
def shadow_card(img, box, r, fill, accent=None):
    x0, y0, x1, y1 = box
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle([x0, y0 + 10, x1, y1 + 14], r, fill=(40, 50, 70, 70))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(16)))
    d = ImageDraw.Draw(img); d.rounded_rectangle([x0, y0, x1, y1], r, fill=fill + (255,))
    if accent:
        d.rounded_rectangle([x0, y0, x0 + 16, y1], r, fill=accent + (255,))
        d.rectangle([x0 + 8, y0, x0 + 16, y1], fill=accent + (255,))

PHASES = [("① 隨手寫", AMBER), ("② 查脈絡", TEAL), ("③ 生歷程", GREEN)]
# (col,row,emoji,label,sub,cmd,(kind,val))
TILES = [
    (0, 0, "🎒", "探索寫", "開始一個探索，或直接隨手記", "/explore", ("kb", "/explore ")),
    (0, 1, "📌", "目前記事", "今天的重點摘要", "/now", ("msg", "/now")),
    (1, 0, "🧶", "看脈絡", "你在關注什麼", "/themes", ("msg", "/themes")),
    (1, 1, "💬", "問一下", "問你的脈絡", "/ask …", ("kb", "/ask ")),
    (2, 0, "🌳", "學習歷程", "你學成了什麼", "/journey", ("msg", "/journey")),
    (2, 1, "📚", "學習總冊", "整本歷程匯出", "/portfolio", ("msg", "/portfolio")),
]
BOTTOM = [("🔍", "回想", "/recall …", ("kb", "/recall ")),
          ("🧭", "我的學習", "/me", ("msg", "/me")),
          ("ℹ️", "說明 · 指令", "/help", ("msg", "/help"))]
OUT, COLW, GAP = 40, 780, 40
COLX = [OUT, OUT + COLW + GAP, OUT + 2 * (COLW + GAP)]
TY = [420, 950]; TH = 510

img = Image.new("RGBA", (W, H), (255, 255, 255, 255))
img.alpha_composite(hgrad(W, H, (247, 244, 238), (240, 245, 246)).convert("RGBA"))
d = ImageDraw.Draw(img)
# header
d.text((70, 64), "write", font=font(60), fill=TEAL_DK)
x = 70 + d.textlength("write", font=font(60))
d.text((x, 64), "·to·", font=font(60), fill=MUTED); x += d.textlength("·to·", font=font(60))
d.text((x, 64), "learn", font=font(60), fill=GREEN)
tg = font(48); y = 158; x = 70
for i, (s, c) in enumerate([("隨手寫", AMBER), ("查脈絡", TEAL), ("生歷程", GREEN)]):
    d.text((x, y), s, font=tg, fill=c); x += d.textlength(s, font=tg) + 22
    if i < 2:
        d.text((x, y + 3), "→", font=font(42), fill=MUTED); x += d.textlength("→", font=font(42)) + 22
# chips
for i, (nm, c) in enumerate(PHASES):
    cx = COLX[i] + COLW / 2; cf = font(38); w = d.textlength(nm, font=cf)
    d.rounded_rectangle([cx - w / 2 - 28, 300, cx + w / 2 + 28, 374], 37, fill=c + (255,))
    d.text((cx - w / 2, 314), nm, font=cf, fill=(255, 255, 255))
# tiles
for col, row, emo, lab, sub, cmd, _ in TILES:
    x0 = COLX[col]; y0 = TY[row]; x1 = x0 + COLW; y1 = y0 + TH; acc = PHASES[col][1]
    shadow_card(img, (x0, y0, x1, y1), 30, CARD, accent=acc)
    img.alpha_composite(emoji(emo, 128), (x0 + 56, y0 + 58))
    d.text((x0 + 208, y0 + 74), lab, font=font(72), fill=INK)
    sf = font(40 if d.textlength(sub, font=font(40)) <= COLW - 110 else 34)
    d.text((x0 + 60, y0 + 238), sub, font=sf, fill=MUTED)
    cf = font(44)
    d.rounded_rectangle([x0 + 60, y0 + 358, x0 + 60 + d.textlength(cmd, font=cf) + 46, y0 + 440], 24, fill=tint(acc, 0.14) + (255,))
    d.text((x0 + 83, y0 + 372), cmd, font=cf, fill=acc)
# bottom
by0, by1 = 1500, 1648; bw = (W - 2 * OUT - 2 * GAP) / 3
for i, (emo, lab, cmd, _) in enumerate(BOTTOM):
    x0 = OUT + i * (bw + GAP); x1 = x0 + bw
    d.rounded_rectangle([x0, by0, x1, by1], 30, fill=(255, 255, 255), outline=(224, 228, 233), width=2)
    img.alpha_composite(emoji(emo, 74), (int(x0 + 34), int(by0 + 38)))
    d.text((x0 + 132, by0 + 30), lab, font=font(46), fill=INK)
    d.text((x0 + 132, by0 + 88), cmd, font=font(34), fill=MUTED)

out = img.convert("RGB"); buf = io.BytesIO(); out.save(buf, format="PNG", optimize=True)
png = buf.getvalue(); open("/tmp/richmenu.png", "wb").write(png)
b64 = base64.b64encode(png).decode()
print("PNG bytes:", len(png), "| base64 chars:", len(b64))

def msg(t): return {"type": "message", "text": t}
def kb(fill):
    a = {"type": "postback", "data": "action=noop", "inputOption": "openKeyboard"}
    if fill: a["fillInText"] = fill
    return a
def act(kind, val): return kb(val) if kind == "kb" else msg(val)
areas = []
for col, row, *_rest, a in TILES:
    areas.append({"bounds": {"x": COLX[col], "y": TY[row], "width": COLW, "height": TH}, "action": act(*a)})
for i, (_e, _l, _c, a) in enumerate(BOTTOM):
    areas.append({"bounds": {"x": int(i * (W / 3)), "y": 1480, "width": int(W / 3), "height": H - 1480}, "action": act(*a)})

def jsval(v): return ("'" + v + "'") if isinstance(v, str) else (('true' if v else 'false') if isinstance(v, bool) else str(v))
def jsobj(o): return "{ " + ", ".join(f"{k}: {jsobj(v) if isinstance(v, dict) else jsval(v)}" for k, v in o.items()) + " }"
areas_js = ",\n".join("    " + jsobj(a) for a in areas)
DEF = ("const RICHMENU_DEF = {\n  size: { width: 2500, height: 1686 },\n  selected: true,\n  name: 'wL-main',\n"
       "  chatBarText: '選單 ⌄',\n  areas: [\n" + areas_js + "\n  ]\n};\n")

path = "src/RichMenu.gs"
src = open(path, encoding="utf-8").read()
m = re.search(r"^const RICHMENU_PNG_BASE64 = '.*?';\s*$", src, re.M); rest = src[m.end():]
head = (
    "/**\n * Programmatic Rich Menu setup（write-to-learn 三相導航·2×3＋底列）.\n *\n"
    " *   ① 隨手寫：🎒 探索寫(/explore，開鍵盤預填；合併隨手記) / 📌 目前記事(/now)\n"
    " *   ② 查脈絡：🧶 看脈絡(/themes) / 💬 問一下(/ask，預填)\n"
    " *   ③ 生歷程：🌳 學習歷程(/journey) / 📚 學習總冊(/portfolio)\n"
    " *   底列：🔍 回想(/recall，預填) · 🧭 我的學習(/me) · ℹ️ 說明(/help)\n"
    " * 帶參數指令用 postback inputOption:'openKeyboard'+fillInText 預填。\n"
    " * 部署（免 editor）：白名單 action `richmenu.setup`（_cmd.txt）→ deleteAllRichMenus()+setupRichMenu()。\n"
    " * 圖由 tools/gen_richmenu.py 產生並寫回本檔。\n */\n\n" + DEF +
    "\n// Base64 of tools/gen_richmenu.py 產出的 2500×1686 PNG。\n"
    "const RICHMENU_PNG_BASE64 = '" + b64 + "';\n")
open(path, "w", encoding="utf-8").write(head + rest)
print("wrote", path, "| areas:", len(areas))
