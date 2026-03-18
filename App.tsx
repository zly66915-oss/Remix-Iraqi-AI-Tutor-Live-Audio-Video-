
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { createBlob, decode, decodeAudioData } from './utils/audio-helpers.ts';
import { TranscriptionEntry, TeacherState } from './types.ts';
import AudioVisualizer from './components/AudioVisualizer.tsx';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';
const FRAME_RATE = 1; 
const JPEG_QUALITY = 0.5;

const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64data = (reader.result as string).split(',')[1];
      resolve(base64data);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

export default function App() {
  const [state, setState] = useState<TeacherState>({
    isConnecting: false,
    isActive: false,
    error: null,
  });
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [pdfName, setPdfName] = useState<string | null>(null);
  const [pdfText, setPdfText] = useState<string>("");
  const [isVideoEnabled, setIsVideoEnabled] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [isMirrored, setIsMirrored] = useState(true); // Default mirrored for selfie
  const [isTeacherSpeaking, setIsTeacherSpeaking] = useState(false);

  // Refs
  const audioContextRef = useRef<{ input: AudioContext; output: AudioContext } | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptionRef = useRef({ user: '', teacher: '' });
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameIntervalRef = useRef<number | null>(null);

  // Sync mirroring with camera type initially
  useEffect(() => {
    // If environment (back camera), turn off mirroring so text is readable
    setIsMirrored(facingMode === 'user');
  }, [facingMode]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setPdfName(file.name);
      setPdfText(`هذا الملف اسمه: ${file.name}. الطالب يريد شرح محتوياته.`);
    }
  };

  const stopSession = useCallback(() => {
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch {}
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    if (audioContextRef.current) {
      audioContextRef.current.input.close();
      audioContextRef.current.output.close();
    }
    
    setState({ isConnecting: false, isActive: false, error: null });
    setIsTeacherSpeaking(false);
    sessionRef.current = null;
    audioContextRef.current = null;
    streamRef.current = null;
    nextStartTimeRef.current = 0;
  }, []);

  const startSession = async () => {
    if (!process.env.API_KEY) {
      setState(prev => ({ ...prev, error: "مفتاح API غير متوفر." }));
      return;
    }

    setState(prev => ({ ...prev, isConnecting: true, error: null }));

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      await inputCtx.resume();
      await outputCtx.resume();
      
      audioContextRef.current = { input: inputCtx, output: outputCtx };
      nextStartTimeRef.current = outputCtx.currentTime;

      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: true, 
        video: isVideoEnabled ? { facingMode, width: { ideal: 640 }, height: { ideal: 480 } } : false 
      });
      streamRef.current = stream;

      if (isVideoEnabled && videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      const systemInstruction = `
        أنت "مدرس المادة" العراقي الخصوصي. 
        تحدث باللهجة العراقية الودودة حصراً.
        مهمتك شرح المادة العلمية للطالب بأسلوب مبسط ومرح.
        إذا رأيت صورة مقلوبة أو نصاً معكوساً، اطلب من الطالب تعديله، ولكننا الآن قمنا بتحسين النظام ليرسل لك الصور بشكل صحيح.
        سياق الملف المرفوع: ${pdfText || 'لم يتم رفع ملف بعد'}.
      `;

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setState({ isConnecting: false, isActive: true, error: null });

            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);

            if (isVideoEnabled) {
              frameIntervalRef.current = window.setInterval(() => {
                if (videoRef.current && canvasRef.current) {
                  const video = videoRef.current;
                  const canvas = canvasRef.current;
                  const ctx = canvas.getContext('2d');
                  if (ctx && video.videoWidth > 0) {
                    canvas.width = 320;
                    canvas.height = (320 * video.videoHeight) / video.videoWidth;
                    
                    // APPLY MIRROR TO CANVAS if the user has it enabled
                    // This ensures the AI sees EXACTLY what the user sees (correcting text orientation)
                    ctx.save();
                    if (isMirrored) {
                      ctx.translate(canvas.width, 0);
                      ctx.scale(-1, 1);
                    }
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    ctx.restore();

                    canvas.toBlob(async (blob) => {
                      if (blob) {
                        const base64Data = await blobToBase64(blob);
                        sessionPromise.then(session => session.sendRealtimeInput({
                          media: { data: base64Data, mimeType: 'image/jpeg' }
                        }));
                      }
                    }, 'image/jpeg', JPEG_QUALITY);
                  }
                }
              }, 1000 / FRAME_RATE);
            }
          },
          onmessage: async (message: LiveServerMessage) => {
            const parts = message.serverContent?.modelTurn?.parts || [];
            for (const part of parts) {
              if (part.inlineData?.data && audioContextRef.current) {
                setIsTeacherSpeaking(true);
                const { output: ctx } = audioContextRef.current;
                const audioBuffer = await decodeAudioData(decode(part.inlineData.data), ctx, 24000, 1);
                const source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(ctx.destination);
                
                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
                
                sourcesRef.current.add(source);
                source.onended = () => {
                  sourcesRef.current.delete(source);
                  if (sourcesRef.current.size === 0) setIsTeacherSpeaking(false);
                };
              }
            }

            if (message.serverContent?.inputTranscription) {
              transcriptionRef.current.user += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              transcriptionRef.current.teacher += message.serverContent.outputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              const u = transcriptionRef.current.user.trim();
              const t = transcriptionRef.current.teacher.trim();
              if (u || t) {
                setTranscriptions(prev => [
                  ...prev,
                  ...(u ? [{ role: 'user' as const, text: u }] : []),
                  ...(t ? [{ role: 'teacher' as const, text: t }] : [])
                ]);
              }
              transcriptionRef.current = { user: '', teacher: '' };
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsTeacherSpeaking(false);
            }
          },
          onerror: (e) => {
            console.error('Session Error:', e);
            setState(prev => ({ ...prev, error: "انقطع الاتصال. حاول مرة ثانية." }));
            stopSession();
          },
          onclose: () => stopSession(),
        },
      });

      sessionRef.current = await sessionPromise;

    } catch (err: any) {
      console.error(err);
      setState({ isConnecting: false, isActive: false, error: "فشل في تشغيل الكاميرا أو المايكروفون." });
    }
  };

  const toggleCamera = () => {
    const targetState = !isVideoEnabled;
    setIsVideoEnabled(targetState);
    if (state.isActive) {
      stopSession();
      setTimeout(startSession, 300);
    }
  };

  const switchCamera = () => {
    const nextMode = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(nextMode);
    if (isVideoEnabled && (state.isActive || state.isConnecting)) {
      stopSession();
      setTimeout(startSession, 400);
    }
  };

  const toggleMirror = () => {
    setIsMirrored(!isMirrored);
  };

  return (
    <div className="min-h-screen flex flex-col items-center p-4 md:p-8 max-w-6xl mx-auto font-['Tajawal']" dir="rtl">
      {/* Header */}
      <header className="w-full flex flex-wrap justify-between items-center mb-8 gap-4 bg-white p-4 rounded-2xl shadow-sm border border-slate-100">
        <div className="flex items-center gap-3">
          <div className="bg-emerald-600 p-2 rounded-xl shadow-lg">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-800">الأستاذ العراقي</h1>
            <p className="text-slate-500 text-[10px]">دروس خصوصية ذكية 🇮🇶</p>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <label className="cursor-pointer bg-slate-50 border border-slate-200 px-3 py-2 rounded-xl hover:bg-slate-100 transition-colors flex items-center gap-2 text-sm">
            <span className="max-w-[100px] truncate">{pdfName || "ارفع الملزمة"}</span>
            <input type="file" accept="application/pdf" className="hidden" onChange={handleFileUpload} />
          </label>

          <button 
            onClick={toggleCamera}
            className={`p-2.5 rounded-xl border transition-all ${isVideoEnabled ? 'bg-emerald-100 border-emerald-300 text-emerald-700' : 'bg-white border-slate-200 text-slate-400'}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>

          <button 
            onClick={switchCamera}
            disabled={!isVideoEnabled}
            className={`p-2.5 rounded-xl border transition-all ${!isVideoEnabled ? 'opacity-30' : 'bg-amber-100 border-amber-300 text-amber-700'}`}
            title="تبديل الكاميرا"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>

          <button 
            onClick={toggleMirror}
            disabled={!isVideoEnabled}
            className={`p-2.5 rounded-xl border transition-all flex items-center gap-1 ${!isVideoEnabled ? 'opacity-30' : (isMirrored ? 'bg-indigo-100 border-indigo-400 text-indigo-700' : 'bg-white border-slate-200 text-slate-600')}`}
            title="عكس اتجاه الصورة للقراءة"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
            <span className="text-[10px] font-bold">تعديل القراءة</span>
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="w-full grid grid-cols-1 lg:grid-cols-3 gap-6 h-[calc(100vh-220px)] min-h-[500px]">
        
        {/* Interaction Column */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          <div className="bg-white rounded-[2rem] p-4 shadow-2xl border border-slate-100 relative flex-grow flex flex-col overflow-hidden">
            
            {/* Camera View */}
            <div className="relative flex-grow rounded-2xl overflow-hidden bg-slate-900 border-2 border-slate-100 shadow-inner group transition-all duration-500">
              {isVideoEnabled ? (
                <video 
                  ref={videoRef} 
                  autoPlay 
                  playsInline 
                  muted 
                  className={`w-full h-full object-cover transition-transform duration-300 ${isMirrored ? 'scale-x-[-1]' : 'scale-x-[1]'}`} 
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center text-slate-400 bg-slate-50">
                   <p className="font-bold text-sm">الكاميرا مطفية.. افتحها حتى يشوفك الأستاذ</p>
                </div>
              )}

              {/* Status Badge */}
              {isVideoEnabled && (
                <div className="absolute top-4 right-4 flex flex-col gap-2">
                  <div className="bg-emerald-600/90 text-white text-[10px] px-3 py-1 rounded-full font-bold flex items-center gap-2">
                    <span className="w-2 h-2 bg-white rounded-full animate-pulse"></span>
                    {facingMode === 'user' ? 'كاميرا سيلفي' : 'كاميرا خلفية'}
                  </div>
                </div>
              )}
              
              {/* Visualizer */}
              <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-48 bg-black/30 backdrop-blur-lg rounded-2xl p-2 border border-white/20">
                <AudioVisualizer isActive={state.isActive} isTeacherSpeaking={isTeacherSpeaking} />
              </div>
            </div>

            {/* Controls */}
            <div className="mt-4 flex flex-col items-center gap-2">
              {!state.isActive ? (
                <button
                  onClick={startSession}
                  disabled={state.isConnecting}
                  className="px-10 py-4 bg-emerald-600 text-white rounded-2xl font-bold shadow-lg hover:bg-emerald-700 transition-all active:scale-95 disabled:opacity-50"
                >
                  {state.isConnecting ? "جاري الاتصال..." : "ابدأ الدرس"}
                </button>
              ) : (
                <button
                  onClick={stopSession}
                  className="px-10 py-4 bg-rose-500 text-white rounded-2xl font-bold shadow-lg hover:bg-rose-600 transition-all"
                >
                  إنهاء المكالمة
                </button>
              )}
              {state.error && <p className="text-rose-500 text-xs font-bold">{state.error}</p>}
            </div>
          </div>
        </div>

        {/* History Column */}
        <div className="lg:col-span-1 bg-slate-50 rounded-[2rem] p-5 border border-slate-200 flex flex-col overflow-hidden">
          <h3 className="text-slate-800 font-bold text-sm mb-4">سجل الحوار</h3>
          <div className="flex-grow flex flex-col gap-3 overflow-y-auto pr-2 custom-scrollbar">
            {transcriptions.map((t, idx) => (
              <div key={idx} className={`p-3 rounded-xl text-xs ${t.role === 'user' ? 'bg-emerald-600 text-white self-start' : 'bg-white border border-slate-200 text-slate-800 self-end'}`}>
                {t.text}
              </div>
            ))}
          </div>
        </div>
      </main>

      <canvas ref={canvasRef} className="hidden" />

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }
      `}</style>
    </div>
  );
}
