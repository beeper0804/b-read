"""Start the existing B-read assistant with macOS-local configuration."""
import sys
from pathlib import Path
from subprocess import DEVNULL, run
from webbrowser import open as default_browser

# The launcher uses isolated mode. Only this package's own directory is needed.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import web_server
from chatgpt_plan import LocalVault


class MacVault(LocalVault):
    def __init__(self):
        super().__init__()
        self.path = Path.home() / "Library" / "Application Support" / "B-read" / "chatgpt-plan"


def open_in_chrome(url, new=0):
    opened = run(
        ["/usr/bin/open", "-a", "Google Chrome", url],
        stdout=DEVNULL,
        stderr=DEVNULL,
        check=False,
    )
    return opened.returncode == 0 or default_browser(url, new=new)


if __name__ == "__main__":
    web_server.LocalVault = MacVault
    make_handler = web_server.make_handler

    def handler(plan, port, bridge=None):
        return make_handler(plan, port, open_browser=open_in_chrome, bridge=bridge)

    web_server.make_handler = handler
    sys.argv.extend(("--website", "--no-browser"))
    web_server.main()
