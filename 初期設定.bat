@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo =========================================
echo Gemini Generator のデスクトップアイコン作成中
echo =========================================
echo.
node create-shortcut.js
echo.
pause
