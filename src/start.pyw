import os, shutil, subprocess, sys

subprocess.Popen(
	[shutil.which("electron"), os.path.dirname(os.path.realpath(__file__))] + [os.path.abspath(a) for a in sys.argv[1:]],
	creationflags=subprocess.CREATE_NO_WINDOW,
)
