import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoOptions, baseBitrate, minBitrate, newBudget, adaptBudget, resolutionScale, evenResolutionScale, rate, videoSample, selectedCandidatePair, qualityLimits, equalEstimatedBandwidthShare } from '../client/video-quality.mjs';

test('a stale low bandwidth estimate cannot trap the sender ceiling in a recovery loop', () => {
  const options = videoOptions({ height: 1080, fps: 60 });
  let budget = newBudget(options);
  for (let index = 0; index < 30; index++) {
    budget = adaptBudget(budget, { fps: 60, sourceFps: 60, available: 1_200_000,
      outgoing: 900_000, loss: 0, rtt: 0.025, encodeMs: 2, limitation: 'bandwidth' }, options);
    assert.equal(budget.bitrate, 15_000_000, 'GCC must retain room to probe beyond its stale estimate');
    assert.equal(budget.scale, 1);
  }
});

test('network and encoder pressure leave selected resolution to maintain-resolution', () => {
  const options = videoOptions({ height: 1080, fps: 60 });
  let budget = newBudget(options);
  for (let index = 0; index < 30; index++) {
    budget = adaptBudget(budget, { fps: 25, sourceFps: 60, loss: 0.08, rtt: 0.45,
      encodeMs: 22, limitation: 'cpu' }, options);
    assert.equal(budget.scale, 1, 'application must not fight browser adaptation by resizing');
  }
});

test('each quality tier keeps selected resolution and a per-viewer bitrate ceiling', () => {
  assert.deepEqual(qualityLimits({ height: 720 }), { maxHeight: 720, maxBitrate: 10_000_000 });
  assert.deepEqual(qualityLimits({ height: 1080 }), { maxHeight: 1080, maxBitrate: 15_000_000 });
  assert.deepEqual(qualityLimits({ height: 1440 }), { maxHeight: 1440, maxBitrate: 20_000_000 });
  assert.deepEqual(qualityLimits({ height: 2160 }), { maxHeight: 2160, maxBitrate: 30_000_000 });
  assert.deepEqual(qualityLimits({ height: 1440, sourceMode: true }), { maxHeight: 1440, maxBitrate: 20_000_000 });
});

test('estimated available bandwidth is divided evenly as a soft probe target', () => {
  assert.equal(equalEstimatedBandwidthShare([12_000_000, 18_000_000]), 15_000_000);
  assert.equal(equalEstimatedBandwidthShare([12_000_000, null]), null);
  const options = videoOptions({ height: 1080, fps: 60 });
  let budget = newBudget(options);
  const sample = { fps: 60, sourceFps: 60, available: 18_000_000, fairShare: 15_000_000,
    loss: 0, rtt: 0.03, encodeMs: 2, limitation: 'none' };
  for (let index = 0; index < 30; index++) budget = adaptBudget(budget, sample, options);
  assert.equal(budget.bitrate, 15_000_000);
  assert.ok(budget.scale <= 1440 / 1080);
});
test('defaults and aspect ratios do not stretch or upscale source', () => {
  assert.deepEqual(videoOptions(), { height:'source', fps:30, adaptive:true });
  for (const [w,h] of [[1920,1080],[1600,1200],[3440,1440],[900,1600]]) {
    const scale = resolutionScale(w,h,1080);
    assert.equal((w/scale)/(h/scale), w/h); assert.ok(scale >= 1);
  }
  assert.equal(resolutionScale(640,480,2160),1);
});

test('sender scaling keeps output dimensions even across common and adaptive sizes', () => {
  for (const [width, height, target] of [
    [2560, 1440, 1080],
    [1366, 768, 720],
    [2560, 1440, 1080 * 0.91],
    [1921, 1080, 1080],
    [3440, 1440, 1080],
    [900, 1600, 720]
  ]) {
    const scale = evenResolutionScale(width, height, target);
    const output = [Math.round(width / scale), Math.round(height / scale)];
    assert.ok(output.every(dimension => dimension % 2 === 0), `${width}×${height} at ${target} produced ${output}`);
    assert.ok(output[1] <= target, `${output[1]} exceeds ${target}`);
    assert.ok(scale >= 1);
  }
  assert.equal(evenResolutionScale(2560, 1440, 1080), 4 / 3);
});
test('browser congestion feedback never lowers the application ceiling or grows resolution', () => {
  const options = videoOptions({height:1080,fps:60}); let budget = newBudget(options);
  for (const sample of [{fps:60,loss:0,rtt:.05,available:40e6}, {fps:30,loss:.1,rtt:.5,limitation:'bandwidth'}, {limitation:'cpu'}]) {
    budget = adaptBudget(budget,sample,options);
    assert.equal(budget.bitrate,15e6); assert.equal(budget.scale,1);
  }
});

test('missing stats and static content never trigger resolution boost', () => {
  const o=videoOptions(); let b=newBudget(o);
  for(let i=0;i<30;i++) b=adaptBudget(b,{fps:0,available:50e6,loss:null,rtt:null},o);
  assert.equal(b.bitrate,15e6); assert.equal(b.scale,1);
  assert.equal(rate({timestamp:2000,bytesSent:100},{timestamp:1000,bytesSent:200},'bytesSent'),null);
});

test('fixed quality preserves resolution when active capture encodes fewer frames', () => {
  const options = videoOptions({height:1080,fps:60,adaptive:false}); let budget = newBudget(options);
  for(let i=0;i<10;i++) budget=adaptBudget(budget,{sourceFps:60,fps:30,limitation:'cpu',encodeMs:20},options);
  assert.equal(budget.scale,1); assert.equal(budget.bitrate,baseBitrate(options));
});

test('low fps from an unchanged screen does not trigger downscaling', () => {
  const options = videoOptions({ height: 1080, fps: 60, adaptive: false });
  let budget = newBudget(options);
  for (let i = 0; i < 5; i++) budget = adaptBudget(budget, { sourceFps: 30, fps: 30, available: 14_000_000, loss: 0, rtt: 0.02, limitation: 'none', encodeMs: 2 }, options);
  assert.equal(budget.scale, 1);
});

test('a previously collapsed sender cap is reopened independently of the current estimate', () => {
  const options=videoOptions({height:1080});
  const budget=adaptBudget({bitrate:500_000,scale:1},{fps:29.3,available:1_300_000,limitation:'bandwidth'},options);
  assert.equal(budget.bitrate,15_000_000); assert.equal(budget.scale,1);
});

test('clean network with available tracking actual send rate does not death-spiral and probes upward', () => {
  const options = videoOptions({ height: 1080, fps: 60 });
  let budget = newBudget(options);
  assert.equal(budget.bitrate, 15_000_000);
  for (let i = 0; i < 9; i++) {
    budget = adaptBudget(budget, { fps: 60, loss: 0, rtt: 0.02, available: budget.bitrate * 1.05, encodeMs: 3 }, options);
  }
  assert.ok(budget.bitrate > 10_000_000, `bitrate should probe past 10 Mbps on clean network, got ${budget.bitrate}`);
  assert.equal(budget.scale, 1);
});

test('transient packet loss cannot trigger application resolution switching', () => {
  const options=videoOptions({height:1080,fps:60}); let budget=newBudget(options);
  for(const loss of [.08,0,.08,0]) {
    budget=adaptBudget(budget,{fps:60,loss,rtt:.1,available:6e6},options);
    assert.equal(budget.scale,1);
  }
});

test('telemetry reports measured RTP bitrate and frame deltas', () => {
  const before = new Map([['v',{id:'v',type:'outbound-rtp',kind:'video',timestamp:1000,bytesSent:1000,framesEncoded:30,packetsSent:100,totalEncodeTime:.1}],['r',{id:'r',timestamp:1000,packetsLost:0}]]);
  const after = new Map([['v',{id:'v',type:'outbound-rtp',kind:'video',timestamp:2000,bytesSent:501000,framesEncoded:90,packetsSent:200,totalEncodeTime:.22,remoteId:'r'}],['r',{id:'r',timestamp:2000,packetsLost:1}],['p',{id:'p',type:'candidate-pair',nominated:true,state:'succeeded',availableOutgoingBitrate:8e6,currentRoundTripTime:.05}]]);
  const result=videoSample(after,before);
  assert.equal(result.outgoing,4e6); assert.equal(result.fps,60); assert.equal(result.loss,.01); assert.equal(result.encodeMs,2); assert.equal(result.available,8e6);
});

test('telemetry separates captured, received and decoded frame rates', () => {
  const before = new Map([
    ['source', { id: 'source', type: 'media-source', kind: 'video', timestamp: 1000, frames: 100 }],
    ['out', { id: 'out', type: 'outbound-rtp', kind: 'video', mediaSourceId: 'source', timestamp: 1000, framesEncoded: 80 }],
    ['in', { id: 'in', type: 'inbound-rtp', kind: 'video', timestamp: 1000, framesReceived: 70, framesDecoded: 50, framesDropped: 10 }]
  ]);
  const after = new Map([
    ['source', { id: 'source', type: 'media-source', kind: 'video', timestamp: 2000, frames: 160 }],
    ['out', { id: 'out', type: 'outbound-rtp', kind: 'video', mediaSourceId: 'source', codecId: 'codec', encoderImplementation: 'MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)', powerEfficientEncoder: true, timestamp: 2000, framesEncoded: 110 }],
    ['codec', { id: 'codec', type: 'codec', mimeType: 'video/H264' }],
    ['in', { id: 'in', type: 'inbound-rtp', kind: 'video', timestamp: 2000, framesReceived: 130, framesDecoded: 73, framesDropped: 37 }]
  ]);
  const sample = videoSample(after, before);
  assert.equal(sample.sourceFps, 60);
  assert.equal(sample.fps, 30);
  assert.equal(sample.inReceivedFps, 60);
  assert.equal(sample.inFps, 23);
  assert.equal(sample.inDroppedFps, 27);
  assert.equal(sample.outCodec, 'video/H264');
  assert.equal(sample.powerEfficientEncoder, true);
  assert.match(sample.encoderImplementation, /NVIDIA H\.264/);
});

test('ambiguous succeeded pairs do not claim a stale nominated route', () => {
  const reports = new Map([
    ['old', { id: 'old', type: 'candidate-pair', state: 'succeeded', nominated: true }],
    ['new', { id: 'new', type: 'candidate-pair', state: 'succeeded' }]
  ]);
  assert.equal(selectedCandidatePair(reports), null);
});

test('suspended state preserves budget and avoids degradation during background throttle', () => {
  const options = videoOptions({ height: 1080, fps: 60 });
  const initial = { bitrate: 6_000_000, good: 0, scale: 1, framePressure: 0, reason: '基准画质' };
  const backgroundSample = { fps: 0, sourceFps: 0, available: 1_000_000, encodeMs: 50, limitation: 'cpu', suspended: true };
  const budget = adaptBudget(initial, backgroundSample, options);
  assert.equal(budget.scale, 1, 'scale must not drop during background suspension');
  assert.equal(budget.bitrate, 6_000_000, 'bitrate must not collapse during background suspension');
});

test('a legacy reduced resolution is reset to the selected size rather than repeatedly probing', () => {
  const options=videoOptions({height:1080,fps:60});
  const budget=adaptBudget({bitrate:4e6,scale:.8},{fps:60,loss:0,rtt:.02,available:8e6},options);
  assert.equal(budget.scale,1); assert.equal(budget.bitrate,15e6);
});

test('minBitrate provides appropriate floors across resolutions and framerates', () => {
  assert.ok(minBitrate({ height: 720, fps: 30 }) >= 1_000_000);
  assert.ok(minBitrate({ height: 1080, fps: 30 }) >= 1_500_000);
  assert.ok(minBitrate({ height: 1080, fps: 60 }) >= 2_500_000);
  assert.ok(minBitrate({ height: 1440, fps: 60 }) >= 4_000_000);
  assert.ok(minBitrate({ height: 2160, fps: 60 }) >= 6_000_000);
});

test('idle screen with low outgoing traffic does not trigger false congestion or collapse bitrate', () => {
  const options = videoOptions({ height: 1080, fps: 60 });
  let budget = newBudget(options);
  assert.equal(budget.bitrate, 15_000_000);

  // Simulate an idle static desktop where outgoing traffic is only 300k,
  // GCC bandwidth estimate drops to 1.2M, but loss is 0 and RTT is low.
  for (let i = 0; i < 5; i++) {
    budget = adaptBudget(budget, {
      fps: 60, sourceFps: 60, available: 1_200_000, outgoing: 300_000,
      loss: 0, rtt: 0.015, encodeMs: 2, limitation: 'none'
    }, options);
  }

  // Bitrate must not collapse to 500k; it should stay at base budget
  assert.equal(budget.bitrate, 15_000_000);
  assert.equal(budget.scale, 1);
});

test('extended fps tiers 45 and 50 are accepted and scale bitrate floors properly', () => {
  assert.equal(videoOptions({ fps: 45 }).fps, 45);
  assert.equal(videoOptions({ fps: 50 }).fps, 50);
  assert.equal(videoOptions({ fps: 999 }).fps, 30);

  const floor30 = minBitrate({ height: 1080, fps: 30 });
  const floor45 = minBitrate({ height: 1080, fps: 45 });
  const floor50 = minBitrate({ height: 1080, fps: 50 });
  const floor60 = minBitrate({ height: 1080, fps: 60 });

  assert.ok(floor45 > floor30);
  assert.ok(floor50 > floor45);
  assert.ok(floor60 > floor50);
});
