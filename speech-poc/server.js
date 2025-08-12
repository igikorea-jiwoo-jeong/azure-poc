import express from 'express';
import dotenv from 'dotenv';
import sdk from 'microsoft-cognitiveservices-speech-sdk';
import { WebSocketServer } from 'ws';
import { PassThrough } from 'stream';

dotenv.config(); // .env 파일의 환경 변수를 process.env에 로드

const app = express();
// public 폴더를 정적 파일 제공 경로로 설정 (프론트엔드 HTML, JS, CSS 제공)
app.use(express.static('public'));

// HTTP 서버 시작
const server = app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});

// WebSocket 서버 생성 (HTTP 서버와 같은 포트 사용)
const wss = new WebSocketServer({ server });

// 클라이언트(WebSocket) 연결 이벤트
wss.on('connection', (ws) => {
  console.log('Client connected for pronunciation assessment');

  // 기본 발음 평가 문장
  let referenceText = 'Hello, how are you today?';
  let pronunciationConfig, recognizer, pushStream;

  // 발음 평가용 Speech Recognizer 시작 함수
  function startRecognizer(text) {
    // 기존 인스턴스가 있으면 정리
    if (recognizer) {
      recognizer.stopContinuousRecognitionAsync(() => {
        recognizer.close();
      });
      pushStream.close();
    }

    // 오디오 데이터를 받을 PushStream 생성
    pushStream = sdk.AudioInputStream.createPushStream();
    const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);

    // Azure Speech 서비스 설정
    const speechConfig = sdk.SpeechConfig.fromSubscription(
      process.env.SPEECH_KEY,
      process.env.SPEECH_REGION
    );
    speechConfig.speechRecognitionLanguage = 'en-US'; // 인식 언어 설정

    // 발음 평가 설정
    pronunciationConfig = new sdk.PronunciationAssessmentConfig(
      text, // 평가할 기준 문장
      sdk.PronunciationAssessmentGradingSystem.HundredMark, // 100점 만점 채점
      sdk.PronunciationAssessmentGranularity.Phoneme, // 음소 단위 평가
      true // 자동 음성 인식과 함께 평가 수행
    );

    // 음성 인식기 생성
    recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    // 발음 평가 설정 적용
    pronunciationConfig.applyTo(recognizer);

    // 실시간 인식(부분 결과) 이벤트
    recognizer.recognizing = (s, e) => {
      ws.send(JSON.stringify({ partial: e.result.text })); // 프론트로 전송
    };

    // 최종 인식 이벤트
    recognizer.recognized = (s, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
        const result = sdk.PronunciationAssessmentResult.fromResult(e.result);
        ws.send(
          JSON.stringify({
            text: e.result.text, // 인식된 문장
            accuracy: result.accuracyScore, // 발음 정확도
            fluency: result.fluencyScore, // 유창성
            completeness: result.completenessScore, // 완성도
          })
        );
      }
    };

    // 연속 인식 시작
    recognizer.startContinuousRecognitionAsync();
  }

  // WebSocket 메시지 수신
  ws.on('message', (msg) => {
    try {
      // 클라이언트에서 설정 변경 요청
      const data = JSON.parse(msg);
      if (data.type === 'setReference') {
        referenceText = data.text || referenceText; // 새로운 평가 문장 설정
        console.log('New reference text:', referenceText);
        startRecognizer(referenceText); // 새 기준 문장으로 재시작
      }
    } catch {
      // JSON 파싱 실패 → 오디오 데이터로 간주
      if (pushStream) {
        pushStream.write(Buffer.from(msg)); // PushStream에 오디오 데이터 추가
      }
    }
  });

  // 초기 기준 문장으로 인식 시작
  startRecognizer(referenceText);

  // 연결 종료 시 리소스 정리
  ws.on('close', () => {
    console.log('Client disconnected');
    if (pushStream) pushStream.close();
    if (recognizer) recognizer.stopContinuousRecognitionAsync();
  });
});
