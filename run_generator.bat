@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo Starting Gemini Prompt Generator...

echo 1. Cleaning up existing processes on port 3000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000') do taskkill /F /PID %%a >nul 2>&1

echo 2. Starting dev server (npm run dev)...
echo If this fails, please run "npm install" first.
start "Gemini Prompt Server" cmd /k "npm run dev"

echo 3. Waiting for server to be ready...
:wait_loop
timeout /t 2 /nobreak >nul
netstat -an | findstr :3000 | findstr LISTENING >nul
if errorlevel 1 (
    echo    Waiting...
    goto wait_loop
)

echo 4. Opening browser...
start msedge.exe --app=http://localhost:3000

echo Done.
