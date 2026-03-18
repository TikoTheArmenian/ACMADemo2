export const WelcomeScreen = ({ onStart, loading }: { onStart: () => void; loading: boolean }) => {
  return (
    <div className="flex flex-col items-center justify-center h-screen gap-8 p-10">
      {/* Logo / avatar */}
      <div className="w-[100px] h-[100px] rounded-full bg-[#4318ff]/10 flex items-center justify-center border-2 border-[#4318ff]/20 overflow-hidden">
      <img src="acma-single.png" alt="ACMA" className="h-full w-full object-cover" />
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
  );
};
