"use client";

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Tv, Sparkles, Send, Play, Loader2, Scissors, 
  Youtube, CheckCircle2, AlertCircle, ExternalLink, RefreshCw, 
  Film, Globe, FileText, ChevronRight, User, Flame
} from 'lucide-react';
import confetti from 'canvas-confetti';

interface Segment {
  id: number;
  visualPrompt: string;
  audioScript: string;
  foreshadowing?: string;
  payoff?: string;
  videoUrl?: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  error?: string;
  duration?: number;
}

interface Job {
  id: string;
  status: 'pending' | 'brainstorming' | 'review_ready' | 'generating' | 'stitching' | 'completed' | 'failed' | 'quality_failed' | 'uploading' | 'published' | 'preview_ready';
  prompt: string;
  worldInfo?: {
    worldName: string;
    worldDescription: any;
    visualStyle: any;
    mainCharacterDescription: any;
  };
  segments?: Segment[];
  finalVideoUrl?: string;
  error?: string;
  youtubeUrl?: string;
  youtubeId?: string;
  previewOnly?: boolean;
  segmentCount?: number;
  qualityChecks?: Record<string, { passed: boolean; details: string }>;
  progress: number;
  createdAt: string;
  updatedAt: string;
}

function getStatusLabel(status: Job['status']) {
  switch (status) {
    case 'brainstorming':
      return '🧠 宇宙觀腦力激盪...';
    case 'review_ready':
      return '✅ 品質已通過，準備上傳...';
    case 'generating':
      return '🎬 AI 影片片段生成中...';
    case 'stitching':
      return '✂️ FFmpeg 無損拼接...';
    case 'uploading':
      return '🚀 YouTube 上傳與翻譯...';
    case 'published':
      return '🎉 成功上傳 YouTube！';
    case 'preview_ready':
      return '🎞️ 預覽版已完成，可直接播放';
    case 'failed':
      return '❌ 流程遭遇異常';
    case 'quality_failed':
      return '🛑 技術品質未達標，已攔截發布';
    default:
      return '⏳ 排程中...';
  }
}

function getDisplayProgress(job: Job) {
  const floorByStatus: Partial<Record<Job['status'], number>> = {
    pending: 0,
    brainstorming: 5,
    review_ready: 80,
    generating: 25,
    stitching: 70,
    uploading: 85,
    published: 100,
    preview_ready: 100,
    failed: Math.max(5, job.progress || 0),
    quality_failed: Math.max(80, job.progress || 0)
  };
  const floor = floorByStatus[job.status] ?? 0;
  return Math.max(job.progress || 0, floor);
}

function shouldRestoreJob(job: Job) {
  return ['pending', 'brainstorming', 'review_ready', 'generating', 'stitching', 'uploading'].includes(job.status);
}

function formatAssetUrl(url?: string): string {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/iftv/')) return url;
  if (url.startsWith('/')) return `/iftv${url}`;
  return `/iftv/${url}`;
}

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [productPlacement, setProductPlacement] = useState("");
  const [intros, setIntros] = useState<any[]>([]);
  const [selectedIntroUrl, setSelectedIntroUrl] = useState("");
  const [productPlacementImg, setProductPlacementImg] = useState("");
  const [isUploadingIntro, setIsUploadingIntro] = useState(false);
  const [isUploadingImg, setIsUploadingImg] = useState(false);
  const [previewOnly, setPreviewOnly] = useState(true);

  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [channels, setChannels] = useState<any[]>([]);
  const [selectedChannel, setSelectedChannel] = useState("default");

  const handleIntroUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploadingIntro(true);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('filename', file.name);

    try {
      const res = await fetch('/iftv/api/upload', {
        method: 'POST',
        body: formData
      });
      if (!res.ok) throw new Error('上傳片頭失敗');
      const data = await res.json();
      
      const listRes = await fetch('/iftv/api/intros');
      if (listRes.ok) {
        const listData = await listRes.json();
        setIntros(listData.intros || []);
      }
      
      setSelectedIntroUrl(data.url);
    } catch (err: any) {
      alert(err.message || '上傳失敗');
    } finally {
      setIsUploadingIntro(false);
    }
  };

  const handleImgUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploadingImg(true);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('filename', file.name);

    try {
      const res = await fetch('/iftv/api/upload', {
        method: 'POST',
        body: formData
      });
      if (!res.ok) throw new Error('上傳圖片失敗');
      const data = await res.json();
      setProductPlacementImg(data.path);
    } catch (err: any) {
      alert(err.message || '上傳失敗');
    } finally {
      setIsUploadingImg(false);
    }
  };
  // pollKey：每次 handleResume 後遞增，強制 polling useEffect 重新啟動
  const [pollKey, setPollKey] = useState(0);
  
  // 平行世界 / 角色歷史庫狀態
  const [savedWorlds, setSavedWorlds] = useState<any[]>([]);
  const [selectedWorldId, setSelectedWorldId] = useState<string>("new");
  const [draftSegments, setDraftSegments] = useState<Segment[]>([]);
  const [selectedSegmentId, setSelectedSegmentId] = useState<number | null>(null);

  // Google Trends 狀態
  const [trends, setTrends] = useState<any[]>([]);
  const [isLoadingTrends, setIsLoadingTrends] = useState(false);
  const [brainstormingTopic, setBrainstormingTopic] = useState<string | null>(null);

  useEffect(() => {
    if (!job?.segments || job.segments.length === 0) {
      setDraftSegments([]);
      setSelectedSegmentId(null);
      return;
    }

    setDraftSegments((current) => {
      const incoming = job.segments!.map((segment) => ({ ...segment }));

      if (current.length === 0) {
        return incoming;
      }

      const currentMap = new Map(current.map((segment) => [segment.id, segment]));
      return incoming.map((serverSegment) => {
        const localSegment = currentMap.get(serverSegment.id);
        if (!localSegment) {
          return serverSegment;
        }

        return {
          ...serverSegment,
          visualPrompt: localSegment.visualPrompt,
          audioScript: localSegment.audioScript
        };
      });
    });

    setSelectedSegmentId((current) => {
      if (current && job.segments!.some((segment) => segment.id === current)) {
        return current;
      }
      return job.segments![0]?.id ?? null;
    });
  }, [job?.id, job?.segments]);

  const fetchTrends = async () => {
    setIsLoadingTrends(true);
    try {
      const res = await fetch('/iftv/api/trends');
      if (res.ok) {
        const data = await res.json();
        setTrends(data.trends || []);
      }
    } catch (err) {
      console.error('Failed to fetch trends:', err);
    } finally {
      setIsLoadingTrends(false);
    }
  };

  // 取得所有可用的 YouTube 頻道設定檔與已儲存平行世界
  useEffect(() => {
    const fetchChannels = async () => {
      try {
        const res = await fetch('/iftv/api/channels');
        if (res.ok) {
          const data = await res.json();
          setChannels(data);
          if (data.length > 0) {
            setSelectedChannel(data[0].profile);
          }
        }
      } catch (err) {
        console.error('Failed to fetch channels:', err);
      }
    };

    const fetchSavedWorlds = async () => {
      try {
        const res = await fetch('/iftv/api/worlds');
        if (res.ok) {
          const data = await res.json();
          setSavedWorlds(data.worlds || []);
        }
      } catch (err) {
        console.error('Failed to fetch saved worlds:', err);
      }
    };

    const fetchIntros = async () => {
      try {
        const res = await fetch('/iftv/api/intros');
        if (res.ok) {
          const data = await res.json();
          setIntros(data.intros || []);
          if (data.intros?.length > 0) {
            setSelectedIntroUrl(data.intros[0].url);
          }
        }
      } catch (err) {
        console.error('Failed to fetch intros:', err);
      }
    };

    fetchChannels();
    fetchSavedWorlds();
    fetchIntros();
    fetchTrends();
  }, []);

  // Reload 後自動續接上一個 job，避免 UI 回到起始畫面就接不上
  useEffect(() => {
    const restoreActiveJob = async () => {
      try {
        const persistedJobId = window.localStorage.getItem('iftv.activeJobId');
        if (!persistedJobId) {
          const fallbackRes = await fetch('/iftv/api/jobs');
          if (!fallbackRes.ok) return;
          const fallbackData = await fallbackRes.json();
          if (fallbackData?.job?.id && shouldRestoreJob(fallbackData.job)) {
            window.localStorage.setItem('iftv.activeJobId', fallbackData.job.id);
            setActiveJobId(fallbackData.job.id);
            setJob(fallbackData.job);
          }
          return;
        }

        const res = await fetch(`/iftv/api/jobs?id=${persistedJobId}`);
        if (!res.ok) {
          window.localStorage.removeItem('iftv.activeJobId');
          return;
        }

        const data = await res.json();
        if (!shouldRestoreJob(data)) {
          window.localStorage.removeItem('iftv.activeJobId');
          setActiveJobId(null);
          setJob(null);
          return;
        }

        setActiveJobId(persistedJobId);
        setJob(data);
      } catch (err) {
        console.warn('Failed to restore active job after reload:', err);
      }
    };

    restoreActiveJob();
  }, []);

  // 查詢任務進度 (Polling) — pollKey 變動時強制重啟（用於 handleResume 後）
  useEffect(() => {
    if (!activeJobId) return;

    let timer: NodeJS.Timeout;
    let cancelled = false;
    
    const pollJob = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/iftv/api/jobs?id=${activeJobId}`);
        if (!res.ok) throw new Error('Failed to fetch job progress');
        const data = await res.json();
        
        if (cancelled) return;
        setJob(data);

        // 如果已成功發布或失敗，停止輪詢
        if (data.status === 'published' || data.status === 'preview_ready' || data.status === 'failed' || data.status === 'quality_failed') {
          if (data.status === 'published' || data.status === 'preview_ready') {
            confetti({
              particleCount: 150,
              spread: 80,
              origin: { y: 0.6 }
            });
          }
          return;
        }

        // 否則 3 秒後繼續輪詢
        if (!cancelled) timer = setTimeout(pollJob, 3000);
      } catch (err: any) {
        console.error('Polling error:', err);
        if (!cancelled) {
          setError(err.message || 'Error polling status');
          // 發生錯誤時，過 5 秒後重新輪詢，防止暫時性網路中斷或伺服器重啟導致輪詢終止
          timer = setTimeout(pollJob, 5000);
        }
      }
    };

    pollJob();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeJobId, pollKey]);

  const handleStart = async () => {
    if (!prompt.trim()) return;
    setIsSubmitting(true);
    setError(null);
    setJob(null);

    try {
      const payload: any = { prompt, channel: selectedChannel };
      if (productPlacement.trim()) {
        payload.productPlacement = productPlacement.trim();
      }
      if (selectedIntroUrl) {
        payload.introUrl = selectedIntroUrl;
      }
      if (productPlacementImg) {
        payload.productPlacementImg = productPlacementImg;
      }
      payload.previewOnly = previewOnly;
      
      // 如果選擇了已有世界，把該世界設定一併傳過去！
      if (selectedWorldId && selectedWorldId !== "new") {
        const w = savedWorlds.find(x => x.id === selectedWorldId);
        if (w) {
          payload.worldInfo = {
            worldName: w.worldName,
            worldDescription: w.worldDescription,
            visualStyle: w.visualStyle,
            mainCharacterDescription: w.mainCharacterDescription
          };
        }
      }

      const res = await fetch('/iftv/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const contentType = res.headers.get('content-type') || '';
      const isJson = contentType.includes('application/json');
      const data = isJson ? await res.json() : await res.text();

      if (!res.ok) {
        const message = isJson && data && typeof data === 'object'
          ? data.error || 'Failed to trigger video generation'
          : `Failed to trigger video generation: ${String(data).slice(0, 200)}`;
        throw new Error(message);
      }

      if (!isJson || !data || typeof data !== 'object') {
        throw new Error('Server returned an unexpected response format.');
      }

      window.localStorage.setItem('iftv.activeJobId', data.id);
      setActiveJobId(data.id);
      setJob(data);

      // 重新整理已儲存的世界清單，以便之後可以選取新產生的
      const worldsRes = await fetch('/iftv/api/worlds');
      if (worldsRes.ok) {
        const worldsData = await worldsRes.json();
        setSavedWorlds(worldsData.worlds || []);
      }
    } catch (err: any) {
      console.error('Trigger error:', err);
      setError(err.message || 'Server connection error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReset = () => {
    window.localStorage.removeItem('iftv.activeJobId');
    setActiveJobId(null);
    setJob(null);
    setError(null);
    setPrompt("");
    setProductPlacement("");
    setProductPlacementImg("");
    setPreviewOnly(true);
    if (intros.length > 0) {
      setSelectedIntroUrl(intros[0].url);
    }
    setSelectedWorldId("new");
  };

  const handleResume = async () => {
    if (!job) return;
    // 如果 segments 不存在則無法接續
    if (!job.segments || job.segments.length === 0) {
      setError('無法接續：劇本片段尚未生成，請重新開始。');
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/iftv/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, segments: job.segments })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to resume video generation');
      }
      const data = await res.json();
      window.localStorage.setItem('iftv.activeJobId', data.id);
      setJob(data);
      // 遞增 pollKey 以強制 polling useEffect 重新啟動
      setPollKey(k => k + 1);
    } catch (err: any) {
      console.error('Resume error:', err);
      setError(err.message || 'Server connection error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleImprove = async () => {
    if (!job) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/iftv/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, improve: true })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.job?.error || '改善重生失敗');
      window.localStorage.setItem('iftv.activeJobId', data.id);
      setJob(data);
      setDraftSegments(data.segments || []);
      setPollKey((k) => k + 1);
    } catch (err: any) {
      console.error('Improved regeneration error:', err);
      setError(err.message || '改善重生失敗');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePublish = async () => {
    if (!job) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/iftv/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, publishOnly: true })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '上傳前驗證失敗');
      setJob(data);
      setPollKey((k) => k + 1);
    } catch (err: any) {
      setError(err.message || '上傳前驗證失敗');
    } finally {
      setIsSubmitting(false);
    }
  };

  const updateDraftSegment = (segmentId: number, field: 'visualPrompt' | 'audioScript', value: string) => {
    setDraftSegments((current) =>
      current.map((segment) =>
        segment.id === segmentId
          ? { ...segment, [field]: value }
          : segment
      )
    );
  };

  const submitDraftSegments = async (reviewOnly: boolean) => {
    if (!job || draftSegments.length === 0) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/iftv/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: job.id,
          segments: draftSegments,
          reviewOnly
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || (reviewOnly ? 'Failed to re-run quality review' : 'Failed to resume video generation'));
      }

      const data = await res.json();
      window.localStorage.setItem('iftv.activeJobId', data.id);
      setJob(data);
      setDraftSegments(data.segments || draftSegments);
      setSelectedSegmentId((current) => {
        if (current && data.segments?.some((segment: Segment) => segment.id === current)) {
          return current;
        }
        return data.segments?.[0]?.id ?? null;
      });

      if (!reviewOnly) {
        setPollKey((k) => k + 1);
      }
    } catch (err: any) {
      console.error(reviewOnly ? 'Review error:' : 'Resume error:', err);
      setError(err.message || 'Server connection error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const displayProgress = job ? getDisplayProgress(job) : 0;
  const activeDraftSegment = draftSegments.find((segment) => segment.id === selectedSegmentId) || draftSegments[0] || null;
  const draftDirty = Boolean(
    job?.segments?.length &&
    draftSegments.length === job.segments.length &&
    draftSegments.some((segment, index) => {
      const original = job.segments?.[index];
      return !original || original.visualPrompt !== segment.visualPrompt || original.audioScript !== segment.audioScript;
    })
  );

  return (
    <main className="container mx-auto px-6 py-12 min-h-screen flex flex-col items-center">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-4 mb-10"
      >
        <div className="p-3.5 bg-violet-600 rounded-2xl shadow-[0_0_30px_rgba(139,92,246,0.4)]">
          <Tv className="w-8 h-8 text-white animate-float" />
        </div>
        <div>
          <h1 className="text-4xl font-extrabold tracking-tight glow-text">
            如果電視台 <span className="text-violet-400 font-medium text-3xl">If TV</span>
          </h1>
          <p className="text-xs text-zinc-500 tracking-widest uppercase mt-0.5">Automated Parallel World Video Studio</p>
        </div>
      </motion.div>

      {/* Main Panel */}
      <div className="w-full max-w-4xl glass-panel p-8 md:p-10 relative overflow-hidden">
        {/* Glow decoration */}
        <div className="absolute top-[-10%] right-[-10%] w-60 h-60 rounded-full bg-violet-900/10 blur-[100px] pointer-events-none" />
        <div className="absolute bottom-[-10%] left-[-10%] w-60 h-60 rounded-full bg-indigo-900/10 blur-[100px] pointer-events-none" />

        <AnimatePresence mode="wait">
          {/* Step 1: Input Prompt */}
          {!activeJobId && (
            <motion.div
              key="input"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              className="space-y-8"
            >
              <div className="space-y-4 text-center max-w-2xl mx-auto">
                <h2 className="text-3xl font-bold bg-gradient-to-r from-white via-zinc-200 to-zinc-500 bg-clip-text text-transparent">
                  平行宇宙，一鍵放送
                </h2>
                <p className="text-zinc-400 text-base leading-relaxed">
                  輸入一句您的「What If」狂想，AI 會為您自動腦力激盪設定、撰寫旁白、生成影片，並發布至 YouTube 頻道！
                </p>
              </div>

              {/* Global Error Banner */}
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-4 bg-rose-500/10 border border-rose-500/25 rounded-2xl flex items-start gap-3 text-left max-w-2xl mx-auto"
                >
                  <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <span className="text-sm font-bold text-rose-400">連線或初始化失敗</span>
                    <p className="text-xs text-rose-300/80 leading-relaxed font-light">{error}</p>
                  </div>
                </motion.div>
              )}

              {/* Saved Worlds Library Dropdown */}
              {savedWorlds.length > 0 && (
                <div className="space-y-2.5 text-left max-w-2xl mx-auto mb-2">
                  <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest block flex items-center gap-1.5">
                    <Globe className="w-3.5 h-3.5 text-violet-400" /> 選擇已儲存的平行世界與角色 (重用以維持連續性)
                  </label>
                  <div className="relative group">
                    <select
                      value={selectedWorldId}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSelectedWorldId(val);
                        if (val === "new") {
                          setPrompt("");
                        } else {
                          const w = savedWorlds.find(x => x.id === val);
                          if (w) {
                            setPrompt(w.prompt || "");
                          }
                        }
                      }}
                      className="w-full bg-black/60 border border-zinc-800 rounded-xl p-3 pr-10 text-zinc-300 focus:outline-none focus:border-violet-500/80 transition-colors appearance-none cursor-pointer text-sm font-light"
                    >
                      <option value="new" className="bg-zinc-950 text-zinc-300">✨ 腦力激盪全新平行世界與角色...</option>
                      {savedWorlds.map((w) => (
                        <option key={w.id} value={w.id} className="bg-zinc-950 text-zinc-300">
                          {w.worldName} — 「{w.prompt.slice(0, 30)}...」
                        </option>
                      ))}
                    </select>
                    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-zinc-500 text-xs">
                      ▼
                    </div>
                  </div>
                  
                  {/* Saved World Preview */}
                  {selectedWorldId !== "new" && (() => {
                    const w = savedWorlds.find(x => x.id === selectedWorldId);
                    if (!w) return null;
                    return (
                      <motion.div
                        initial={{ opacity: 0, y: 5 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="p-4 bg-violet-950/10 border border-violet-500/20 rounded-xl space-y-2 text-xs font-light text-zinc-400 leading-relaxed shadow-sm"
                      >
                        <p><strong className="text-zinc-200">世界設定:</strong> {
                          typeof w.worldDescription === 'object' && w.worldDescription !== null ?
                            `世界氛圍：${(w.worldDescription as any).atmosphere || ''} | 運行邏輯：${(w.worldDescription as any).logic || ''} | 社會形態：${(w.worldDescription as any).society || ''}`.slice(0, 150) :
                            (w.worldDescription || '').slice(0, 150)
                        }...</p>
                        <p><strong className="text-zinc-200">視覺風格:</strong> {
                          typeof w.visualStyle === 'object' && w.visualStyle !== null ?
                            `燈光：${(w.visualStyle as any).Lighting || ''} | 鏡頭：${(w.visualStyle as any)['Lens & Camera'] || ''} | 色彩：${(w.visualStyle as any)['Color & Stock'] || ''} | 氛圍：${(w.visualStyle as any).Atmosphere || ''}`.slice(0, 150) :
                            (w.visualStyle || '').slice(0, 150)
                        }</p>
                        <p><strong className="text-zinc-200">核心主角:</strong> {
                          typeof w.mainCharacterDescription === 'object' && w.mainCharacterDescription !== null ?
                            `性別：${(w.mainCharacterDescription as any).gender || ''} | 年齡：${(w.mainCharacterDescription as any).age || ''} | 外觀：${(w.mainCharacterDescription as any).build || ''} | 衣著：${(w.mainCharacterDescription as any).clothing || ''}`.slice(0, 150) :
                            (w.mainCharacterDescription || '').slice(0, 150)
                        }</p>
                      </motion.div>
                    );
                  })()}
                </div>
              )}

              {/* Google Trends Daily Searches */}
              <div className="space-y-3 text-left max-w-2xl mx-auto">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest block flex items-center gap-1.5">
                    <Flame className="w-4.5 h-4.5 text-amber-500 animate-pulse" /> 
                    今日發燒話題 (點擊自動生成狂想劇本)
                  </label>
                  <button
                    type="button"
                    onClick={fetchTrends}
                    disabled={isLoadingTrends}
                    className="p-1 text-zinc-500 hover:text-violet-400 transition-colors rounded-lg hover:bg-zinc-900 cursor-pointer flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3 h-3 ${isLoadingTrends ? 'animate-spin' : ''}`} />
                    更新話題
                  </button>
                </div>

                {isLoadingTrends ? (
                  <div className="flex items-center justify-center py-6 bg-zinc-950/20 border border-zinc-900 rounded-2xl">
                    <Loader2 className="w-5 h-5 text-violet-400 animate-spin" />
                    <span className="text-xs text-zinc-500 ml-2 font-light">正在獲取 Google 最新搜尋趨勢...</span>
                  </div>
                ) : trends.length > 0 ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[220px] overflow-y-auto pr-1">
                    {trends.slice(0, 8).map((t, idx) => {
                      const isSelected = prompt.includes(t.title);
                      const isBrainstormingThis = brainstormingTopic === t.title;
                      return (
                        <button
                          key={idx}
                          type="button"
                          disabled={brainstormingTopic !== null}
                          onClick={async () => {
                            if (brainstormingTopic) return;
                            setBrainstormingTopic(t.title);
                            try {
                              const newsParam = t.newsTitle ? `&news=${encodeURIComponent(t.newsTitle)}` : '';
                              const res = await fetch(`/iftv/api/trends/brainstorm?topic=${encodeURIComponent(t.title)}${newsParam}`);
                              if (res.ok) {
                                const data = await res.json();
                                if (data.prompt) {
                                  setPrompt(data.prompt);
                                  setSelectedWorldId("new");
                                  setBrainstormingTopic(null);
                                  return;
                                }
                              }
                            } catch (err) {
                              console.error('Failed to brainstorm trend prompt:', err);
                            } finally {
                              setBrainstormingTopic(null);
                            }

                            // 備用模式：若 API 失敗，使用本地隨機範本
                            const templates = [
                              `如果「{topic}」的風波演變成了一場商業巨頭之間的終極情報戰，而背後操縱的其實是...`,
                              `如果「{topic}」實質上是大型實境秀的宣傳陰謀，整個城市都在被迫參與這場生存遊戲...`,
                              `如果「{topic}」成為了引爆全新科技革命的導火線，人類不得不全面適應新的數位生活秩序...`,
                              `如果「{topic}」的底層隱藏著某個未公開的古老謎團，而線索正藏在我們日常忽略的細節中...`
                            ];
                            const chosenTemplate = templates[idx % templates.length].replace('{topic}', t.title);
                            setPrompt(chosenTemplate);
                            setSelectedWorldId("new");
                          }}
                          className={`flex flex-col items-start p-3 rounded-xl border text-left transition-all hover:scale-[1.01] active:scale-[0.99] cursor-pointer group w-full ${
                            isSelected
                              ? 'bg-violet-950/30 border-violet-500/80 shadow-[0_0_15px_rgba(139,92,246,0.1)]'
                              : 'bg-zinc-950/40 border-zinc-800/80 hover:border-zinc-700/80 hover:bg-zinc-900/20'
                          } ${brainstormingTopic !== null && !isBrainstormingThis ? 'opacity-40 cursor-not-allowed' : ''}`}
                        >
                          <div className="flex items-center justify-between w-full gap-2">
                            <span className="font-semibold text-sm text-zinc-100 group-hover:text-violet-300 transition-colors line-clamp-1 flex items-center gap-1.5">
                              {isBrainstormingThis ? (
                                <>
                                  <Loader2 className="w-3.5 h-3.5 text-violet-400 animate-spin" />
                                  <span className="text-violet-400 font-medium">AI 腦洞大開中...</span>
                                </>
                              ) : (
                                t.title
                              )}
                            </span>
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400 font-bold shrink-0">
                              {t.traffic}
                            </span>
                          </div>
                          {t.newsTitle && !isBrainstormingThis && (
                            <span className="text-zinc-500 text-xs line-clamp-1 mt-1 font-light group-hover:text-zinc-400 transition-colors">
                              {t.newsTitle}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="p-4 bg-zinc-950/20 border border-zinc-900 rounded-2xl text-center text-xs text-zinc-600 font-light">
                    暫無發燒話題數據，請稍後點擊更新重試。
                  </div>
                )}
              </div>

              <div className="relative group">
                <div className="absolute -inset-0.5 bg-gradient-to-r from-violet-600 to-indigo-600 rounded-2xl blur opacity-30 group-focus-within:opacity-60 transition duration-300" />
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="如果貓統治了世界，人類變成了寵物..."
                  disabled={isSubmitting}
                  className="relative w-full bg-black/60 border border-zinc-800/80 rounded-2xl p-6 text-xl focus:outline-none focus:border-violet-500/80 transition-colors min-h-[140px] resize-none text-white placeholder-zinc-600 font-light"
                />
              </div>

              {/* Product Placement Input */}
              <div className="space-y-2.5 text-left max-w-2xl mx-auto">
                <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest block flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-violet-400" /> 置入性行銷人事物 (選填)
                </label>
                <div className="relative group">
                  <div className="absolute -inset-0.5 bg-gradient-to-r from-violet-600/30 to-indigo-600/30 rounded-xl blur opacity-30 group-focus-within:opacity-50 transition duration-300" />
                  <input
                    type="text"
                    value={productPlacement}
                    onChange={(e) => setProductPlacement(e.target.value)}
                    placeholder="例如：SuperCat 貓罐頭、一個閃亮的金手環、特定人物等"
                    disabled={isSubmitting}
                    className="relative w-full bg-black/60 border border-zinc-800 rounded-xl p-3 text-zinc-300 focus:outline-none focus:border-violet-500/80 transition-colors text-sm font-light text-white placeholder-zinc-600"
                  />
                </div>
                
                {/* Product Placement Image Upload */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-2">
                  <div className="md:col-span-3">
                    <label className="relative flex items-center justify-center border border-dashed border-zinc-800 hover:border-violet-500/60 rounded-xl p-2.5 text-xs text-zinc-500 hover:text-zinc-400 cursor-pointer bg-black/20 hover:bg-violet-950/5 transition-all text-center">
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/jpg,image/webp"
                        onChange={handleImgUpload}
                        disabled={isUploadingImg || isSubmitting}
                        className="hidden"
                      />
                      {isUploadingImg ? (
                        <span className="flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> 上傳中...</span>
                      ) : (
                        <span>📷 上傳置入實物圖片 (分析外觀特徵)</span>
                      )}
                    </label>
                  </div>
                  
                  <div className="flex items-center justify-center">
                    {productPlacementImg ? (
                      <div className="relative group rounded-lg overflow-hidden border border-zinc-800 w-full h-[38px] bg-black/40 flex items-center justify-center p-1.5">
                        <img 
                          src={formatAssetUrl(productPlacementImg.replace('public/assets/uploads/', '/assets/uploads/'))} 
                          alt="Placement Preview"
                          className="h-full object-contain"
                        />
                        <button 
                          onClick={(e) => {
                            e.preventDefault();
                            setProductPlacementImg("");
                          }}
                          className="absolute top-0 right-0 bg-rose-600 hover:bg-rose-500 text-white rounded-bl px-1 py-0.5 text-[8px] cursor-pointer font-bold"
                          title="清除圖片"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <span className="text-[11px] text-zinc-600 italic">無上傳圖片</span>
                    )}
                  </div>
                </div>

                <p className="text-[11px] text-zinc-500 font-light leading-normal">
                  💡 當設定置入內容或上傳圖片時，AI 會自動在故事中安排該事物出現，多模態模型會分析圖片特徵以引導生圖。
                </p>
              </div>

              {/* Target Channel & Intro Selector Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-2xl mx-auto">
                {channels.length > 0 && (
                  <div className="space-y-2 text-left">
                    <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest block flex items-center gap-1.5">
                      <Globe className="w-3.5 h-3.5 text-violet-400" /> 發布目標 YouTube 頻道
                    </label>
                    <div className="relative group">
                      <select
                        value={selectedChannel}
                        onChange={(e) => setSelectedChannel(e.target.value)}
                        className="w-full bg-black/60 border border-zinc-800 rounded-xl p-3 text-zinc-300 focus:outline-none focus:border-violet-500/80 transition-colors appearance-none cursor-pointer text-sm font-light h-[46px]"
                      >
                        {channels.map((chan) => (
                          <option key={chan.profile} value={chan.profile} className="bg-zinc-950 text-zinc-300">
                            {chan.title}
                          </option>
                        ))}
                      </select>
                      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-zinc-500 text-xs">
                        ▼
                      </div>
                    </div>
                  </div>
                )}

                {/* Intro Selector Dropdown */}
                <div className="space-y-2 text-left">
                  <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest block flex items-center gap-1.5">
                    <Tv className="w-3.5 h-3.5 text-violet-400" /> 選擇影片固定片頭
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2 relative group">
                      <select
                        value={selectedIntroUrl}
                        onChange={(e) => setSelectedIntroUrl(e.target.value)}
                        className="w-full bg-black/60 border border-zinc-800 rounded-xl p-3 pr-10 text-zinc-300 focus:outline-none focus:border-violet-500/80 transition-colors appearance-none cursor-pointer text-sm font-light h-[46px]"
                      >
                        {intros.map((intro) => (
                          <option key={intro.url} value={intro.url} className="bg-zinc-950 text-zinc-300">
                            {intro.name}
                          </option>
                        ))}
                      </select>
                      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-zinc-500 text-xs">
                        ▼
                      </div>
                    </div>
                    
                    <label className="relative flex items-center justify-center border border-dashed border-zinc-800 hover:border-violet-500/60 rounded-xl text-center text-[10px] text-zinc-400 hover:text-zinc-300 cursor-pointer bg-black/30 hover:bg-violet-950/5 transition-all h-[46px] px-1">
                      <input
                        type="file"
                        accept="video/mp4,video/x-m4v,video/*"
                        onChange={handleIntroUpload}
                        disabled={isUploadingIntro || isSubmitting}
                        className="hidden"
                      />
                      {isUploadingIntro ? (
                        <span className="flex items-center gap-1 justify-center"><Loader2 className="w-3.5 h-3.5 animate-spin" /> 上傳中</span>
                      ) : (
                        <span className="leading-tight">📤 上傳片頭<br/>(.mp4)</span>
                      )}
                    </label>
                  </div>
                </div>
              </div>

              <label className="max-w-2xl mx-auto flex items-start gap-3 p-4 rounded-2xl border border-violet-500/15 bg-violet-500/5 cursor-pointer text-left">
                <input
                  type="checkbox"
                  checked={previewOnly}
                  onChange={(e) => setPreviewOnly(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-zinc-700 bg-black text-violet-500 focus:ring-violet-500"
                />
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-zinc-100">只預覽，不上傳 YouTube</div>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    開啟後會完整生成片頭、預告、主內容、片尾與配樂，但會停在本地預覽成品，不會呼叫上傳流程。
                  </p>
                </div>
              </label>

              <button
                onClick={handleStart}
                disabled={isSubmitting || !prompt.trim()}
                className="w-full py-4.5 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed rounded-2xl font-bold text-xl transition-all flex items-center justify-center gap-3 group shadow-lg shadow-violet-900/25 cursor-pointer"
              >
                {isSubmitting ? (
                  <>
                    正在初始化發想
                    <Loader2 className="w-6 h-6 animate-spin" />
                  </>
                ) : (
                  <>
                    {previewOnly ? '開始生成預覽影片' : '開始頻道創作與上傳'}
                    <Send className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                  </>
                )}
              </button>
            </motion.div>
          )}

          {/* Step 2: Generation Pipeline */}
          {activeJobId && job && (
            <motion.div
              key="pipeline"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-8"
            >
              {/* Progress Banner */}
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 pb-6 border-b border-zinc-800/60">
                <div className="space-y-1.5">
                  <span className="px-3 py-1 bg-violet-500/10 border border-violet-500/20 text-violet-400 text-xs font-semibold rounded-full tracking-wider uppercase">
                    JOB ID: {job.id}
                  </span>
                  <h3 className="text-xl font-bold text-zinc-100 flex items-center gap-2">
                    目標想法: <span className="text-zinc-300 font-medium">「{job.prompt}」</span>
                  </h3>
                </div>

                {/* Progress Circle & Text */}
                <div className="flex items-center gap-4">
                  <div className="relative w-14 h-14">
                    <svg className="w-full h-full transform -rotate-90">
                      <circle cx="28" cy="28" r="24" className="stroke-zinc-800 fill-none" strokeWidth="4" />
                      <circle 
                        cx="28" 
                        cy="28" 
                        r="24" 
                        className="stroke-violet-500 fill-none transition-all duration-500" 
                        strokeWidth="4" 
                        strokeDasharray={2 * Math.PI * 24}
                      strokeDashoffset={2 * Math.PI * 24 * (1 - displayProgress / 100)}
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center text-xs font-bold text-violet-400">
                      {displayProgress}%
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-sm font-medium text-zinc-400 block">當前狀態</span>
                    <span className="text-base font-bold text-violet-400">
                      {getStatusLabel(job.status)}
                    </span>
                    <span className="mt-1 block text-[11px] text-zinc-500 font-light">
                      最近更新：{new Date(job.updatedAt).toLocaleString('zh-TW', {
                        hour12: false,
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit'
                      })}
                    </span>
                  </div>
                </div>
              </div>

              {/* Grid: Left - Pipeline Status / Right - World & Scripts info */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                {/* Left - Status Steps (5 cols) */}
                <div className="lg:col-span-5 space-y-4">
                  <h4 className="text-sm font-bold text-zinc-400 tracking-wider uppercase">處理流水線</h4>
                  <div className="space-y-3">
                    <StepItem 
                      icon={<Sparkles />} 
                      label="平行世界觀發想" 
                      status={job.status === 'brainstorming' ? 'active' : displayProgress > 10 ? 'completed' : 'pending'} 
                    />
                    <StepItem 
                      icon={<Play />} 
                      label="Veo 3.1 影像與旁白生成" 
                      status={job.status === 'generating' ? 'active' : displayProgress >= 70 ? 'completed' : 'pending'} 
                    />
                    <StepItem 
                      icon={<Scissors />} 
                      label="FFmpeg 片段無損串接" 
                      status={job.status === 'stitching' ? 'active' : displayProgress >= 85 ? 'completed' : 'pending'} 
                    />
                  <StepItem 
                    icon={<Youtube />} 
                    label={job.previewOnly ? '本地預覽輸出' : 'YouTube 智能發布與多國字幕'} 
                    status={job.status === 'uploading' ? 'active' : (job.status === 'published' || job.status === 'preview_ready') ? 'completed' : 'pending'} 
                  />
                  </div>

                  {/* Segment Detail Progress List */}
                  {job.segments && job.segments.length > 0 && (job.status === 'generating' || job.status === 'stitching') && (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="p-4 bg-zinc-950/40 border border-zinc-900 rounded-xl space-y-2.5"
                    >
                      <h5 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">影片片段生成進度</h5>
                      <div className="space-y-2">
                        {job.segments.map((seg) => (
                          <div key={seg.id} className="flex items-center justify-between text-xs py-1">
                            <span className="text-zinc-400 font-medium flex items-center gap-1.5">
                              <Film className="w-3.5 h-3.5 text-zinc-600" /> Segment #{seg.id}
                            </span>
                            <span className={`font-semibold flex items-center gap-1 ${
                              seg.status === 'completed' ? 'text-emerald-400' :
                              seg.status === 'generating' ? 'text-violet-400 animate-pulse' : 'text-zinc-600'
                            }`}>
                              {seg.status === 'completed' && <><CheckCircle2 className="w-3 h-3" /> 已下載</>}
                              {seg.status === 'generating' && <><Loader2 className="w-3 h-3 animate-spin" /> 生成中...</>}
                              {seg.status === 'pending' && '等待隊列'}
                              {seg.status === 'failed' && '異常'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}

                  {/* Process Control Center (Self-Recovery Option if HMR or server restarts) */}
                  {job.status !== 'published' && job.status !== 'completed' && job.status !== 'preview_ready' && (
                    <div className="pt-2">
                      <details className="text-zinc-500 text-xs font-light cursor-pointer group hover:text-zinc-400 transition-colors">
                        <summary className="list-none flex items-center gap-1.5 focus:outline-none">
                          <RefreshCw className="w-3 h-3 group-open:rotate-180 transition-transform duration-300" />
                          <span>遇到生成卡住？系統自我恢復中心</span>
                        </summary>
                        <div className="mt-3 p-4 bg-zinc-950/50 border border-zinc-900 rounded-xl space-y-3">
                          <p className="text-[11px] leading-relaxed text-zinc-400">
                            💡 **提示**：如果影片生成進度長時間沒有變化，可能是因為背景服務重啟或 HMR。您可以安全地點擊下方按鈕進行強制自我修復或重新開始。
                          </p>
                          <div className="flex gap-2">
                            <button
                              onClick={handleResume}
                              disabled={isSubmitting}
                              className="px-3 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-800 disabled:text-zinc-500 rounded-lg text-[11px] font-semibold text-white shadow cursor-pointer transition-colors"
                            >
                              ⚡ {job.status === 'review_ready' ? '繼續上傳與發布' : '強制接續生成'}
                            </button>
                            <button
                              onClick={handleReset}
                              disabled={isSubmitting}
                              className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-50 rounded-lg text-zinc-400 hover:text-zinc-300 text-[11px] font-semibold transition-colors cursor-pointer border border-zinc-800"
                            >
                              放棄並重新開始
                            </button>
                          </div>
                        </div>
                      </details>
                    </div>
                  )}

                  {/* Error Box */}
                  {(job.status === 'failed' || job.status === 'quality_failed') && (
                    <motion.div
                      initial={{ scale: 0.95 }}
                      animate={{ scale: 1 }}
                      className="p-4 bg-rose-500/10 border border-rose-500/25 rounded-2xl flex items-start gap-3"
                    >
                      <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                      <div className="space-y-1.5 w-full">
                        <span className="text-sm font-bold text-rose-400">處理失敗</span>
                        <p className="text-xs text-rose-300/80 leading-relaxed font-light">{job.error || 'Unknown pipeline exception.'}</p>
                        
                        <div className="flex items-center gap-2 pt-2">
                          {job.status === 'quality_failed' && (
                            <button
                              onClick={handleImprove}
                              disabled={isSubmitting}
                              className="px-3.5 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-800 disabled:text-zinc-500 rounded-lg text-xs font-semibold flex items-center gap-1.5 cursor-pointer text-white shadow transition-colors"
                            >
                              {isSubmitting ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Sparkles className="w-3 h-3" />
                              )}
                              <span>{isSubmitting ? '改善重生中...' : '依品質報告改善重生'}</span>
                            </button>
                          )}
                          <button
                            onClick={handleResume}
                            disabled={isSubmitting}
                            className="px-3.5 py-2 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-800 disabled:text-zinc-500 rounded-lg text-xs font-semibold flex items-center gap-1.5 cursor-pointer text-white shadow transition-colors"
                          >
                            <RefreshCw className={`w-3 h-3 ${isSubmitting ? 'animate-spin' : ''}`} />
                            接續生成
                          </button>
                          
                          <button
                            onClick={handleReset}
                            disabled={isSubmitting}
                            className="px-3.5 py-2 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-50 rounded-lg text-zinc-400 hover:text-zinc-300 text-xs font-semibold transition-colors cursor-pointer border border-zinc-800"
                          >
                            放棄並重來
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </div>

                {/* Right - Expanded Parallel World Setting / Result (7 cols) */}
                <div className="lg:col-span-7 space-y-6">
                  {job.status === 'published' || job.status === 'preview_ready' ? (
                    /* Final Published View */
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="space-y-6 bg-violet-950/10 border border-violet-500/20 p-6 rounded-2xl shadow-[0_0_30px_rgba(139,92,246,0.05)]"
                    >
                      <div className="text-center space-y-2 py-4">
                        <div className="w-16 h-16 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-2xl flex items-center justify-center mx-auto mb-2">
                          <CheckCircle2 className="w-10 h-10 animate-bounce" />
                        </div>
                        <h4 className="text-2xl font-bold text-emerald-400">
                          {job.status === 'published' ? '發布成功！' : '預覽完成！'}
                        </h4>
                        <p className="text-zinc-400 text-sm font-light">
                          {job.status === 'published'
                            ? '您的狂想世界已經順利上線 YouTube！'
                            : '影片已完成本地預覽，尚未上傳 YouTube。'}
                        </p>
                        {job.error && job.status === 'preview_ready' && (
                          <div className="mt-3 p-3 rounded-xl border border-amber-500/25 bg-amber-500/10 text-left text-xs text-amber-200 whitespace-pre-wrap">
                            {job.error}
                          <div className="mt-2 text-amber-300/80">目前僅保留預覽，品質未通過前不會提供上傳按鈕。</div>
                            <button
                              onClick={handleImprove}
                              disabled={isSubmitting}
                              className="mt-3 px-3.5 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white text-xs font-semibold cursor-pointer flex items-center gap-1.5 transition-colors"
                            >
                              {isSubmitting ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Sparkles className="w-3.5 h-3.5" />
                              )}
                              <span>{isSubmitting ? '依品質報告改善重生中...' : '依品質報告改善重生'}</span>
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Video Player */}
                      {job.finalVideoUrl && (
                        <div className="overflow-hidden rounded-xl border border-zinc-800 bg-black aspect-video relative group">
                          <video 
                            src={formatAssetUrl(job.finalVideoUrl)} 
                            controls 
                            className="w-full h-full object-cover"
                          />
                        </div>
                      )}

                      {job.youtubeUrl ? (
                        <a
                          href={job.youtubeUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="w-full py-4.5 bg-rose-600 hover:bg-rose-500 rounded-xl text-center font-bold text-lg text-white transition-all flex items-center justify-center gap-2 group cursor-pointer shadow-lg shadow-rose-900/20"
                        >
                          <Youtube className="w-6 h-6 fill-white" />
                          前往 YouTube 收看頻道
                          <ExternalLink className="w-5 h-5 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                        </a>
                      ) : (
                        <div className="space-y-3">
                          <div className="w-full py-4.5 bg-zinc-900/80 border border-zinc-800 rounded-xl text-center font-medium text-zinc-300">
                            這支影片目前僅供預覽，沒有上傳到 YouTube。
                          </div>
                          {job.qualityChecks && Object.keys(job.qualityChecks).length > 0 && Object.values(job.qualityChecks).every((check) => check.passed) && (
                            <button
                              onClick={handlePublish}
                              disabled={isSubmitting}
                              className="w-full py-3 bg-rose-600 hover:bg-rose-500 disabled:bg-zinc-800 disabled:text-zinc-500 rounded-xl text-center font-bold text-white transition-colors cursor-pointer"
                            >
                              {isSubmitting ? '準備上傳中…' : '品質已通過，確認上傳 YouTube'}
                            </button>
                          )}
                        </div>
                      )}

                      <button
                        onClick={handleReset}
                        className="w-full py-3 bg-zinc-900 hover:bg-zinc-800 rounded-xl text-center font-bold text-zinc-300 transition-colors border border-zinc-800 text-sm cursor-pointer"
                      >
                        再次製作新影片
                      </button>
                    </motion.div>
                  ) : job.worldInfo ? (
                    /* World setting display */
                    <motion.div
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="space-y-6"
                    >
                      <h4 className="text-sm font-bold text-zinc-400 tracking-wider uppercase">已架構的平行世界觀</h4>
                      
                      {/* World setting Card */}
                      <div className="bg-zinc-950/40 border border-zinc-900 rounded-2xl p-6 space-y-4">
                        <div className="flex items-center gap-2.5 border-b border-zinc-900 pb-3">
                          <Globe className="w-5 h-5 text-violet-400" />
                          <h5 className="text-lg font-bold text-zinc-100">{job.worldInfo.worldName}</h5>
                        </div>
                        {typeof job.worldInfo.worldDescription === 'object' && job.worldInfo.worldDescription !== null ? (
                          <div className="space-y-2 text-sm text-zinc-400 font-light leading-relaxed">
                            <p><strong className="text-zinc-300">世界氛圍:</strong> {(job.worldInfo.worldDescription as any).atmosphere}</p>
                            <p><strong className="text-zinc-300">運行邏輯:</strong> {(job.worldInfo.worldDescription as any).logic}</p>
                            <p><strong className="text-zinc-300">社會形態:</strong> {(job.worldInfo.worldDescription as any).society}</p>
                          </div>
                        ) : (
                          <p className="text-sm text-zinc-400 font-light leading-relaxed">{job.worldInfo.worldDescription}</p>
                        )}
                      </div>

                      {/* Main Style & Characters */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="bg-zinc-950/40 border border-zinc-900 rounded-2xl p-4.5 space-y-2.5">
                          <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5">
                            <Film className="w-3.5 h-3.5 text-violet-400" /> 視覺風格
                          </span>
                          {typeof job.worldInfo.visualStyle === 'object' && job.worldInfo.visualStyle !== null ? (
                            <div className="space-y-1 text-xs text-zinc-400 font-light leading-relaxed">
                              <p><strong className="text-zinc-300">燈光氛圍:</strong> {(job.worldInfo.visualStyle as any).Lighting}</p>
                              <p><strong className="text-zinc-300">鏡位鏡頭:</strong> {(job.worldInfo.visualStyle as any)['Lens & Camera']}</p>
                              <p><strong className="text-zinc-300">色彩底片:</strong> {(job.worldInfo.visualStyle as any)['Color & Stock']}</p>
                              <p><strong className="text-zinc-300">環境氣氛:</strong> {(job.worldInfo.visualStyle as any).Atmosphere}</p>
                            </div>
                          ) : (
                            <p className="text-sm text-zinc-300 font-medium">{job.worldInfo.visualStyle}</p>
                          )}
                        </div>
                        
                        <div className="bg-zinc-950/40 border border-zinc-900 rounded-2xl p-4.5 space-y-2.5">
                          <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5">
                            <User className="w-3.5 h-3.5 text-violet-400" /> 核心主角設定 (一致性)
                          </span>
                          <p className="text-sm text-zinc-300 font-light leading-relaxed line-clamp-3 text-ellipsis" title={typeof job.worldInfo.mainCharacterDescription === 'object' ? JSON.stringify(job.worldInfo.mainCharacterDescription) : job.worldInfo.mainCharacterDescription}>
                            {typeof job.worldInfo.mainCharacterDescription === 'object' && job.worldInfo.mainCharacterDescription !== null ?
                              `性別：${(job.worldInfo.mainCharacterDescription as any).gender || ''} | 年齡：${(job.worldInfo.mainCharacterDescription as any).age || ''} | 外觀：${(job.worldInfo.mainCharacterDescription as any).build || ''} | 衣著：${(job.worldInfo.mainCharacterDescription as any).clothing || ''}` :
                              job.worldInfo.mainCharacterDescription
                            }
                          </p>
                        </div>
                      </div>

                      {/* Script Segments */}
                      {draftSegments.length > 0 && (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <h5 className="text-sm font-bold text-zinc-400 tracking-wider uppercase flex items-center gap-1.5">
                              <FileText className="w-4 h-4 text-violet-400" /> 分鏡工作台
                            </h5>
                            <span className="text-[11px] text-zinc-500 font-light">
                              可直接編輯旁白與視覺提示，儲存後接續生成或只做重審
                            </span>
                          </div>

                          <div className="grid grid-cols-1 xl:grid-cols-[0.95fr_1.05fr] gap-4">
                            <div className="space-y-2 max-h-[460px] overflow-y-auto pr-2 custom-scrollbar">
                              {draftSegments.map((seg) => {
                                const isSelected = seg.id === selectedSegmentId;
                                const isCompleted = seg.status === 'completed';
                                return (
                                  <button
                                    key={seg.id}
                                    type="button"
                                    onClick={() => setSelectedSegmentId(seg.id)}
                                    className={`w-full text-left p-4 rounded-2xl border transition-all cursor-pointer ${
                                      isSelected
                                        ? 'bg-violet-500/10 border-violet-500/40 shadow-[0_0_20px_rgba(139,92,246,0.08)]'
                                        : 'bg-zinc-950/35 border-zinc-900/80 hover:border-zinc-700/80 hover:bg-zinc-900/30'
                                    }`}
                                  >
                                    <div className="flex items-center justify-between gap-2 mb-2">
                                      <span className="text-xs font-bold uppercase tracking-[0.2em] text-violet-300">
                                        Segment #{seg.id}
                                      </span>
                                      <span className={`text-[10px] font-semibold px-2 py-1 rounded-full border ${
                                        seg.status === 'failed'
                                          ? 'border-rose-500/30 text-rose-300 bg-rose-500/10'
                                          : isCompleted
                                            ? 'border-emerald-500/30 text-emerald-300 bg-emerald-500/10'
                                            : 'border-zinc-700 text-zinc-400 bg-zinc-900/50'
                                      }`}>
                                        {seg.status === 'completed' ? '已完成' : seg.status === 'generating' ? '生成中' : seg.status === 'failed' ? '異常' : '待處理'}
                                      </span>
                                    </div>
                                    <p className="text-sm text-zinc-200 leading-relaxed line-clamp-2">
                                      {seg.audioScript || '尚未填入旁白內容'}
                                    </p>
                                    <p className="text-[11px] text-zinc-500 mt-2 leading-relaxed line-clamp-2">
                                      {seg.visualPrompt || '尚未填入視覺提示'}
                                    </p>
                                  </button>
                                );
                              })}
                            </div>

                            <div className="space-y-4">
                              {activeDraftSegment ? (
                                <>
                                  <div className="rounded-3xl border border-violet-500/20 bg-gradient-to-br from-violet-950/35 via-zinc-950/80 to-black p-4 shadow-[0_0_30px_rgba(139,92,246,0.06)]">
                                    <div className="flex items-start justify-between gap-3 mb-4">
                                      <div>
                                        <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500 font-semibold">Live Preview</p>
                                        <h6 className="text-lg font-bold text-white mt-1">
                                          Segment #{activeDraftSegment.id}
                                        </h6>
                                      </div>
                                      <div className="text-right">
                                        <p className="text-[11px] text-zinc-500 uppercase tracking-wider">預估長度</p>
                                        <p className="text-sm font-semibold text-violet-300">
                                          {(activeDraftSegment.duration || 8).toFixed(1)}s
                                        </p>
                                      </div>
                                    </div>

                                    <div className="aspect-video rounded-2xl border border-white/10 bg-black/60 overflow-hidden relative">
                                      {activeDraftSegment.videoUrl ? (
                                        <video
                                          src={activeDraftSegment.videoUrl}
                                          controls
                                          className="w-full h-full object-cover"
                                        />
                                      ) : (
                                        <div className="absolute inset-0 p-5 flex flex-col justify-end bg-[radial-gradient(circle_at_top,rgba(139,92,246,0.22),transparent_44%),linear-gradient(180deg,rgba(0,0,0,0.02),rgba(0,0,0,0.7))]">
                                          <div className="space-y-2">
                                            <p className="text-[10px] uppercase tracking-[0.28em] text-violet-300/80 font-semibold">Scene Card</p>
                                            <p className="text-sm font-medium text-white leading-relaxed">
                                              {activeDraftSegment.visualPrompt || '這裡會顯示選中的分鏡視覺提示'}
                                            </p>
                                          </div>
                                        </div>
                                      )}
                                    </div>

                                    <div className="grid grid-cols-2 gap-3 mt-4 text-xs">
                                      <div className="rounded-2xl bg-white/5 border border-white/8 p-3">
                                        <p className="text-zinc-500 uppercase tracking-wider text-[10px] font-semibold">旁白字數</p>
                                        <p className="text-zinc-100 font-semibold mt-1">
                                          {activeDraftSegment.audioScript.length} chars
                                        </p>
                                      </div>
                                      <div className="rounded-2xl bg-white/5 border border-white/8 p-3">
                                        <p className="text-zinc-500 uppercase tracking-wider text-[10px] font-semibold">視覺提示字數</p>
                                        <p className="text-zinc-100 font-semibold mt-1">
                                          {activeDraftSegment.visualPrompt.length} chars
                                        </p>
                                      </div>
                                    </div>
                                  </div>

                                  <div className="space-y-3">
                                    <label className="block text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
                                      視覺提示
                                    </label>
                                    <textarea
                                      value={activeDraftSegment.visualPrompt}
                                      onChange={(e) => updateDraftSegment(activeDraftSegment.id, 'visualPrompt', e.target.value)}
                                      className="w-full min-h-[120px] rounded-2xl border border-zinc-800 bg-black/55 p-4 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-violet-500/80 transition-colors resize-y custom-scrollbar"
                                      placeholder="描述這一幕的畫面、鏡位、光線與情緒"
                                      disabled={isSubmitting}
                                    />
                                  </div>

                                  <div className="space-y-3">
                                    <label className="block text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
                                      旁白
                                    </label>
                                    <textarea
                                      value={activeDraftSegment.audioScript}
                                      onChange={(e) => updateDraftSegment(activeDraftSegment.id, 'audioScript', e.target.value)}
                                      className="w-full min-h-[140px] rounded-2xl border border-zinc-800 bg-black/55 p-4 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-violet-500/80 transition-colors resize-y custom-scrollbar"
                                      placeholder="替這一幕補上更有角色聲音的旁白"
                                      disabled={isSubmitting}
                                    />
                                  </div>

                                  <div className="flex flex-col sm:flex-row gap-2">
                                    <button
                                      type="button"
                                      onClick={() => submitDraftSegments(true)}
                                      disabled={isSubmitting || draftSegments.length === 0}
                                      className="px-4 py-3 rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-300 font-semibold text-sm hover:bg-violet-500/15 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                                    >
                                      只重新評審
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => submitDraftSegments(false)}
                                      disabled={isSubmitting || draftSegments.length === 0 || !draftDirty}
                                      className="px-4 py-3 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed text-white font-semibold text-sm transition-colors cursor-pointer flex items-center justify-center gap-2"
                                    >
                                      {isSubmitting ? (
                                        <>
                                          儲存中
                                          <Loader2 className="w-4 h-4 animate-spin" />
                                        </>
                                      ) : (
                                        <>
                                          保存修改並接續生成
                                          <ChevronRight className="w-4 h-4" />
                                        </>
                                      )}
                                    </button>
                                  </div>
                                </>
                              ) : (
                                <div className="rounded-3xl border border-zinc-800 bg-zinc-950/40 p-6 text-sm text-zinc-500 leading-relaxed">
                                  尚未選到分鏡。請從左側點選一個段落，右側就會即時顯示預覽與編輯欄位。
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </motion.div>
                  ) : (
                    /* Default loader if brainstorming */
                    <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
                      <div className="w-12 h-12 border-2 border-violet-500/10 border-t-violet-500 rounded-full animate-spin" />
                      <div className="space-y-1">
                        <span className="text-sm font-medium text-zinc-400 block">連結平行宇宙...</span>
                        <p className="text-xs text-zinc-600 font-light">正在建立世界觀設定與編寫分鏡劇本...</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {activeJobId && !job && (
            <motion.div
              key="restoring"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="py-24 text-center space-y-4"
            >
              <Loader2 className="w-10 h-10 animate-spin text-violet-400 mx-auto" />
              <div>
                <p className="text-zinc-200 font-semibold text-lg">正在接續上次任務</p>
                <p className="text-zinc-500 text-sm mt-1">job {activeJobId} 正在重新載入進度...</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Footer Info */}
      <div className="mt-10 text-zinc-600 text-xs tracking-wider flex items-center gap-2">
        <span>Powered by Google Veo 3.1 & Gemini 2.5 Flash</span>
        <span className="text-zinc-800">•</span>
        <span>Stitched with FFmpeg Lossless Demuxer</span>
      </div>
    </main>
  );
}

interface StepItemProps {
  icon: React.ReactNode;
  label: string;
  status: 'pending' | 'active' | 'completed';
}

function StepItem({ icon, label, status }: StepItemProps) {
  return (
    <div className={`flex items-center gap-3.5 p-4 rounded-2xl transition-all border ${
      status === 'active' ? 'bg-violet-500/10 text-violet-400 border-violet-500/25 shadow-[0_0_20px_rgba(139,92,246,0.03)]' :
      status === 'completed' ? 'bg-emerald-500/5 text-emerald-400 border-emerald-500/15' :
      'bg-zinc-950/20 text-zinc-600 border-zinc-900/60'
    }`}>
      <span className={`w-9 h-9 rounded-xl flex items-center justify-center border transition-all ${
        status === 'active' ? 'bg-violet-500/10 border-violet-500/20 text-violet-400' :
        status === 'completed' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' :
        'bg-zinc-900/40 border-zinc-800/40 text-zinc-600'
      }`}>
        {status === 'completed' ? <CheckCircle2 className="w-5 h-5" /> : icon}
      </span>
      <div className="space-y-0.5">
        <span className="text-sm font-semibold tracking-wide block">{label}</span>
      </div>
      {status === 'active' && <Loader2 className="w-5 h-5 animate-spin ml-auto text-violet-400" />}
    </div>
  );
}
