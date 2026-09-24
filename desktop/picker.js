const $ = id => document.getElementById(id);
let sources = [], kind = 'screen', selected = null, loading = false;
function render() {
  $('sources').replaceChildren();
  $('windows').setAttribute('aria-pressed', String(kind === 'window'));
  $('screens').setAttribute('aria-pressed', String(kind === 'screen'));
  const visible = sources.filter(s => s.kind === kind);
  $('status').textContent = visible.length ? `${visible.length} 个可共享${kind === 'window' ? '窗口' : '屏幕'} · 预览为快照` : (sources.length ? `当前无可用${kind === 'window' ? '窗口' : '屏幕'}，请切换选项卡查看。` : '没有可用内容，请打开窗口后刷新。');
  for (const s of visible) {
    const button = document.createElement('button'); button.className = 'source'; button.setAttribute('aria-pressed', String(selected === s.id)); button.title = s.name;
    const preview = document.createElement('div'); preview.className = 'preview';
    if (s.thumbnail) { const img = document.createElement('img'); img.src = s.thumbnail; img.alt = `${s.name}预览`; preview.append(img); }
    else { const placeholder = document.createElement('span'); placeholder.textContent = '预览不可用'; preview.append(placeholder); }
    const caption = document.createElement('div'); caption.className = 'caption';
    if (s.icon) { const icon = document.createElement('img'); icon.src = s.icon; icon.alt = ''; caption.append(icon); }
    const name = document.createElement('span'); name.textContent = s.name; caption.append(name); button.append(preview, caption);
    button.onclick = () => { selected = s.id; render(); };
    button.ondblclick = () => {
      selected = s.id;
      window.sourcePicker.select({ id: selected, audio: $('audio').checked });
    };
    $('sources').append(button);
  }
  $('confirm').disabled = !visible.some(s => s.id === selected);
}
async function refresh() {
  if (loading) return; loading = true; $('refresh').disabled = true; $('confirm').disabled = true; $('status').textContent = '正在获取预览…';
  try {
    const result = await window.sourcePicker.list();
    sources = result.sources;
    $('audio').disabled = !result.audioAllowed;
    $('audio').checked = result.audioAllowed;
    if (!result.audioAllowed) $('audio-note').textContent = '如需系统声音，请先取消并在会议界面勾选“共享系统声音”。';
    const screens = sources.filter(s => s.kind === 'screen');
    const windows = sources.filter(s => s.kind === 'window');
    $('windows').style.display = windows.length ? '' : 'none';
    $('screens').style.display = screens.length ? '' : 'none';
    if (windows.length === 0 && screens.length > 0) {
      kind = 'screen';
      if (screens.length === 1) selected = screens[0].id;
    } else if (screens.length === 0 && windows.length > 0) {
      kind = 'window';
    } else if (kind === 'screen' && screens.length === 1 && !selected) {
      selected = screens[0].id;
    }
    render();
  }
  catch { $('status').textContent = '无法获取预览，请刷新重试。'; }
  finally { loading = false; $('refresh').disabled = false; }
}
$('windows').onclick = () => { kind = 'window'; selected = null; render(); };
$('screens').onclick = () => { kind = 'screen'; selected = null; render(); };
$('refresh').onclick = refresh;
$('cancel').onclick = () => window.sourcePicker.select(null);
$('confirm').onclick = () => { if (selected && !loading) window.sourcePicker.select({ id: selected, audio: $('audio').checked }); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') window.sourcePicker.select(null); });
refresh();
