// ----- UI 요소 참조 -----
const refEl = document.getElementById('ref'); // 서버에서 내려준 참고 문장 표시
const startBtn = document.getElementById('start'); // 녹음 시작 버튼
const stopBtn = document.getElementById('stop'); // 녹음 종료 버튼
const partialEl = document.getElementById('partial'); // 실시간 인식 중간 결과 표시
const resultEl = document.getElementById('result'); // 최종 발음 평가 결과 표시
const logEl = document.getElementById('log'); // 로그 출력 영역

// ----- 오디오 / 연결 관련 상태 -----
let audioCtx, processor, sourceNode, ws;
let started = false; // 녹음이 시작되었는지 여부

// ----- 로그 함수 -----
function log(...args) {
  console.log(...args);
  // 화면 로그창에도 출력
  logEl.innerText +=
    args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ') +
    '\n';
  logEl.scrollTop = logEl.scrollHeight; // 항상 최신 로그가 보이도록 스크롤
}

// ----- Float32 → 16bit PCM 변환 -----
// Web Audio API가 제공하는 오디오 버퍼(float32)를
// Azure Speech SDK가 받는 16비트 PCM 형식으로 변환
function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32Array[i])); // -1~1 범위로 클리핑
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, s, true); // 리틀 엔디안
  }
  return buffer;
}

// ----- 다운샘플링 함수 -----
// 기본 마이크 샘플레이트를 16kHz로 변환
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
    // 구간 평균값을 구해 다운샘플링
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

// ----- WebSocket 연결 -----
function connectWebSocket() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.binaryType = 'arraybuffer'; // PCM 데이터를 ArrayBuffer로 송신

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

  // 서버에서 오는 메시지 처리
  ws.onmessage = (ev) => {
    try {
      const d = JSON.parse(ev.data);
      if (d.type === 'info' && d.reference) {
        refEl.innerText = d.reference; // 서버가 제공하는 참고 문장
      } else if (d.type === 'partial') {
        partialEl.innerText = d.text; // 인식 중간 결과
      } else if (d.type === 'final') {
        // 최종 발음 평가 결과
        resultEl.innerText = `Text: ${d.text}\nAccuracy: ${d.accuracy}\nFluency: ${d.fluency}\nCompleteness: ${d.completeness}`;
      } else if (d.type === 'error') {
        log('Server error:', d);
      }
    } catch (err) {
      log('WS message parse error', err);
    }
  };
}

// ----- 녹음 시작 -----
async function startCapture() {
  if (started) return; // 이미 녹음 중이면 무시
  started = true;

  connectWebSocket();

  // WS가 열릴 때까지 최대 3초 대기
  await new Promise((resolve) => {
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

  // 마이크 스트림 요청
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    log('getUserMedia error:', err);
    started = false;
    return;
  }

  // 오디오 컨텍스트 생성
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const sampleRate = audioCtx.sampleRate;
  log('AudioContext sampleRate:', sampleRate);

  // 마이크 입력 소스 생성
  sourceNode = audioCtx.createMediaStreamSource(stream);

  // ScriptProcessorNode 생성 (deprecated이지만 호환성 좋음)
  const bufferSize = 4096; // 버퍼 크기 (작을수록 지연 ↓, CPU 부하 ↑)
  processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);

  // 오디오 처리 이벤트
  processor.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const inputData = e.inputBuffer.getChannelData(0); // Float32 데이터
    const down = downsampleBuffer(inputData, sampleRate, 16000); // 16kHz 변환
    const pcm16 = floatTo16BitPCM(down); // PCM16 변환
    try {
      ws.send(pcm16); // 서버로 전송
    } catch (err) {
      log('ws.send error', err);
    }
  };

  // 오디오 노드 연결
  sourceNode.connect(processor);
  processor.connect(audioCtx.destination); // 크롬은 destination 연결 필요

  log('Started capture');
}

// ----- 녹음 종료 -----
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

  // WebSocket 닫기
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.close();
    } catch (err) {
      log('ws close err', err);
    }
  }

  log('Stopped');
}

// ----- 버튼 이벤트 -----
startBtn.onclick = () => startCapture();
stopBtn.onclick = () => stopCapture();

// 페이지 로드 시 서버에 접속해서 참고 문장 받기
connectWebSocket();
