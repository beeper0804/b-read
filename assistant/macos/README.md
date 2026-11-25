# B-read macOS 本地助手

1. 用 Chrome 打开 B-read。进入「AI 翻译 → 连接本地助手」。
2. 解压助手 ZIP，双击 **Start_Assistant.command**。需要 Python 3.11 或更新版本。若还没安装，从 [Python 官网](https://www.python.org/downloads/macos/) 安装。使用官网安装器后，双击「应用程序 → Python 版本号 → Install Certificates.command」完成证书安装。助手首次启动会从 PyPI 下载授权需要的 Python 依赖。
3. 首次启动时，把网页里的 **复制本页网址** 粘贴到终端窗口。把助手显示的配对码填回 Chrome。
4. 如果 Chrome 提示允许 B-read 访问本地设备，选允许。点击「GPT 精读」，按 OpenAI 页面提示用自己的 ChatGPT 账号授权。精读、追问和生成例句时保持助手窗口开启。

如果 Finder 没有直接打开启动脚本，可以打开「终端」，输入 `/bin/bash `（末尾留一个空格），把解压后的 `Start_Assistant.command` 拖进终端，再按回车。

换网址前先关闭运行中的助手，再启动 `Change_Website.command`。助手重新启动后，请用新配对码。macOS 版的授权记录保存在当前用户的 B-read 配置目录中。
