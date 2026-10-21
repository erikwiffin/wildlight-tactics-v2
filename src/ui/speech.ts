// Microphone dictation for text fields, using the browser's built-in speech
// recognition (Web Speech API). Hidden where the browser doesn't support it.
// Note: some browsers (e.g. Chrome) send the audio to their vendor's servers
// for recognition, and it only works on https or localhost.

import { el } from './dom';

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const speechSupported = (): boolean => recognitionCtor() !== null && window.isSecureContext;

const ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone access was blocked. Allow it in the browser’s site settings.',
  'service-not-allowed': 'Speech recognition is turned off in this browser.',
  'no-speech': 'Didn’t hear anything. Tap the mic and try again.',
  'audio-capture': 'No microphone found.',
  network: 'Speech recognition needs a network connection.',
};

let active: Recognition | null = null;

/**
 * A mic button that dictates into `field`. Speech is appended to what's
 * already typed; interim words show live and are replaced by the final text.
 * Returns null when the browser has no speech recognition.
 */
export function micButton(field: HTMLInputElement | HTMLTextAreaElement, onChange?: () => void, onError?: (msg: string) => void): HTMLButtonElement | null {
  const Ctor = recognitionCtor();
  if (!Ctor || !window.isSecureContext) return null;
  const btn = el('button', 'mic-btn', '🎤');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Dictate');
  btn.title = 'Dictate';
  btn.setAttribute('aria-pressed', 'false');
  let rec: Recognition | null = null;

  const stop = () => {
    rec?.stop();
  };
  btn.onclick = () => {
    if (rec) return stop();
    active?.stop(); // one mic at a time
    const base = field.value.trim();
    rec = new Ctor();
    active = rec;
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    btn.setAttribute('aria-pressed', 'true');
    btn.classList.add('listening');
    rec.onresult = (e) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      field.value = [base, text.trim()].filter(Boolean).join(' ');
      onChange?.();
    };
    rec.onerror = (e) => {
      if (e.error !== 'aborted') onError?.(ERRORS[e.error] ?? `Speech recognition failed (${e.error}).`);
    };
    rec.onend = () => {
      btn.setAttribute('aria-pressed', 'false');
      btn.classList.remove('listening');
      if (active === rec) active = null;
      rec = null;
      onChange?.();
    };
    try {
      rec.start();
    } catch {
      rec.onend?.();
    }
  };
  return btn;
}
