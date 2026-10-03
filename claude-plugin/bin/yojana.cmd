@echo off
rem yojana for Claude Code on Windows shells; see bin/yojana.
if not defined YOJANA_AGENT set "YOJANA_AGENT=claude"
bun "%~dp0..\..\cli\src\main.ts" %*
