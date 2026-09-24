@echo off
setlocal
if not defined OBS_HEADERS set "OBS_HEADERS=%~dp0..\..\third_party\obs-studio-32.1.2\libobs"
if not defined VCVARS64 set "VCVARS64=E:\visual_studio\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%OBS_HEADERS%\obs.h" (
  echo OBS 32.1.2 headers not found at %OBS_HEADERS%
  exit /b 2
)
if not exist "%VCVARS64%" (
  echo Visual Studio C++ environment not found at %VCVARS64%
  exit /b 2
)
call "%VCVARS64%" >nul
if errorlevel 1 exit /b %errorlevel%
pushd "%~dp0"
if not exist build mkdir build
lib /nologo /def:obs.def /machine:x64 /out:build\obs.lib
if errorlevel 1 ( popd & exit /b %errorlevel% )
cl /nologo /std:c++20 /EHsc /I . /I "%OBS_HEADERS%" main.cpp build\obs.lib user32.lib gdi32.lib dxgi.lib ole32.lib mmdevapi.lib /link /out:build\babagan-capture.exe
set "BUILD_STATUS=%errorlevel%"
if %BUILD_STATUS% equ 0 (
  copy /y build\babagan-capture.exe ..\runtime\bin\64bit\babagan-capture.exe >nul
)
popd
exit /b %BUILD_STATUS%
