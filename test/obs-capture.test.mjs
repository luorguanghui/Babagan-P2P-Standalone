import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureObsVirtualCamera, findObsVirtualCamera } from '../client/obs-capture.mjs';

test('finds only the OBS virtual camera among video inputs', () => {
  const devices = [
    { kind: 'videoinput', label: 'Integrated Camera', deviceId: 'physical' },
    { kind: 'audioinput', label: 'OBS Virtual Camera', deviceId: 'wrong-kind' },
    { kind: 'videoinput', label: 'OBS Virtual Camera', deviceId: 'obs-device' }
  ];
  assert.equal(findObsVirtualCamera(devices)?.deviceId, 'obs-device');
  assert.equal(findObsVirtualCamera(devices.slice(0, 2)), undefined);
});

test('captures OBS by exact device ID at the requested target frame rate', async () => {
  const requested = [];
  const stream = { getVideoTracks: () => [{ readyState: 'live' }] };
  const mediaDevices = {
    enumerateDevices: async () => [{ kind: 'videoinput', label: 'OBS Virtual Camera', deviceId: 'obs-device' }],
    getUserMedia: async constraints => { requested.push(constraints); return stream; }
  };
  assert.equal(await captureObsVirtualCamera(mediaDevices, 60), stream);
  assert.deepEqual(requested, [{ video: { deviceId: { exact: 'obs-device' }, frameRate: { ideal: 60 } }, audio: false }]);
});

test('missing or blocked OBS camera gives a visible actionable error', async () => {
  const missing = { enumerateDevices: async () => [{ kind: 'videoinput', label: 'Integrated Camera', deviceId: 'webcam' }], getUserMedia: async () => { throw new Error('must not open another camera'); } };
  await assert.rejects(captureObsVirtualCamera(missing, 60), /启动虚拟摄像头/);
  const blocked = { enumerateDevices: async () => [{ kind: 'videoinput', label: 'OBS Virtual Camera', deviceId: 'obs' }], getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } };
  await assert.rejects(captureObsVirtualCamera(blocked, 60), /OBS 虚拟摄像头访问失败/);
});
