// public/app.js
const refEl = document.getElementById('ref');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const partialEl = document.getElementById('partial');
const resultEl = document.getElementById('result');
const logEl = document.getElementById('log');

let audioCtx, processor, sourceNode, ws;
let started = false;

function log(...args) {
  console.log(...args);
  logEl.innerText +=
    args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ') +
    '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

// float32 -> 16bit PCM LE
function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, s, true);
  }
  return buffer;
}

// downsample float32 from sampleRate -> 16000
function downsampleBuffer(buffer, sampleRate, outSampleRate = 16000) {
  if (outSampleRate === sampleRate) {
    return buffer;
  }
  const sampleRateRatio = sampleRate / outSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    // average between offsets
    let accum = 0,
      count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = count ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function connectWebSocket() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    log('WS open');
    startBtn.disabled = true;
    stopBtn.disabled = false;
  };
  ws.onclose = () => {
    log('WS closed');
    startBtn.disabled = false;
    stopBtn.disabled = true;
  };
  ws.onerror = (e) => log('WS error', e);
  ws.onmessage = (ev) => {
    try {
      const d = JSON.parse(ev.data);
      if (d.type === 'info' && d.reference) {
        refEl.innerText = d.reference;
      } else if (d.type === 'partial') {
        partialEl.innerText = d.text;
      } else if (d.type === 'final') {
        resultEl.innerText = `Text: ${d.text}\nAccuracy: ${d.accuracy}\nFluency: ${d.fluency}\nCompleteness: ${d.completeness}`;
      } else if (d.type === 'error') {
        log('Server error:', d);
      }
    } catch (err) {
      log('WS message parse error', err);
    }
  };
}

async function startCapture() {
  if (started) return;
  started = true;
  connectWebSocket();

  // wait for ws open or timeout
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      log('WS open timeout (3s) — proceed anyway');
      resolve();
    }, 3000);
    ws.onopen = () => {
      clearTimeout(t);
      log('WS open');
      resolve();
    };
    ws.onerror = (e) => {
      clearTimeout(t);
      log('WS onerror during open', e);
      resolve();
    };
  });

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    log('getUserMedia error:', err);
    started = false;
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const sampleRate = audioCtx.sampleRate;
  log('AudioContext sampleRate:', sampleRate);

  sourceNode = audioCtx.createMediaStreamSource(stream);

  // ScriptProcessorNode -> deprecated but widely supported
  const bufferSize = 4096; // 낮을수록 레이턴시 줄지만 CPU ↑
  processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);

  processor.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const inputData = e.inputBuffer.getChannelData(0);
    // downsample to 16k
    const down = downsampleBuffer(inputData, sampleRate, 16000);
    const pcm16 = floatTo16BitPCM(down);
    try {
      ws.send(pcm16);
    } catch (err) {
      log('ws.send error', err);
    }
  };

  sourceNode.connect(processor);
  // Chrome requires connecting processor to destination or audio might be dropped
  processor.connect(audioCtx.destination);

  log('Started capture');
}

function stopCapture() {
  if (!started) return;
  started = false;

  try {
    if (processor) {
      processor.disconnect();
      processor.onaudioprocess = null;
      processor = null;
    }
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
    }
  } catch (err) {
    log('stop capture cleanup error', err);
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.close();
    } catch (err) {
      log('ws close err', err);
    }
  }

  log('Stopped');
}

startBtn.onclick = () => startCapture();
stopBtn.onclick = () => stopCapture();

// 자동으로 참고 문장 불러오기 (서버에서 info로 보낼 것)
connectWebSocket();
