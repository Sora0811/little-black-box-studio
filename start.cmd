@echo off
chcp 65001 >nul
title 小黑盒 Discord 角色工作室
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 需要 Node.js 20 以上。請先從 https://nodejs.org/ 安裝，再重新執行 start.cmd。
  pause
  exit /b 1
)
node src\web.js --open
if errorlevel 1 pause
