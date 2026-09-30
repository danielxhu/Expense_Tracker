@echo off
chcp 65001 >nul
title 记账
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没找到 Node.js。
  echo.
  echo   去 https://nodejs.org 下载 LTS 版本装上（一路下一步即可^),
  echo   然后重新双击这个 start.bat。
  echo.
  pause
  exit /b 1
)

rem 等服务起来再打开浏览器
start /b "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 3; Start-Process 'http://localhost:8788'"

node --disable-warning=ExperimentalWarning server.js

echo.
echo   服务已停止。按任意键关闭窗口。
pause >nul
