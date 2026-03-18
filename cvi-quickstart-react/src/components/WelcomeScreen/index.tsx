import { useEffect, useRef, type CSSProperties, type MouseEvent } from 'react';

const defaultMousePosition = {
  '--mouse-x': '50%',
  '--mouse-y': '50%',
} as CSSProperties;

export const WelcomeScreen = ({ onStart, loading }: { onStart: () => void; loading: boolean }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const targetPositionRef = useRef({ x: 50, y: 50 });
  const currentPositionRef = useRef({ x: 50, y: 50 });

  useEffect(() => {
    const animate = () => {
      const container = containerRef.current;
      const currentPosition = currentPositionRef.current;
      const targetPosition = targetPositionRef.current;

      currentPosition.x += (targetPosition.x - currentPosition.x) *   1.00;
      currentPosition.y += (targetPosition.y - currentPosition.y) * 1.00;

      container?.style.setProperty('--mouse-x', `${currentPosition.x}%`);
      container?.style.setProperty('--mouse-y', `${currentPosition.y}%`);

      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    const { currentTarget, clientX, clientY } = event;
    const rect = currentTarget.getBoundingClientRect();
    targetPositionRef.current = {
      x: ((clientX - rect.left) / rect.width) * 100,
      y: ((clientY - rect.top) / rect.height) * 100,
    };
  };

  const handleMouseLeave = () => {
    targetPositionRef.current = { x: 50, y: 50 };
  };

  return (
    <div
      ref={containerRef}
      className="welcome-screen relative flex h-screen items-center justify-center overflow-hidden p-10"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={defaultMousePosition}
    >
      <div className="welcome-screen-background pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="welcome-screen-dots" />
        <div className="welcome-screen-dots welcome-screen-dots-secondary" />
        <div className="welcome-screen-spotlight" />
      </div>

      <div className="relative z-10 flex flex-col items-center gap-8">
        {/* Logo / avatar */}
        <div className="relative flex items-center justify-center">
          <div className="welcome-avatar-shell relative z-10 h-[100px] w-[100px] overflow-hidden rounded-full">
            <img src="acma-single.png" alt="ACMA" className="h-full w-full object-cover" />
          </div>
        </div>

        <div className="text-center">
          <h1 className="font-['DM_Sans'] text-3xl lg:text-4xl font-bold text-[#1B2559] mb-2">
            ACMA Demo
          </h1>
        </div>

        <button
          onClick={onStart}
          disabled={loading}
          className={`px-8 py-4 rounded-[12px] font-['DM_Sans'] font-semibold text-lg text-white transition-all ${
            loading
              ? 'bg-[#4318ff]/50 cursor-not-allowed'
              : 'bg-[#4318ff] hover:bg-[#3614cc] shadow-[0_4px_14px_rgba(67,24,255,0.4)] hover:shadow-[0_6px_20px_rgba(67,24,255,0.5)] active:scale-[0.98]'
          }`}
        >
          {loading ? (
            <span className="flex items-center gap-3">
              <div className="w-5 h-5 rounded-full border-2 border-white/40 border-t-white animate-spin" />
              Connecting...
            </span>
          ) : (
            'Start Conversation'
          )}
        </button>
      </div>
    </div>
  );
};
