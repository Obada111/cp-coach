@echo off
REM Wrapper that sets working directory and runs the startup script
echo DEBUG: Starting at %date% %time% >> "D:\website Coach\logs\task-debug.log"
cd /d "D:\website Coach" >> "D:\website Coach\logs\task-debug.log" 2>&1
echo DEBUG: Directory changed to %CD% >> "D:\website Coach\logs\task-debug.log"
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "D:\website Coach\scripts\start-coach.ps1" >> "D:\website Coach\logs\task-debug.log" 2>&1
echo DEBUG: Exit code: %ERRORLEVEL% >> "D:\website Coach\logs\task-debug.log"