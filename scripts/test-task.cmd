@echo off
REM Simple test - create a basic task
schtasks.exe /Create /TN "TestTask" /TR "cmd.exe /c echo test" /SC ONLOGON /RL HIGHEST /F