@echo off
setlocal
set "TASK_NAME=CodeforcesCoachStartup"
set "WRAPPER=D:\website Coach\scripts\start-coach-wrapper.cmd"
set "USER=%COMPUTERNAME%\%USERNAME%"

echo Creating scheduled task: %TASK_NAME%
schtasks.exe /Create /TN "%TASK_NAME%" /TR "%WRAPPER%" /SC ONLOGON /RU "%USER%" /RL HIGHEST /F

if %ERRORLEVEL% EQU 0 (
    echo Task created successfully.
) else (
    echo Failed to create task.
)