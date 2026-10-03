import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStatus } from '../client/status-message.mjs';

test('copy confirmation expires while a later persistent error remains visible', () => {
  const timers = [];
  const element = { textContent: '' };
  const status = createStatus(element, callback => { timers.push(callback); return timers.length; }, () => {});
  status('邀请已复制。', 2500);
  assert.equal(element.textContent, '邀请已复制。');
  timers[0]();
  assert.equal(element.textContent, '');
  status('邀请已复制。', 2500);
  status('连接中断，正在自动重连…');
  timers[1]();
  assert.equal(element.textContent, '连接中断，正在自动重连…');
});

test('clicking status element clears text immediately', () => {
  const listeners = {};
  const element = {
    textContent: '点击“播放声音”启用会议音频。',
    addEventListener: (evt, fn) => { listeners[evt] = fn; }
  };
  createStatus(element);
  assert.equal(element.textContent, '点击“播放声音”启用会议音频。');
  listeners.click?.();
  assert.equal(element.textContent, '');
});
