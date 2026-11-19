import { useEffect, useMemo, useRef, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen, SquarePen } from 'lucide-react';

import { cn } from '@/lib/utils';
import { AvatarStage } from '@/components/gi/AvatarStage.jsx';
import { ChatHistory } from '@/components/gi/ChatHistory.jsx';
import { ChatList } from '@/components/gi/ChatList.jsx';
import { Composer } from '@/components/gi/Composer.jsx';
import { DisclaimerBanner } from '@/components/gi/DisclaimerBanner.jsx';
import { VoiceIndicator } from '@/components/gi/VoiceIndicator.jsx';
import { useGiChatEngine } from '@/hooks/useGiChatEngine.js';
import GpuWaitDialog from '@/components/GpuWaitDialog.jsx';
import { DismissibleNotice } from '@/components/FloatingNotice.jsx';
import { nextAudioErrorAction } from '@/hooks/liveConversation.js';

export default function GiChatPage() {
  const chat = useGiChatEngine();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileView, setMobileView] = useState('chat');
  const scrollViewportRef = useRef(null);
  const footerRef = useRef(null);
  const audioRef = useRef(null);
  const [footerHeight, setFooterHeight] = useState(0);

  useEffect(() => {
    document.title = 'GI Bleeding AI Medical Guide';
  }, []);

  const hasMessages = chat.messages.length > 0;
  const controlsBusy = chat.connecting || chat.responseBusy;

  const chatScrollKey = useMemo(
    () =>
      JSON.stringify({
        error: Boolean(chat.error),
        voice: chat.activeVoiceLabel,
      }),
    [chat.error, chat.activeVoiceLabel]
  );

  useEffect(() => {
    const footerElement = footerRef.current;
    const scrollViewportElement = scrollViewportRef.current;
    if (!footerElement || !scrollViewportElement || typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const updateFooterHeight = () => {
      const nextFooterHeight = footerElement.getBoundingClientRect().height;
      const distanceFromBottom =
        scrollViewportElement.scrollHeight
        - scrollViewportElement.scrollTop
        - scrollViewportElement.clientHeight;
      const pinnedToBottom = distanceFromBottom <= 96;
      setFooterHeight(nextFooterHeight);
      if (pinnedToBottom) {
        requestAnimationFrame(() => {
          scrollViewportElement.scrollTop = scrollViewportElement.scrollHeight;
        });
      }
    };

    updateFooterHeight();
    const observer = new ResizeObserver(updateFooterHeight);
    observer.observe(footerElement);
    return () => observer.disconnect();
  }, []);

  // Reply audio plays as a chain of clips that only advances on `ended`. This
  // mirrors pages/LivePage.jsx:3115-3142 exactly, including the retry-then-skip
  // recovery — without it, one clip failing to decode stalls the rest of the
  // reply and the voice silently cuts off mid-answer.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!chat.playbackReady) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      return;
    }
    if (audio.getAttribute('src') !== chat.audioSrc) {
      audio.src = chat.audioSrc;
      audio.load();
    }
    audio.play().catch(() => {});
  }, [chat.audioSrc, chat.selectedReplyId, chat.playbackReady]);

  const audioErrorStateRef = useRef({ src: '', retried: false });

  function handleAudioError() {
    const audio = audioRef.current;
    // Ignore errors that aren't from an active reply clip — clearing the src
    // during teardown fires an error on an empty element.
    if (!audio || chat.phase !== 'speaking') return;
    const { action, retryState } = nextAudioErrorAction(audioErrorStateRef.current, chat.audioSrc);
    audioErrorStateRef.current = retryState;
    if (action === 'retry') {
      try {
        audio.load();
        audio.play().catch(() => { chat.onAudioEnded(); });
      } catch {
        chat.onAudioEnded();
      }
    } else if (action === 'skip') {
      chat.onAudioEnded();
    }
  }

  const composer = (
    <Composer
      disabled={controlsBusy || !chat.voiceReady}
      loading={chat.connecting}
      active={chat.voiceActive}
      onStart={chat.startConversation}
      onStop={chat.stopConversation}
      micMuted={chat.micMuted}
      onToggleMute={chat.toggleMute}
      playbackReady={chat.playbackReady}
      onStopVoice={chat.stopVoicePlayback}
      onSendText={chat.sendText}
      canSendText={chat.canSendText}
    />
  );

  return (
    // 100dvh, not 100vh: on iOS Safari `vh` is the toolbars-retracted height and
    // never shrinks for the on-screen keyboard, so the composer dropped below
    // the fold exactly when someone opened the keyboard to type. LessonPage
    // already switched for the same reason.
    <div className="gi-root relative flex h-[100dvh] overflow-hidden bg-surface text-ink">
      <div className="flex min-h-0 flex-1 flex-row">
        {sidebarOpen && (
          <div
            onClick={() => setSidebarOpen(false)}
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
          />
        )}

        <aside
          className={cn(
            'z-50 shrink-0 border-r border-slate-200 bg-white transition-all duration-300',
            sidebarOpen
              ? 'fixed inset-y-0 left-0 flex w-64 flex-col p-3 lg:relative lg:z-0 lg:block lg:bg-white/60'
              : 'hidden lg:flex lg:w-14 lg:flex-col lg:items-center lg:gap-2 lg:px-2 lg:py-3'
          )}
        >
          {sidebarOpen ? (
            <>
              <button
                type="button"
                aria-label="Hide chat history"
                onClick={() => setSidebarOpen(false)}
                className="absolute right-2 top-2 rounded-lg p-2 text-ink-muted transition hover:bg-slate-100 hover:text-ink"
              >
                <PanelLeftClose className="size-5" />
              </button>

              <ChatHistory
                onNewChat={() => {
                  chat.newChat();
                  setSidebarOpen(false);
                }}
              />
            </>
          ) : (
            <>
              <button
                type="button"
                aria-label="Show chat history"
                onClick={() => setSidebarOpen(true)}
                className="rounded-lg p-2 text-ink-muted transition hover:bg-slate-100 hover:text-ink"
              >
                <PanelLeftOpen className="size-5" />
              </button>
              <button
                type="button"
                aria-label="New chat"
                onClick={chat.newChat}
                className="mt-2 rounded-lg p-2 text-ink-muted transition hover:bg-slate-100 hover:text-ink"
              >
                <SquarePen className="size-5" />
              </button>
            </>
          )}
        </aside>

        <div className="flex min-h-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white/60 px-4 backdrop-blur-sm lg:px-6">
            <div className="flex min-w-0 items-center gap-3">
              {!sidebarOpen && (
                <button
                  type="button"
                  onClick={() => setSidebarOpen(true)}
                  aria-label="Show chat history"
                  className="rounded-lg p-1.5 text-ink-muted transition hover:bg-slate-100 hover:text-ink lg:hidden"
                >
                  <PanelLeftOpen className="size-5" />
                </button>
              )}
              <h1 className="hidden truncate text-base font-semibold text-black lg:block">
                GI Bleeding Chatbot
              </h1>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {/* No Voice/Text mode toggle: typing and the mic are both live in
                  the composer at once, so nobody has to pick a mode before
                  they can ask anything. */}
              <div className="flex shrink-0 rounded-full bg-slate-100 p-1 lg:hidden">
                <button
                  type="button"
                  onClick={() => setMobileView('chat')}
                  className={cn(
                    'rounded-full px-3 py-1 text-xs font-semibold transition',
                    mobileView === 'chat' ? 'bg-white text-black shadow' : 'text-ink-muted hover:text-ink'
                  )}
                >
                  Chat
                </button>
                <button
                  type="button"
                  onClick={() => setMobileView('avatar')}
                  className={cn(
                    'rounded-full px-3 py-1 text-xs font-semibold transition',
                    mobileView === 'avatar' ? 'bg-white text-black shadow' : 'text-ink-muted hover:text-ink'
                  )}
                >
                  Avatar
                </button>
              </div>
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <section
              className={cn(
                'min-h-0 flex-col items-center justify-center',
                mobileView === 'avatar'
                  ? 'absolute inset-x-0 bottom-0 top-14 z-10 flex bg-surface p-0'
                  : 'hidden',
                'lg:relative lg:inset-auto lg:top-auto lg:z-0 lg:flex lg:flex-1 lg:justify-center lg:border-b-0 lg:bg-transparent lg:p-6'
              )}
            >
              <div
                className={cn(
                  'w-full',
                  mobileView === 'avatar' ? 'h-full' : 'max-w-[160px] sm:max-w-[240px]',
                  'lg:aspect-[4/3] lg:h-auto lg:max-w-md'
                )}
              >
                <AvatarStage status={chat.status} fullScreen={mobileView === 'avatar'} />
              </div>

              {mobileView === 'avatar' && (
                <div className="absolute bottom-6 left-4 right-4 z-20 lg:hidden">{composer}</div>
              )}

              <div className="mt-4 hidden space-y-1 text-center lg:block">
                <h2 className="text-lg font-semibold">GI Bleeding Chatbot</h2>
                <p className="mx-auto max-w-sm text-sm text-ink-muted">
                  Ask me about GI bleeding education material. Tap the mic and just speak, or type
                  your question if you have no microphone — either way I'll answer out loud.
                </p>
              </div>
            </section>

            <main
              className={cn(
                'flex min-h-0 w-full flex-col border-slate-200 bg-white/40 lg:w-[48%] lg:flex-none lg:border-l',
                mobileView === 'avatar' ? 'hidden lg:flex' : 'flex-1'
              )}
            >
              <DisclaimerBanner />

              <div
                ref={scrollViewportRef}
                className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
                style={{ paddingBottom: `${footerHeight + 16}px` }}
              >
                {hasMessages ? (
                  <ChatList
                    messages={chat.messages}
                    status={chat.status}
                    scrollKey={chatScrollKey}
                    speakingMessageId={chat.speakingMessageId}
                    onPlay={chat.playReply}
                  />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                    <p className="text-sm text-ink-muted">
                      Start a conversation — click the mic, or type your question
                    </p>
                  </div>
                )}
              </div>

              <div ref={footerRef} className="shrink-0 bg-white/40">
                {/* A capacity wait is an advisory, not an interruption, so it
                    goes out amber and on the polite 'status' channel — 'alert'
                    cuts across whatever a student's screen reader is saying. */}
                <GpuWaitDialog wait={chat.capacityWait} />
                <DismissibleNotice notice={chat.capacityBusy} />
                {chat.error && (
                  <p
                    className={cn(
                      'px-4 pb-2 text-center text-xs',
                      chat.errorTone === 'waiting' ? 'text-amber-600' : 'text-red-600',
                    )}
                    role={chat.errorTone === 'waiting' ? 'status' : 'alert'}
                  >
                    {chat.error}
                  </p>
                )}

                {!chat.connecting && !chat.voiceReady && !chat.voiceMismatch && (
                  <p className="px-4 pb-2 text-center text-xs text-amber-600">
                    {'No cloned voice is set up yet. Activate a voice profile before starting a conversation.'}
                  </p>
                )}

                {chat.notice && (
                  <p className="px-4 pb-2 text-center text-xs text-amber-600">{chat.notice}</p>
                )}

                {chat.activeVoiceLabel && (
                  <div className="px-4 pb-2">
                    <div className="flex flex-wrap items-center justify-center gap-3">
                      <VoiceIndicator label={chat.activeVoiceLabel} />
                    </div>
                  </div>
                )}

                <div className="px-4 pb-4 pt-2">{composer}</div>
              </div>
            </main>
          </div>
        </div>
      </div>

      {/* Cloned-voice playback. Driven imperatively — see the effect above. */}
      <audio ref={audioRef} className="hidden" onEnded={chat.onAudioEnded} onError={handleAudioError} />
    </div>
  );
}
