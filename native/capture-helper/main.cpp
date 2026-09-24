#define NOMINMAX
#include <obs.h>
#include <windows.h>
#include <dxgi.h>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>
#include <vector>
#include <mutex>
#include <fcntl.h>
#include <io.h>

namespace {
std::atomic<uint32_t> sequence{0};
std::atomic<bool> pipe_broken{false};
std::mutex output_mutex;
uint32_t output_width = 0;
uint32_t output_height = 0;

std::atomic<bool> dxgi_failed{false};
std::atomic<bool> wgc_failed{false};
std::atomic<int> current_capture_method{0};
std::atomic<bool> method_switch_requested{false};
std::atomic<int> target_method{0};
std::atomic<int> switch_count{0};
std::atomic<uint32_t> consecutive_black_frames{0};
std::atomic<bool> has_received_valid_frame{false};

void log_to_stderr(int, const char *format, va_list args, void *) {
  if (format) {
    if (std::strstr(format, "DuplicateOutput") != nullptr ||
        std::strstr(format, "device_duplicator") != nullptr ||
        std::strstr(format, "duplicator") != nullptr ||
        std::strstr(format, "DXGI") != nullptr ||
        std::strstr(format, "error duplicating") != nullptr ||
        std::strstr(format, "Error duplicating") != nullptr) {
      dxgi_failed.store(true, std::memory_order_relaxed);
    } else if (std::strstr(format, "winrt_capture") != nullptr ||
               std::strstr(format, "libobs-winrt") != nullptr ||
               std::strstr(format, "WindowsGraphicsCapture") != nullptr) {
      wgc_failed.store(true, std::memory_order_relaxed);
    }
  }
  std::vfprintf(stderr, format, args);
  std::fputc('\n', stderr);
}

int find_adapter_for_monitor(HMONITOR target) {
  if (!target) return 0;
  IDXGIFactory1 *factory = nullptr;
  if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void **>(&factory))) || !factory) {
    return 0;
  }
  int matched_adapter = 0;
  bool found = false;
  IDXGIAdapter1 *adapter = nullptr;
  for (UINT a = 0; !found && factory->EnumAdapters1(a, &adapter) != DXGI_ERROR_NOT_FOUND; ++a) {
    IDXGIOutput *output = nullptr;
    for (UINT o = 0; adapter->EnumOutputs(o, &output) != DXGI_ERROR_NOT_FOUND; ++o) {
      DXGI_OUTPUT_DESC desc{};
      if (SUCCEEDED(output->GetDesc(&desc))) {
        if (desc.Monitor == target) {
          matched_adapter = static_cast<int>(a);
          found = true;
        }
      }
      output->Release();
      if (found) break;
    }
    adapter->Release();
  }
  factory->Release();
  return matched_adapter;
}

bool is_frame_black(const uint8_t *y_plane, uint32_t width, uint32_t height, uint32_t linesize) {
  if (!y_plane || width < 16 || height < 16) return true;
  const uint32_t step_x = width / 8;
  const uint32_t step_y = height / 8;
  for (uint32_t y = step_y / 2; y < height; y += step_y) {
    const uint8_t *row = y_plane + y * linesize;
    for (uint32_t x = step_x / 2; x < width; x += step_x) {
      if (row[x] > 20) return false;
    }
  }
  return true;
}

std::string utf8(const std::wstring &wide) {
  int count = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, nullptr, 0, nullptr, nullptr);
  std::string result(static_cast<size_t>(count), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, result.data(), count, nullptr, nullptr);
  result.pop_back();
  return result;
}

std::filesystem::path runtime_root() {
  std::vector<wchar_t> buffer(32768);
  DWORD used = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
  if (!used || used >= buffer.size()) return {};
  return std::filesystem::path(std::wstring(buffer.data(), used)).parent_path().parent_path().parent_path();
}

struct monitor_info { HMONITOR handle; RECT rect; };
BOOL CALLBACK list_monitors(HMONITOR handle, HDC, LPRECT, LPARAM context) {
  MONITORINFO info{};
  info.cbSize = sizeof(info);
  if (GetMonitorInfoW(handle, &info)) {
    reinterpret_cast<std::vector<monitor_info> *>(context)->push_back({handle, info.rcMonitor});
  }
  return TRUE;
}

void write_record(uint32_t type, uint32_t width, uint32_t height, uint64_t timestamp_us,
                  const uint8_t *payload, uint32_t length) {
  std::lock_guard<std::mutex> lock(output_mutex);
  if (pipe_broken.load(std::memory_order_relaxed)) return;
  static uint64_t last_ts_by_type[8] = {};
  if (type < 8) {
    if (timestamp_us <= last_ts_by_type[type] && last_ts_by_type[type] > 0) {
      timestamp_us = last_ts_by_type[type] + 1;
    }
    last_ts_by_type[type] = timestamp_us;
  }
  uint8_t header[36]{};
  std::memcpy(header, "BGCF", 4);
  const uint32_t version = 1, current = sequence.fetch_add(1) + 1;
  std::memcpy(header + 4, &version, 4);
  std::memcpy(header + 8, &type, 4);
  std::memcpy(header + 12, &current, 4);
  std::memcpy(header + 16, &width, 4);
  std::memcpy(header + 20, &height, 4);
  std::memcpy(header + 24, &timestamp_us, 8);
  std::memcpy(header + 32, &length, 4);
  if (std::fwrite(header, 1, sizeof(header), stdout) != sizeof(header) ||
      (length > 0 && std::fwrite(payload, 1, length, stdout) != length) ||
      std::fflush(stdout) != 0) pipe_broken.store(true);
}

void on_frame(void *, struct video_data *frame) {
  if (pipe_broken.load(std::memory_order_relaxed)) return;
  const uint32_t length = output_width * output_height * 3 / 2;
  thread_local std::vector<uint8_t> pixels;
  if (pixels.size() < length) pixels.resize(length);
  uint8_t *cursor = pixels.data();
  for (unsigned plane = 0; plane < 3; ++plane) {
    const uint32_t width = plane == 0 ? output_width : output_width / 2;
    const uint32_t rows = plane == 0 ? output_height : output_height / 2;
    for (uint32_t row = 0; row < rows; ++row) {
      std::memcpy(cursor, frame->data[plane] + row * frame->linesize[plane], width);
      cursor += width;
    }
  }
  // Black frame detection & adaptive fallback
  const bool black = is_frame_black(frame->data[0], output_width, output_height, frame->linesize[0]);
  if (black) {
    const uint32_t count = consecutive_black_frames.fetch_add(1) + 1;
    if (!has_received_valid_frame.load(std::memory_order_relaxed) &&
        !method_switch_requested.load(std::memory_order_relaxed) &&
        switch_count.load(std::memory_order_relaxed) < 2) {
      const int cur = current_capture_method.load(std::memory_order_relaxed);
      if (cur == 1 && (dxgi_failed.load(std::memory_order_relaxed) || count >= 30)) {
        target_method.store(2, std::memory_order_relaxed);
        method_switch_requested.store(true, std::memory_order_relaxed);
      } else if (cur == 2 && (wgc_failed.load(std::memory_order_relaxed) || count >= 60)) {
        target_method.store(1, std::memory_order_relaxed);
        method_switch_requested.store(true, std::memory_order_relaxed);
      }
    }
  } else {
    has_received_valid_frame.store(true, std::memory_order_relaxed);
    consecutive_black_frames.store(0, std::memory_order_relaxed);
  }

  write_record(1, output_width, output_height, frame->timestamp / 1000, pixels.data(), length);
}

void on_audio(void *, size_t, struct audio_data *data) {
  if (!data->data[0] || !data->frames) return;
  write_record(5, 48000, 2, data->timestamp / 1000, data->data[0], data->frames * 4);
}
}

int main(int argc, char **argv) {
  std::string source_id;
  int target_fps = 60, maximum_height = 1080, seconds = 0, system_audio = 0;
  int preferred_method = 0; // 0 = auto-adaptive (DXGI with WGC fallback), 1 = DXGI, 2 = WGC
  for (int i = 1; i + 1 < argc; i += 2) {
    const std::string flag = argv[i], value = argv[i + 1];
    if (flag == "--source") source_id = value;
    else if (flag == "--fps") target_fps = std::atoi(value.c_str());
    else if (flag == "--height") maximum_height = std::atoi(value.c_str());
    else if (flag == "--seconds") seconds = std::atoi(value.c_str());
    else if (flag == "--audio") system_audio = std::atoi(value.c_str());
    else if (flag == "--method") preferred_method = std::atoi(value.c_str());
    else return 2;
  }
  unsigned monitor_index = 0, secondary = 0;
  if (std::sscanf(source_id.c_str(), "screen:%u:%u", &monitor_index, &secondary) != 2 ||
      target_fps != 30 && target_fps != 60 || maximum_height < 360 || maximum_height > 2160 ||
      seconds < 0 || seconds > 3600 || system_audio < 0 || system_audio > 1 ||
      preferred_method < 0 || preferred_method > 2) {
    std::fprintf(stderr, "invalid native capture arguments\n");
    return 2;
  }
  std::vector<monitor_info> monitors;
  EnumDisplayMonitors(nullptr, nullptr, list_monitors, reinterpret_cast<LPARAM>(&monitors));
  if (monitors.empty()) { std::fprintf(stderr, "display unavailable\n"); return 2; }
  if (monitor_index >= monitors.size()) monitor_index = 0;
  const HMONITOR target_handle = monitors[monitor_index].handle;
  const RECT rect = monitors[monitor_index].rect;
  const int base_width = rect.right - rect.left, base_height = rect.bottom - rect.top;
  if (base_width < 2 || base_height < 2) return 2;
  output_height = static_cast<uint32_t>(std::min(base_height, maximum_height) & ~1);
  output_width = static_cast<uint32_t>(std::max(2, (base_width * static_cast<int>(output_height) / base_height) & ~1));
  _setmode(_fileno(stdout), _O_BINARY);
  setvbuf(stdout, nullptr, _IOFBF, 4 * 1024 * 1024);
  base_set_log_handler(log_to_stderr, nullptr);
  const auto root_path = runtime_root();
  if (root_path.empty()) return 3;
  SetDllDirectoryW((root_path / L"bin" / L"64bit").c_str());
  if (!obs_startup("en-US", nullptr, nullptr)) return 3;
  const std::string root = utf8(root_path.wstring());
  obs_add_data_path((root + "/data/libobs/").c_str());
  obs_video_info video{};
  video.graphics_module = "libobs-d3d11";
  video.fps_num = target_fps;
  video.fps_den = 1;
  video.base_width = base_width;
  video.base_height = base_height;
  video.output_width = output_width;
  video.output_height = output_height;
  video.output_format = VIDEO_FORMAT_I420;
  video.adapter = find_adapter_for_monitor(target_handle);
  video.gpu_conversion = true;
  video.colorspace = VIDEO_CS_709;
  video.range = VIDEO_RANGE_PARTIAL;
  video.scale_type = OBS_SCALE_BICUBIC;
  if (obs_reset_video(&video) != OBS_VIDEO_SUCCESS) {
    if (video.adapter != 0) {
      std::fprintf(stderr, "[babagan-capture] obs_reset_video failed on adapter %d, retrying adapter 0\n", video.adapter);
      video.adapter = 0;
      if (obs_reset_video(&video) != OBS_VIDEO_SUCCESS) { obs_shutdown(); return 4; }
    } else {
      obs_shutdown();
      return 4;
    }
  }
  obs_audio_info audio{};
  audio.samples_per_sec = 48000;
  audio.speakers = SPEAKERS_STEREO;
  if (!obs_reset_audio(&audio)) { obs_shutdown(); return 5; }
  const std::string module_path = root + "/obs-plugins/64bit/win-capture.dll";
  const std::string data_path = root + "/data/obs-plugins/win-capture";
  obs_module_t *module = nullptr;
  if (obs_open_module(&module, module_path.c_str(), data_path.c_str()) != MODULE_SUCCESS ||
      !obs_init_module(module)) { obs_shutdown(); return 6; }
  obs_post_load_modules();
  obs_source_t *audio_source = nullptr;
  if (system_audio) {
    const std::string wasapi_module = root + "/obs-plugins/64bit/win-wasapi.dll";
    const std::string wasapi_data = root + "/data/obs-plugins/win-wasapi";
    obs_module_t *wasapi = nullptr;
    if (obs_open_module(&wasapi, wasapi_module.c_str(), wasapi_data.c_str()) != MODULE_SUCCESS ||
        !obs_init_module(wasapi)) { obs_shutdown(); return 10; }
    obs_data_t *audio_settings = obs_data_create();
    obs_data_set_string(audio_settings, "device_id", "default");
    audio_source = obs_source_create("wasapi_output_capture", "system-sound", audio_settings, nullptr);
    obs_data_release(audio_settings);
    if (!audio_source) { obs_shutdown(); return 11; }
    obs_set_output_source(1, audio_source);
  }
  obs_data_t *settings = obs_data_create();
  obs_source_t *source = obs_source_create("monitor_capture", "screen-share", settings, nullptr);
  if (!source) { obs_data_release(settings); obs_shutdown(); return 7; }
  obs_properties_t *properties = obs_source_properties(source);
  obs_property_t *list = properties ? obs_properties_get(properties, "monitor_id") : nullptr;
  unsigned position = 0;
  const char *selected = nullptr;
  const char *first_valid = nullptr;
  if (list) {
    const size_t count = obs_property_list_item_count(list);
    for (size_t i = 0; i < count; ++i) {
      const char *candidate = obs_property_list_item_string(list, i);
      if (!candidate || std::strcmp(candidate, "DUMMY") == 0) continue;
      if (!first_valid) first_valid = candidate;
      if (position++ == monitor_index) { selected = candidate; break; }
    }
  }
  if (!selected) selected = first_valid;
  if (selected) obs_data_set_string(settings, "monitor_id", selected);
  obs_data_set_bool(settings, "capture_cursor", true);
  const int init_method = (preferred_method == 1 || preferred_method == 2) ? preferred_method : 1;
  current_capture_method.store(init_method, std::memory_order_relaxed);
  obs_data_set_int(settings, "method", init_method);
  obs_source_update(source, settings);
  if (properties) obs_properties_destroy(properties);
  obs_data_release(settings);
  obs_set_output_source(0, source);
  obs_add_raw_video_callback(nullptr, on_frame, nullptr);
  audio_convert_info audio_conversion{};
  audio_conversion.samples_per_sec = 48000;
  audio_conversion.format = AUDIO_FORMAT_16BIT;
  audio_conversion.speakers = SPEAKERS_STEREO;
  if (system_audio) obs_add_raw_audio_callback(0, &audio_conversion, on_audio, nullptr);
  int elapsed_ms = 0;
  bool resized = false;
  while (!pipe_broken.load(std::memory_order_relaxed) && (!seconds || elapsed_ms < seconds * 1000)) {
    Sleep(50);
    elapsed_ms += 50;

    // Handle adaptive capture method switch
    const bool dxgi_err = dxgi_failed.load(std::memory_order_relaxed);
    const bool no_frames = (sequence.load(std::memory_order_relaxed) == 0 && elapsed_ms >= 500);
    if (preferred_method == 0 && switch_count.load(std::memory_order_relaxed) < 2) {
      const int cur = current_capture_method.load(std::memory_order_relaxed);
      if (cur == 1 && (dxgi_err || no_frames)) {
        target_method.store(2, std::memory_order_relaxed);
        method_switch_requested.store(true, std::memory_order_relaxed);
      }
    }

    if (method_switch_requested.load(std::memory_order_relaxed)) {
      method_switch_requested.store(false, std::memory_order_relaxed);
      switch_count.fetch_add(1, std::memory_order_relaxed);
      const int next_m = target_method.load(std::memory_order_relaxed);
      current_capture_method.store(next_m, std::memory_order_relaxed);
      consecutive_black_frames.store(0, std::memory_order_relaxed);
      obs_data_t *src_settings = obs_source_get_settings(source);
      if (src_settings) {
        obs_data_set_int(src_settings, "method", next_m);
        obs_source_update(source, src_settings);
        obs_data_release(src_settings);
      }
      std::fprintf(stderr, "[babagan-capture] Switched capture method to %s (%d)\n",
                   next_m == 1 ? "DXGI" : "WGC", next_m);
    }

    if (elapsed_ms % 1000 == 0) {
      MONITORINFO target_info{};
      target_info.cbSize = sizeof(target_info);
      if (GetMonitorInfoW(target_handle, &target_info)) {
        const int next_width = target_info.rcMonitor.right - target_info.rcMonitor.left;
        const int next_height = target_info.rcMonitor.bottom - target_info.rcMonitor.top;
        if (next_width != base_width || next_height != base_height) {
          if (next_width < 2 || next_height < 2) { resized = true; break; }
          const uint32_t height = static_cast<uint32_t>(std::min(next_height, maximum_height) & ~1);
          const uint32_t width = static_cast<uint32_t>(std::max(2, (next_width * static_cast<int>(height) / next_height) & ~1));
          write_record(2, width, height, 0, nullptr, 0);
          resized = true;
          break;
        }
      } else {
        std::vector<monitor_info> current;
        EnumDisplayMonitors(nullptr, nullptr, list_monitors, reinterpret_cast<LPARAM>(&current));
        if (monitor_index >= current.size()) { resized = true; break; }
      }
    }
  }
  obs_remove_raw_video_callback(on_frame, nullptr);
  if (system_audio) obs_remove_raw_audio_callback(0, on_audio, nullptr);
  obs_set_output_source(0, nullptr);
  if (audio_source) { obs_set_output_source(1, nullptr); obs_source_release(audio_source); }
  obs_source_release(source);
  obs_shutdown();
  return pipe_broken.load() ? 9 : resized ? 20 : 0;
}
