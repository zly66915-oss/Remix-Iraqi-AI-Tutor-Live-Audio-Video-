
import React, { useEffect, useState } from 'react';

interface AudioVisualizerProps {
  isActive: boolean;
  isTeacherSpeaking: boolean;
}

export default function AudioVisualizer({ isActive, isTeacherSpeaking }: AudioVisualizerProps) {
  const [heights, setHeights] = useState<number[]>(new Array(15).fill(20));

  useEffect(() => {
    if (!isActive) {
      setHeights(new Array(15).fill(10));
      return;
    }

    const interval = setInterval(() => {
      setHeights(prev => prev.map(() => {
        // If teacher is speaking, larger random movements, otherwise smaller "listening" pulses
        const base = isTeacherSpeaking ? 40 : 15;
        const variance = isTeacherSpeaking ? 60 : 20;
        return base + Math.random() * variance;
      }));
    }, 100);

    return () => clearInterval(interval);
  }, [isActive, isTeacherSpeaking]);

  return (
    <div className="flex items-center justify-center gap-1.5 h-10 w-full px-2">
      {heights.map((h, i) => (
        <div
          key={i}
          className={`w-1 rounded-full transition-all duration-150 ${
            isActive 
              ? isTeacherSpeaking 
                ? 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]' 
                : 'bg-emerald-400' 
              : 'bg-white/20'
          }`}
          style={{
            height: `${h}%`,
          }}
        />
      ))}
    </div>
  );
}
