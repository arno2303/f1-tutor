# PyInstaller recipe for one self-contained program: F1Tutor.exe on Windows.
# Build on Windows (see README, or .github/workflows/windows-exe.yml):
#   pyinstaller --noconfirm packaging/f1tutor.spec
# The frontend must be built first (frontend/dist).

import os

from PyInstaller.utils.hooks import collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
DIST = os.path.join(ROOT, "frontend", "dist")
if not os.path.isfile(os.path.join(DIST, "index.html")):
    raise SystemExit("frontend/dist is missing. First run: cd frontend && npm install && npm run build")

VOICE = os.path.join(ROOT, "voice")
datas = [(DIST, "frontend/dist")]
# Recordings are optional: without them the app speaks the cues with the system voice.
if os.path.isdir(VOICE) and any(name.endswith(".m4a") for name in os.listdir(VOICE)):
    datas.append((VOICE, "voice"))

analysis = Analysis(
    [os.path.join(ROOT, "server.py")],
    pathex=[ROOT],
    datas=datas,
    # uvicorn picks its HTTP and WebSocket implementations by name at run time.
    hiddenimports=collect_submodules("uvicorn") + collect_submodules("websockets"),
    excludes=["tkinter", "unittest", "pydoc", "watchfiles"],
)
pyz = PYZ(analysis.pure)
exe = EXE(
    pyz,
    analysis.scripts,
    analysis.binaries,
    analysis.datas,
    [],
    name="F1Tutor",
    # The console window shows the IP to set in the game, and closing it ends the app.
    console=True,
    upx=False,
)
