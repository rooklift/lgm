import os, shutil, subprocess, sys

thisfilepath = os.path.realpath(__file__)
thisdir = os.path.dirname(thisfilepath)
srcdir = os.path.join(thisdir, "src")

subprocess.Popen(
	[shutil.which("electron"), srcdir] + [os.path.abspath(a) for a in sys.argv[1:]],
	creationflags=subprocess.CREATE_NO_WINDOW,
)
