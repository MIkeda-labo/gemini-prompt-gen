@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ==================================================
echo Gemini Prompt Generator: Initial Setup
echo ==================================================
echo.

echo 1. Checking environment file (.env.local)...
if not exist ".env.local" (
    if exist ".env.local.example" (
        copy ".env.local.example" ".env.local" >nul
        echo    Success: Created .env.local from example file.
    ) else (
        echo    Warning: .env.local.example not found.
    )
) else (
    echo    Info: .env.local already exists. Skipping copy.
)

echo.
echo 2. Installing required libraries (npm install)...
echo This may take a few minutes. Please wait...
call npm install

echo.
echo 3. Creating desktop shortcut...
set "LINK_NAME=Gemini Prompt Gen.lnk"
set "TARGET_PATH=%~dp0run_generator.bat"
set "WORK_DIR=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop');$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut(\"$d\%LINK_NAME%\");$s.TargetPath='%TARGET_PATH%';$s.WorkingDirectory='%WORK_DIR%';$s.Save();if(Test-Path \"$d\%LINK_NAME%\"){Write-Host 'Success: Shortcut created.'}else{Write-Host 'Error: Failed to create shortcut.' -ForegroundColor Red}"

echo.
echo ==================================================
echo Setup Complete!
echo IMPORTANT: Open ".env.local" and add your API Key before starting.
echo ==================================================
pause
