# PyInstaller spec for the packaged backend: `pyinstaller rc-backend.spec` writes dist/rc-backend/,
# a folder (not one file, which unpacks itself on every start) that the installer ships beside the app.
#
# Embeddings use bge-small (fastembed), as in development. torch and sentence-transformers, which
# only the evaluation scripts use, are excluded in case they're installed in the venv.

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

hidden = collect_submodules("app") + collect_submodules("uvicorn")
datas = []
# Packages that read files of their own at run time: Word and PowerPoint templates, the web-page
# extractor's settings and word lists, fastembed's model list.
for pkg in ("docx", "pptx", "trafilatura", "justext", "htmldate", "courlan", "fastembed"):
    datas += collect_data_files(pkg)

a = Analysis(
    ["run_backend.py"],
    pathex=["."],
    hiddenimports=hidden,
    datas=datas,
    excludes=[
        "torch", "torchvision", "torchaudio", "sentence_transformers", "transformers",
        # PyMuPDF loads its layout add-on whenever it's installed. The app doesn't use it (it isn't in
        # requirements.txt), it needs model files of its own, and it starts worker processes.
        "pymupdf.layout", "pymupdf4llm",
        "pytest", "_pytest", "tkinter", "IPython", "matplotlib",
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="rc-backend",
    # A console program, so uvicorn has somewhere to write; the app starts it hidden and keeps its output.
    console=True,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="rc-backend", upx=False)
