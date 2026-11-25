@echo off
setlocal
if not exist "%~dp0portable\python.exe" (
  echo Extract the full B-read-Assistant folder before starting the assistant.
  pause
  exit /b 1
)
"%~dp0portable\python.exe" -I -B "%~dp0web_server.py" --website %*
set "result=%errorlevel%"
if not "%result%"=="0" pause
exit /b %result%
