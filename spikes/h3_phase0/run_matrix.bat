@echo off
rem Phase 0 test matrix for MiniMax-H3 on Windows/CUDA. Needs uv and HF_TOKEN.
rem Usage: run_matrix.bat [model]   (default MiniMaxAI/MiniMax-H3; pass a community quantized repo to compare)
setlocal
cd /d "%~dp0"
set MODEL=%1
if "%MODEL%"=="" set MODEL=MiniMaxAI/MiniMax-H3
set RUN=uv run --python 3.12 --with-requirements requirements.txt h3_phase0.py --model %MODEL%

rem 1. 480p, 4 s, whole-component offload
%RUN% --height 480 --width 848 --seconds 4 --offload model
rem 2. Same, layer-by-layer offload (fallback if 1 runs out of GPU memory)
%RUN% --height 480 --width 848 --seconds 4 --offload sequential --skip-embeds
rem 3. 720p, 4 s
%RUN% --height 720 --width 1280 --seconds 4 --offload model --skip-embeds
rem 4. 480p, 6 s (upper end of the v1 target)
%RUN% --height 480 --width 848 --seconds 6 --offload model --skip-embeds

echo.
echo Done. Send back every h3_runs\*\report.json (and a video.mp4 or two).
endlocal
