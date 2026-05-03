@echo off
cd /d "%~dp0"
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000') do taskkill /F /PID %%a >nul 2>&1
start /b cmd /c "npm run dev >nul 2>&1"
timeout /t 4 /nobreak >nul
start msedge.exe --app=http://localhost:3000
