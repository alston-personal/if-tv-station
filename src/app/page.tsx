
"use client";

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Tv, Sparkles, Send, Play, Loader2, Scissors, Youtube } from 'lucide-react';

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [step, setStep] = useState(0); // 0: Input, 1: Brainstorming, 2: Script, 3: Video Gen

  const handleStart = () => {
    if (!prompt) return;
    setIsGenerating(true);
    // TODO: Connect to backend
  };

  return (
    <main className="container mx-auto px-6 py-12 min-h-screen flex flex-col items-center">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-4 mb-12"
      >
        <div className="p-3 bg-violet-600 rounded-2xl shadow-[0_0_20px_rgba(139,92,246,0.5)]">
          <Tv className="w-8 h-8 text-white" />
        </div>
        <h1 className="text-4xl font-bold tracking-tight glow-text">如果電視台 <span className="text-violet-400">If TV</span></h1>
      </motion.div>

      {/* Main Container */}
      <div className="w-full max-w-3xl glass-panel p-8 md:p-12 relative overflow-hidden">
        <div className="absolute top-0 right-0 p-4 opacity-10">
          <Sparkles className="w-24 h-24" />
        </div>

        <AnimatePresence mode="wait">
          {!isGenerating ? (
            <motion.div
              key="input"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-8"
            >
              <div className="space-y-4 text-center">
                <h2 className="text-2xl font-semibold">你有什麼大膽的想法？</h2>
                <p className="text-zinc-400">输入一句「如果...怎樣怎樣」，我們為你創造一個完整的平行世界平衡劇集。</p>
              </div>

              <div className="relative">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="如果貓統治了世界，人類變成了寵物..."
                  className="w-full bg-black/40 border border-zinc-800 rounded-2xl p-6 text-lg focus:outline-none focus:border-violet-500 transition-colors min-h-[120px] resize-none"
                />
              </div>

              <button
                onClick={handleStart}
                className="w-full py-4 bg-violet-600 hover:bg-violet-500 rounded-xl font-bold text-lg transition-all flex items-center justify-center gap-2 group shadow-lg shadow-violet-900/20"
              >
                開始創作頻道
                <Send className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </button>
            </motion.div>
          ) : (
            <motion.div
              key="generating"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col items-center py-12 space-y-8"
            >
              <div className="relative">
                <div className="w-32 h-32 border-4 border-violet-500/20 border-t-violet-500 rounded-full animate-spin" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <Sparkles className="w-10 h-10 text-violet-400 animate-pulse" />
                </div>
              </div>

              <div className="text-center space-y-2">
                <h3 className="text-xl font-medium">正在連結平行時空...</h3>
                <p className="text-zinc-500">正在撰寫劇本與發想角色設定</p>
              </div>

              {/* Progress Steps */}
              <div className="w-full max-w-xs space-y-3">
                <StepItem active icon={<Sparkles />} label="世界觀腦力激盪" />
                <StepItem icon={<Scissors />} label="劇本片段切割" />
                <StepItem icon={<Play />} label="AI 影片流水線生產" />
                <StepItem icon={<Youtube />} label="上傳 YouTube" />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Footer Info */}
      <div className="mt-12 text-zinc-500 text-sm">
        Powered by OpenAI GPT-4o & AI Video Generation API
      </div>
    </main>
  );
}

function StepItem({ icon, label, active = false }: { icon: any, label: string, active?: boolean }) {
  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg transition-colors ${active ? 'bg-violet-500/10 text-violet-400 border border-violet-500/20' : 'text-zinc-600'}`}>
      <span className="w-5 h-5">{icon}</span>
      <span className="text-sm font-medium">{label}</span>
      {active && <Loader2 className="w-4 h-4 animate-spin ml-auto" />}
    </div>
  );
}
