#!/bin/bash
set -u
umask 077

root="$(cd -- "$(dirname -- "$0")" && pwd -P)" || exit 1
settings="$HOME/Library/Application Support/B-read"
venv="$settings/assistant-venv"

fail() {
    printf '\n%s\n' "$1" >&2
    if [ -t 0 ]; then
        printf '按回车关闭。'
        read -r ignored || true
    fi
    exit 1
}

usable_python() {
    "$1" -I -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1
}

python=""
for candidate in "$(command -v python3 || true)" /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    [ -x "$candidate" ] || continue
    if usable_python "$candidate"; then
        python="$candidate"
        break
    fi
done
if [ -z "$python" ]; then
    fail '请先安装 Python 3.11 或更新版本，再打开助手：https://www.python.org/downloads/macos/'
fi

if ! usable_python "$venv/bin/python"; then
    printf '正在准备 B-read 的 Python 环境…\n'
    mkdir -p "$settings" || fail '无法创建 B-read 的本地配置文件夹。'
    "$python" -I -m venv "$venv" || fail '无法建立 Python 环境。请确认 Python 安装完整。'
fi
if ! "$venv/bin/python" -I -c 'from importlib.metadata import version; from cryptography.hazmat.primitives.asymmetric import ec, rsa; assert version("cryptography") == "50.0.2"' >/dev/null 2>&1; then
    printf '首次启动正在安装授权所需的组件，请保持联网…\n'
    "$venv/bin/python" -I -m pip install --disable-pip-version-check --only-binary=:all: \
        -r "$root/requirements-macos.txt" || fail '依赖安装失败。请确认网络可访问 PyPI，再运行此文件。'
fi

printf '请保持此窗口开启，在 Chrome 中返回 B-read 网页并输入配对码。\n'
"$venv/bin/python" -I -B "$root/start_macos.py" "$@"
status=$?
if [ "$status" -ne 0 ]; then
    fail 'B-read 本地助手未能启动。请查看上方提示。'
fi
