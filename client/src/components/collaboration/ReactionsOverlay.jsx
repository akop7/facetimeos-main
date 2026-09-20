'use client';

import React from 'react';

export default function ReactionsOverlay({ reactions = [] }) {
  if (reactions.length === 0) return null;

  return (
    <div className="fixed inset-0 pointer-events-none z-40 overflow-hidden">
      {reactions.map((react) => (
        <div
          key={react.id}
          className="absolute bottom-20 flex flex-col items-center animate-float-up pointer-events-none"
          style={{ left: `${react.leftPercent}%` }}
        >
          <span className="text-4xl drop-shadow-lg transform transition-transform hover:scale-125">
            {react.emoji}
          </span>
          <span className="text-[10px] font-semibold bg-stone-800/70 dark:bg-black/60 backdrop-blur-sm text-white px-2 py-0.5 rounded-full mt-1 border border-stone-600 dark:border-white/10 shadow">
            {react.senderName}
          </span>
        </div>
      ))}
      <style jsx>{`
        @keyframes floatUp {
          0% {
            opacity: 1;
            transform: translateY(0) scale(0.6);
          }
          50% {
            opacity: 1;
            transform: translateY(-200px) scale(1.2);
          }
          100% {
            opacity: 0;
            transform: translateY(-450px) scale(0.9);
          }
        }
        .animate-float-up {
          animation: floatUp 3s cubic-bezier(0.25, 1, 0.5, 1) forwards;
        }
      `}</style>
    </div>
  );
}