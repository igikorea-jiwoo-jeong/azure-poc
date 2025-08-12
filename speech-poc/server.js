import express from 'express';
import dotenv from 'dotenv';
import sdk from 'microsoft-cognitiveservices-speech-sdk';
import { WebSocketServer } from 'ws';
import { PassThrough } from 'stream';

dotenv.config();

const app = express();
app.use(express.static('public'));

const server = app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Client connected for pronunciation assessment');

  let referenceText = 'Hello, how are you today?'; // 기본 문장
  let pronunciationConfig, recognizer, pushStream;

  function startRecognizer(text) {
    if (recognizer) {
      recognizer.stopContinuousRecognitionAsync(() => {
        recognizer.close();
      });
      pushStream.close();
    }

    pushStream = sdk.AudioInputStream.createPushStream();
    const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);

    const speechConfig = sdk.SpeechConfig.fromSubscription(
      process.env.SPEECH_KEY,
      process.env.SPEECH_REGION
    );
    speechConfig.speechRecognitionLanguage = 'en-US';

    pronunciationConfig = new sdk.PronunciationAssessmentConfig(
      text,
      sdk.PronunciationAssessmentGradingSystem.HundredMark,
      sdk.PronunciationAssessmentGranularity.Phoneme,
      true
    );

    recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    pronunciationConfig.applyTo(recognizer);

    recognizer.recognizing = (s, e) => {
      ws.send(JSON.stringify({ partial: e.result.text }));
    };

    recognizer.recognized = (s, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
        const result = sdk.PronunciationAssessmentResult.fromResult(e.result);
        ws.send(
          JSON.stringify({
            text: e.result.text,
            accuracy: result.accuracyScore,
            fluency: result.fluencyScore,
            completeness: result.completenessScore,
          })
        );
      }
    };

    recognizer.startContinuousRecognitionAsync();
  }

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'setReference') {
        referenceText = data.text || referenceText;
        console.log('New reference text:', referenceText);
        startRecognizer(referenceText);
      }
    } catch {
      if (pushStream) {
        pushStream.write(Buffer.from(msg));
      }
    }
  });

  startRecognizer(referenceText);

  ws.on('close', () => {
    console.log('Client disconnected');
    if (pushStream) pushStream.close();
    if (recognizer) recognizer.stopContinuousRecognitionAsync();
  });
});
