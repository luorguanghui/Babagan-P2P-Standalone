# Third-party source and licensing

This repository's source is distributed under GPLv2 (`LICENSE`). The Windows release bundles a small OBS Studio 32.1.2 runtime: libobs, D3D11 support, Windows capture, WASAPI, and the DLLs those modules need. It does not bundle the OBS Studio user interface or virtual camera driver.

The [1.19 P2P white-flash fix Release](https://github.com/luorguanghui/Babagan-P2P-Standalone/releases/tag/v1.19-p2p-flicker-fix) places these source packages alongside the EXE and APK:

| Package | Version observed in bundled binaries | Source archive |
| --- | --- | --- |
| OBS Studio | 32.1.2, commit `fb4d98bf88fae5fc85cb11fc57f7c5e309282194` | `obs-studio-32.1.2-source.zip` |
| OBS build dependencies | OBS 32.1.2 uses `obs-deps` 2025-08-23 | `obs-deps-2025-08-23-source.tar.gz` (build recipes and dependency references) |
| FFmpeg | n7.1.1, as reported by `avcodec-61.dll` | `ffmpeg-7.1.1-source.tar.xz` from [FFmpeg](https://ffmpeg.org/releases/) |
| x264 | r3106, commit `eaa68fad9e5d201d42fde51665f2d137ae96baf0` | `x264-eaa68fad-source.tar.gz` from a mirror of the [VideoLAN x264 repository](https://code.videolan.org/videolan/x264) |
| libcurl | 8.12.1 | `curl-8.12.1-source.tar.gz` |
| zlib | 1.3.1 | `zlib-1.3.1-source.tar.gz` |
| SRT | 1.5.2 | `srt-v1.5.2-source.tar.gz` |

The runtime also carries zlib 1.3.1, libcurl 8.12.1, SRT, librist, and w32-pthreads. Their dependency versions and build inputs are documented in the pinned obs-deps recipes. Original notices inside each source package remain applicable. Windows SDK and MSVC system libraries are supplied by the operating system and build toolchain.

The standalone client's source and build scripts are in this repository. `scripts/prepare-native.ps1` fetches the pinned OBS source, builds the capture helper and stages DLLs from an installed OBS Studio 32.1.2 distribution on the build machine. The GitHub Release publishes the source archives from this section next to the binaries, following the source availability method described in [GPLv2 section 3](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html#section3).
