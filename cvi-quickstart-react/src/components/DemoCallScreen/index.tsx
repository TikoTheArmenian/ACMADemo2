import { useEffect, useState, useRef, useCallback } from 'react'
import {
  useDaily,
  useParticipantIds,
  useLocalSessionId,
  useDailyEvent,
  DailyVideo,
  DailyAudio,
} from '@daily-co/daily-react'
import { Mic, MicOff } from 'lucide-react'
import { IConversation } from '@/types'

// ---------------------------------------------------------------------------
// Audio utilities — convert mp3 files to base64 PCM for Tavus echo
// ---------------------------------------------------------------------------

const RESPONSE_URLS = Array.from({ length: 6 }, (_, i) => `/response_${i + 1}.mp3`)

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode.apply(null, Array.from(slice))
  }
  return btoa(binary)
}

/** Decode mp3 → 24 kHz mono 16-bit PCM → split into ~5-second base64 chunks */
async function prepareAudioChunks(url: string): Promise<string[]> {
  const resp = await fetch(url)
  const buf = await resp.arrayBuffer()

  const ctx = new AudioContext({ sampleRate: 24000 })
  const decoded = await ctx.decodeAudioData(buf)
  await ctx.close()

  const floats = decoded.getChannelData(0)
  const pcm = new Int16Array(floats.length)
  for (let i = 0; i < floats.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(floats[i] * 32767)))
  }

  // ~5-second chunks (24000 Hz × 2 bytes × 5 s = 240 000 bytes)
  const bytes = new Uint8Array(pcm.buffer)
  const CHUNK_BYTES = 240_000
  const chunks: string[] = []
  for (let off = 0; off < bytes.length; off += CHUNK_BYTES) {
    chunks.push(uint8ToBase64(bytes.slice(off, Math.min(off + CHUNK_BYTES, bytes.length))))
  }
  return chunks
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const DemoCallScreen = ({
  conversation,
  onEnd,
}: {
  conversation: IConversation
  onEnd: () => void
}) => {
  const daily = useDaily()
  const remoteIds = useParticipantIds({ filter: 'remote' })
  const localId = useLocalSessionId()

  // UI state
  const [isConnected, setIsConnected] = useState(false)
  const [isMicMuted, setIsMicMuted] = useState(false)
  const [isReplicaSpeaking, setIsReplicaSpeaking] = useState(false)
  const [isUserSpeaking, setIsUserSpeaking] = useState(false)
  const [responseIndex, setResponseIndex] = useState(0)
  const [audioReady, setAudioReady] = useState(false)
  const [showLoadingOverlay, setShowLoadingOverlay] = useState(true)
  const [loadingFading, setLoadingFading] = useState(false)
  const [loadingStage, setLoadingStage] = useState<'connecting' | 'preparing' | 'ready'>('connecting')
  const [isEnding, setIsEnding] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [showMutedPopup, setShowMutedPopup] = useState(false)

  // Refs (stable across callbacks)
  const dailyRef = useRef(daily)
  const responseIndexRef = useRef(0)
  const isPlayingRef = useRef(false)
  const audioChunksRef = useRef<string[][]>([])
  const speechTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const micAnalyserRef = useRef<AnalyserNode | null>(null)
  const micPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const micCtxRef = useRef<AudioContext | null>(null)

  useEffect(() => { dailyRef.current = daily }, [daily])

  // ---- Preload all audio files into PCM chunks ----
  useEffect(() => {
    ;(async () => {
      try {
        audioChunksRef.current = await Promise.all(RESPONSE_URLS.map(prepareAudioChunks))
        setAudioReady(true)
        console.log('Audio preloaded:', audioChunksRef.current.map((c) => c.length + ' chunks'))
      } catch (err) {
        console.error('Audio preload failed:', err)
      }
    })()
  }, [])

  // ---- Join Daily.co room ----
  useEffect(() => {
    if (conversation && daily) {
      daily.join({ url: conversation.conversation_url })
    }
  }, [daily, conversation])

  // ---- Handle join (echo/BYOA mode — no LLM) ----
  useDailyEvent(
    'joined-meeting',
    useCallback(() => {
      setIsConnected(true)
      setLoadingStage('preparing')
      setTimeout(() => {
        setLoadingStage('ready')
        setTimeout(() => {
          setLoadingFading(true)
          setShowLoadingOverlay(false)
        }, 800)
      }, 1500)
    }, []),
  )

  // ---- Timer ----
  useEffect(() => {
    if (!isConnected) return
    const id = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [isConnected])

  // ---- Listen for Tavus replica speaking events ----
  useDailyEvent(
    'app-message',
    useCallback((event: { data?: Record<string, unknown> }) => {
      const data = event?.data
      if (!data) return

      if (data.event_type === 'conversation.replica.started_speaking') {
        setIsReplicaSpeaking(true)
      }
      if (data.event_type === 'conversation.replica.stopped_speaking') {
        setIsReplicaSpeaking(false)
        isPlayingRef.current = false
      }
    }, []),
  )

  // ---- Detect user speech by polling local mic audio levels ----
  // In BYOA/echo mode there's no STT pipeline, so Tavus events don't fire.
  // active-speaker-change is also unreliable with a silent replica.
  // Instead we tap the local mic track directly with an AnalyserNode.
  useEffect(() => {
    if (!isConnected || !daily) return

    let cancelled = false

    const setup = async () => {
      // Get the local audio track from Daily
      const participants = daily.participants()
      const localTrack = participants?.local?.tracks?.audio?.persistentTrack
      if (!localTrack) {
        console.warn('No local audio track yet — retrying in 1 s')
        setTimeout(() => { if (!cancelled) setup() }, 1000)
        return
      }

      const ctx = new AudioContext()
      if (ctx.state === 'suspended') {
        console.warn('AudioContext suspended — resuming')
        await ctx.resume()
      }
      console.log('Mic AudioContext state:', ctx.state)
      const source = ctx.createMediaStreamSource(new MediaStream([localTrack]))
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      micAnalyserRef.current = analyser
      micCtxRef.current = ctx

      const buf = new Uint8Array(analyser.frequencyBinCount)
      const SPEECH_THRESHOLD = 30 // 0-255, tune if needed
      let speaking = false
      let hasSpoken = false

      // Poll audio levels every 150 ms
      micPollRef.current = setInterval(() => {
        analyser.getByteFrequencyData(buf)
        const avg = buf.reduce((a, b) => a + b, 0) / buf.length
        const nowSpeaking = avg > SPEECH_THRESHOLD

        if (nowSpeaking) {
          speaking = true
          hasSpoken = true
          setIsUserSpeaking(true)
          // Reset silence timer on every speaking frame
          if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current)
          speechTimeoutRef.current = null
        } else if (speaking) {
          // Just went quiet — start the silence countdown
          speaking = false
          setIsUserSpeaking(false)
          if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current)
          speechTimeoutRef.current = setTimeout(() => {
            if (!isPlayingRef.current && hasSpoken) {
              console.log('User stopped speaking — triggering next response')
              triggerRef.current()
              hasSpoken = false
            }
          }, 250)
        }
      }, 150)
    }

    setup()

    return () => {
      cancelled = true
      if (micPollRef.current) clearInterval(micPollRef.current)
      if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current)
      micCtxRef.current?.close()
    }
  }, [isConnected, daily])

  // ---- Send pre-recorded audio via echo (no delays between chunks) ----
  const triggerNextResponse = useCallback(() => {
    const idx = responseIndexRef.current
    const d = dailyRef.current
    const chunks = audioChunksRef.current[idx]
    if (!d || !chunks || idx >= RESPONSE_URLS.length || isPlayingRef.current) return

    isPlayingRef.current = true
    setIsReplicaSpeaking(true)

    // Fire all chunks immediately — Tavus buffers them server-side
    for (let i = 0; i < chunks.length; i++) {
      d.sendAppMessage(
        {
          message_type: 'conversation',
          event_type: 'conversation.echo',
          conversation_id: conversation.conversation_id,
          properties: {
            modality: 'audio',
            audio: chunks[i],
            sample_rate: 24000,
            inference_id: `response-${idx}`,
            done: i === chunks.length - 1 ? 'true' : 'false',
          },
        },
        '*',
      )
    }

    responseIndexRef.current += 1
    setResponseIndex(responseIndexRef.current)
  }, [conversation.conversation_id])

  // Stable ref so callbacks can always call the latest version
  const triggerRef = useRef(triggerNextResponse)
  useEffect(() => { triggerRef.current = triggerNextResponse }, [triggerNextResponse])

  // ---- Controls ----
  const handleForceTurn = () => {
    if (!isPlayingRef.current && responseIndexRef.current < RESPONSE_URLS.length && audioReady) {
      triggerNextResponse()
    }
  }

  const toggleMic = () => {
    if (!daily || !isConnected) return
    const next = !isMicMuted
    daily.setLocalAudio(!next)
    setIsMicMuted(next)
    if (next) {
      setShowMutedPopup(true)
      setTimeout(() => setShowMutedPopup(false), 4000)
    }
  }

  const handleEndCall = async () => {
    setIsEnding(true)
    await dailyRef.current?.leave()
    onEnd()
  }

  const fmt = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`

  const loadingText =
    loadingStage === 'connecting'
      ? 'Connecting'
      : loadingStage === 'preparing'
        ? 'Preparing session'
        : 'Ready'

  const hasRemoteVideo = remoteIds.length > 0

  // ---- Render ----
  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[#f8fafb]">
      {/* ── ACMA Header (school-28 style) ────────────────────────── */}
      <div className="shrink-0 px-6 pt-4 pb-2">
        <div className="flex flex-row justify-between items-center max-w-[1200px] mx-auto w-full">
          <div className="flex items-center gap-4">
            <img src="/acma-single.png" alt="ACMA" className="h-10 w-10 object-contain" />
            <div>
              <div className="font-['DM_Sans'] text-sm text-[#A3AED0] font-medium">Welcome</div>
              <div className="font-['DM_Sans'] text-2xl font-bold text-[#2B3674]">Simulation</div>
            </div>
          </div>
          <img src="/ACMA.png" alt="ACMA" className="h-10 object-contain" />
        </div>
      </div>

      {/* ── Main video area ──────────────────────────────────────── */}
      <div className="flex-1 min-h-0 px-4 pb-4">
        <div className="relative w-full h-full mx-auto" style={{ maxWidth: '1200px' }}>
          {/* Outer white card */}
          <div className="relative w-full h-full bg-white rounded-[18px] border border-[#CACDD2] shadow-[0_24px_32px_-12px_rgba(18,19,20,0.10)] overflow-hidden 2xl:p-[17.4px] xl:p-[12px] lg:p-[10px] md:p-[6px] p-[10px]">
            <div className="relative w-full h-full pb-[20px]">
              {/* Video container — border lights up when replica is speaking */}
              <div
                className={`relative h-full bg-[#1a1a2e] rounded-[16px] border-2 overflow-hidden transition-colors duration-300 ${
                  isReplicaSpeaking
                    ? 'border-[#4318ff]'
                    : isConnected && !isMicMuted
                      ? 'border-[#ffffff]'
                      : 'border-transparent'
                }`}
              >
                {/* ── Remote avatar video ──────────────────────── */}
                <div className={`w-full h-full ${hasRemoteVideo ? 'block' : 'hidden'}`}>
                  <DailyVideo
                    sessionId={remoteIds[0]}
                    type="video"
                    className="block w-full h-full object-cover"
                  />
                </div>

                {/* Fallback while waiting for video */}
                <div
                  className={`w-full h-full ${hasRemoteVideo ? 'hidden' : 'flex'} items-center justify-center bg-gradient-to-br from-[#1a1a2e] to-[#2d2b55]`}
                >
                  <div className="w-[140px] h-[140px] rounded-full bg-[#4318ff]/20 flex items-center justify-center border-2 border-[#4318ff]/30">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#4318ff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                      <circle cx="12" cy="7" r="4" />
                    </svg>
                  </div>
                </div>

                {/* ── Loading overlay ──────────────────────────── */}
                {(showLoadingOverlay || loadingFading) && (
                  <div
                    className={`absolute inset-0 z-30 flex flex-col items-center justify-center bg-gradient-to-br from-[#f0edff] to-[#e8e4ff] rounded-[16px] ${
                      loadingFading ? 'animate-tavus-fade-out pointer-events-none' : ''
                    }`}
                    onAnimationEnd={() => {
                      if (loadingFading) setLoadingFading(false)
                    }}
                  >
                    <div className="relative mb-8">
                      <div className="w-[120px] h-[120px] rounded-full overflow-hidden border-[3px] border-[#4318ff]/20 shadow-lg bg-[#4318ff]/10 flex items-center justify-center">
                        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#4318ff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                          <circle cx="12" cy="7" r="4" />
                        </svg>
                      </div>
                      {loadingStage === 'ready' && (
                        <div className="absolute -bottom-1 -right-1 w-[32px] h-[32px] rounded-full bg-[#4318ff] flex items-center justify-center shadow-md animate-fade-in">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                            <path d="M5 13l4 4L19 7" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </div>
                      )}
                    </div>
                    <p className="font-['DM_Sans'] font-semibold text-[20px] text-[#1B2559] mb-1">
                      Demo Case Manager
                    </p>
                    <div className="flex items-center gap-1.5 mb-5">
                      <span className="font-['DM_Sans'] font-medium text-[15px] text-[#4318ff]">
                        {loadingText}
                      </span>
                      {loadingStage !== 'ready' && (
                        <>
                          <span className="w-1.5 h-1.5 rounded-full bg-[#4318ff] animate-tavus-dots-1" />
                          <span className="w-1.5 h-1.5 rounded-full bg-[#4318ff] animate-tavus-dots-2" />
                          <span className="w-1.5 h-1.5 rounded-full bg-[#4318ff] animate-tavus-dots-3" />
                        </>
                      )}
                    </div>
                    <div className="w-[260px] h-[5px] bg-[#4318ff]/10 rounded-full overflow-hidden">
                      {loadingStage === 'ready' ? (
                        <div className="h-full w-full bg-[#4318ff] rounded-full transition-all duration-500 ease-out" />
                      ) : (
                        <div className="h-full bg-[#4318ff] rounded-full animate-tavus-progress" />
                      )}
                    </div>
                  </div>
                )}

                {/* ── Ending session overlay ───────────────────── */}
                {isEnding && (
                  <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-gradient-to-br from-[#f0edff] to-[#e8e4ff] rounded-[16px]">
                    <div className="w-[24px] h-[24px] rounded-full border-2 border-[#4318ff]/40 border-t-[#4318ff] animate-spin" />
                    <p className="font-['DM_Sans'] font-medium text-[16px] text-[#4318ff]/70 mt-4">
                      Ending session
                    </p>
                  </div>
                )}

                {/* ── Patient name tag — top left ──────────────── */}
                <div className="absolute top-[13px] left-[13px] z-10 bg-[#4318ff] flex items-center gap-[4px] px-[8px] py-[4px] rounded-[8px]">
                  <p className="font-['DM_Sans'] font-medium text-[22px] leading-[20px] tracking-[-0.88px] text-[#eff0fa] text-center">
                    Demo Case Manager
                  </p>
                </div>

                {/* ── LIVE indicator + Timer — top right ────────── */}
                <div className="absolute top-[19px] right-[13px] z-10">
                  <div className="flex items-center border border-white rounded-[8px] px-[12px] py-[8px] bg-black/30 overflow-hidden">
                    <div className="w-[16px] h-[16px] flex items-center justify-center shrink-0">
                      <div className="w-[10px] h-[10px] rounded-full bg-red-500 animate-pulse" />
                    </div>
                    <div className="flex items-baseline gap-[8px] px-[8px] text-[18px] leading-[24px] text-center text-white min-w-[110px]">
                      <span className="font-['DM_Sans'] font-semibold tracking-[-0.36px]">LIVE</span>
                      <span className="font-['DM_Sans'] font-normal tracking-[0.5px]">{fmt(seconds)}</span>
                    </div>
                  </div>
                </div>

                {/* ── Control buttons — bottom center ──────────── */}
                <div className="absolute bottom-[10px] lg:bottom-[14px] xl:bottom-[16px] left-1/2 -translate-x-1/2 z-10 flex items-center gap-[6px] lg:gap-[8px] xl:gap-[10px]">
                  {/* Mic toggle */}
                  <button
                    onClick={toggleMic}
                    disabled={!isConnected}
                    className={`w-[44px] h-[44px] lg:w-[56px] lg:h-[56px] xl:w-[66px] xl:h-[66px] rounded-[12px] lg:rounded-[16px] xl:rounded-[18px] flex items-center justify-center border overflow-hidden transition-all ${
                      !isConnected
                        ? 'bg-[#94a3b8] border-[#94a3b8] cursor-not-allowed'
                        : isMicMuted
                          ? 'bg-[rgba(129,129,129,0.3)] border-[#b7b7b7] shadow-[inset_0_1px_1px_rgba(255,255,255,0.2),0_2px_8px_rgba(0,0,0,0.2)] hover:brightness-110 active:brightness-90'
                          : 'bg-[rgba(67,24,255,0.7)] border-[#4318ff] shadow-[inset_0_1px_1px_rgba(255,255,255,0.3),0_2px_8px_rgba(67,24,255,0.4)] hover:brightness-110 active:brightness-90'
                    }`}
                  >
                    {isMicMuted ? (
                      <MicOff className="w-[16px] h-[16px] lg:w-[20px] lg:h-[20px] xl:w-[24px] xl:h-[24px] text-white" />
                    ) : (
                      <Mic className="w-[16px] h-[16px] lg:w-[20px] lg:h-[20px] xl:w-[24px] xl:h-[24px] text-white" />
                    )}
                  </button>

                  {/* Force respond — triggers next pre-recorded response */}
                  <button
                    onClick={handleForceTurn}
                    disabled={!isConnected || isReplicaSpeaking || responseIndex >= RESPONSE_URLS.length || !audioReady}
                    className={`w-[44px] h-[44px] lg:w-[56px] lg:h-[56px] xl:w-[66px] xl:h-[66px] rounded-[12px] lg:rounded-[16px] xl:rounded-[18px] flex items-center justify-center border overflow-hidden transition-all ${
                      !isConnected || isReplicaSpeaking || responseIndex >= RESPONSE_URLS.length
                        ? 'bg-[#94a3b8] border-[#94a3b8] cursor-not-allowed opacity-50'
                        : 'bg-[rgba(129,129,129,0.3)] border-[#b7b7b7] shadow-[inset_0_1px_1px_rgba(255,255,255,0.2),0_2px_8px_rgba(0,0,0,0.2)] hover:brightness-110 active:scale-95 active:bg-[rgba(67,24,255,0.7)] active:border-[#4318ff] active:shadow-[inset_0_1px_1px_rgba(255,255,255,0.3),0_2px_8px_rgba(67,24,255,0.4)]'
                    }`}
                  >
                    <svg viewBox="0 0 45 45" fill="none" className="w-[28px] h-[28px] lg:w-[34px] lg:h-[34px] xl:w-[36px] xl:h-[36px]">
                      <circle cx="13" cy="12" r="7" fill="white" />
                      <path d="M5 38C5 31 8 26 13 26C18 26 21 31 21 38" stroke="white" strokeWidth="3" fill="none" />
                      <path d="M32 10C34 12 35 15 35 18C35 21 34 24 32 26" stroke="white" strokeWidth="2.5" strokeLinecap="round" fill="none" />
                      <path d="M28 14C29 15.5 29.5 17 29.5 18.5C29.5 20 29 21.5 28 23" stroke="white" strokeWidth="2.5" strokeLinecap="round" fill="none" />
                    </svg>
                  </button>

                  {/* End call */}
                  <button
                    onClick={handleEndCall}
                    disabled={!isConnected}
                    className={`w-[44px] h-[44px] lg:w-[56px] lg:h-[56px] xl:w-[66px] xl:h-[66px] rounded-[12px] lg:rounded-[16px] xl:rounded-[18px] flex items-center justify-center border-2 overflow-hidden transition-all ${
                      !isConnected
                        ? 'bg-[#94a3b8] border-[#94a3b8] cursor-not-allowed'
                        : 'bg-[rgba(216,81,64,0.8)] border-[#d85140] shadow-[inset_0_1px_1px_rgba(255,255,255,0.25),0_2px_8px_rgba(216,81,64,0.4)] hover:brightness-110 active:brightness-90'
                    }`}
                  >
                    <svg viewBox="0 0 30 14" fill="none" className="w-[18px] h-[9px] lg:w-[22px] lg:h-[11px] xl:w-[24px] xl:h-[12px]">
                      <path d="M8.87842 9.58586V8.67364C8.87842 8.67364 8.87842 6.505 14.7974 6.505C20.7163 6.505 20.7163 8.67364 20.7163 8.67364V9.24812C20.7163 10.6631 21.7857 11.8658 23.2322 12.078L26.1917 12.5113C27.9824 12.7741 29.5947 11.4333 29.5947 9.68138V6.53737C29.5947 5.6693 29.3224 4.81542 28.6627 4.22592C26.9754 2.71863 22.8187 0 14.7974 0C6.29066 0 2.13084 3.82189 0.652683 5.60617C0.184692 6.17121 0 6.88382 0 7.60748V10.4531C0 12.3732 1.91693 13.7487 3.81731 13.1923L6.77678 12.325C8.02528 11.9589 8.87842 10.8469 8.87842 9.58586Z" fill="white" />
                    </svg>
                  </button>
                </div>

                {/* ── "You are muted" popup ────────────────────── */}
                {showMutedPopup && (
                  <div className="absolute bottom-[62px] lg:bottom-[78px] xl:bottom-[90px] left-1/2 -translate-x-1/2 z-20 animate-fadeInOut">
                    <div className="flex items-center gap-2 bg-black/80 px-4 py-2.5 rounded-full">
                      <MicOff className="w-4 h-4 text-red-400" />
                      <span className="font-['DM_Sans'] font-medium text-sm text-white whitespace-nowrap">
                        You are muted
                      </span>
                    </div>
                  </div>
                )}

                {/* ── PIP user camera — bottom right ───────────── */}
                {localId && (
                  <div
                    className={`absolute bottom-[10px] right-[10px] lg:bottom-[12px] lg:right-[12px] xl:bottom-[14px] xl:right-[14px] z-10 w-[120px] h-[77px] lg:w-[160px] lg:h-[103px] xl:w-[200px] xl:h-[128px] rounded-[10px] lg:rounded-[12px] xl:rounded-[22px] overflow-hidden bg-black/40 border-2 transition-colors duration-300 ${
                      isUserSpeaking && !isMicMuted ? 'border-[#4318ff]' : 'border-transparent'
                    }`}
                  >
                    <DailyVideo
                      sessionId={localId}
                      type="video"
                      automirror
                      className="block w-full h-full object-cover"
                    />
                    <div className="absolute bottom-[4px] left-[4px] lg:bottom-[6px] lg:left-[6px] xl:bottom-[6px] xl:left-[6px] bg-black/65 px-[4px] py-[2px] lg:px-[6px] lg:py-[3px] xl:px-[7px] xl:py-[3px] rounded-[4px] lg:rounded-[6px] xl:rounded-[6px] flex items-center gap-[3px] lg:gap-[4px] xl:gap-[5px]">
                      <span className="font-['DM_Sans'] font-semibold text-[9px] lg:text-[11px] xl:text-[12px] leading-[14px] lg:leading-[16px] xl:leading-[18px] tracking-[-0.36px] text-[#eff0fa]">
                        Case Manager
                      </span>
                      {isMicMuted && (
                        <MicOff className="w-[9px] h-[9px] lg:w-[11px] lg:h-[11px] xl:w-[12px] xl:h-[12px] text-red-400 shrink-0" />
                      )}
                    </div>
                  </div>
                )}

                {/* ── Audio-only speaking indicator (when no video) */}
                {isReplicaSpeaking && !hasRemoteVideo && (
                  <div className="absolute inset-0 z-20 flex items-end justify-center pointer-events-none pb-32">
                    <div className="flex items-center gap-1.5 bg-[#4318FF]/80 px-4 py-2 rounded-full">
                      <div className="flex gap-1 items-end h-4">
                        <div className="w-1 bg-white rounded-full animate-soundbar" style={{ height: '60%' }} />
                        <div className="w-1 bg-white rounded-full animate-soundbar" style={{ height: '100%', animationDelay: '0.15s' }} />
                        <div className="w-1 bg-white rounded-full animate-soundbar" style={{ height: '40%', animationDelay: '0.3s' }} />
                        <div className="w-1 bg-white rounded-full animate-soundbar" style={{ height: '80%', animationDelay: '0.45s' }} />
                      </div>
                      <span className="text-white text-xs font-medium ml-1">Speaking</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* DailyAudio — plays the avatar's echo speech */}
      <DailyAudio />
    </div>
  )
}
