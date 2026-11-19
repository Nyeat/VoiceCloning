import { useRef } from 'react';
import { ArrowDown } from 'lucide-react';

import { ChatList } from './ChatList.jsx';
import { Composer } from './Composer.jsx';
import { DisclaimerBanner } from './DisclaimerBanner.jsx';
import { VoiceIndicator } from './VoiceIndicator.jsx';
import { useGiChatEngine } from '@/hooks/useGiChatEngine.js';
import GpuWaitDialog from '@/components/GpuWaitDialog.jsx';
import { DismissibleNotice } from '@/components/FloatingNotice.jsx';
import { useGiReplyAudio } from '@/hooks/useGiReplyAudio.js';
import { useStickToBottom } from '@/hooks/useStickToBottom.js';
import { chatGrowthKey } from '@/lib/chatScroll';

const EMPTY_HINT = 'Start a conversation — click the mic, or type your question';

/**
 * The gi chat surface (messages + notices + voice composer), driven by the
 * cloned-voice engine. Used inside the lesson page's chatbot tab.
 *
 * `lessonContext` (optional) is the timestamped lesson-video prompt section, so
 * the assistant can answer questions about moments in the video the student is
 * watching, and `getVideoPosition` (optional) reports where that video is now.
 * The standalone kiosk page omits both.
 */
export function GiChatPanel({
  emptyHint = EMPTY_HINT,
  lessonContext = '',
  lessonSlug = 'gi-bleeding',
  voiceProfileId = '',
  category,
  getVideoPosition = null,
  onUserQuestion = null,
}) {
  const chat = useGiChatEngine({
    lessonContext,
    lessonSlug,
    voiceProfileId,
    category,
    getVideoPosition,
    onUserQuestion,
  });
  const audioProps = useGiReplyAudio(chat);

  // The panel is short inside the lesson page, so a reply that streams in while
  // the student is reading has to bring itself into view — otherwise every
  // answer means scrolling by hand.
  const viewportRef = useRef(null);
  const { pinned, scrollToBottom } = useStickToBottom(
    viewportRef,
    chatGrowthKey(chat.messages, chat.status)
  );

  const hasMessages = chat.messages.length > 0;
  const controlsBusy = chat.connecting || chat.responseBusy;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <DisclaimerBanner />

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={viewportRef}
          className="lesson-transcript-scrollbar min-h-0 flex-1 overscroll-contain overflow-y-auto px-3 py-3 sm:px-4"
        >
          {hasMessages ? (
            <ChatList
              messages={chat.messages}
              status={chat.status}
              speakingMessageId={chat.speakingMessageId}
              onPlay={chat.playReply}
              autoScroll={false}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
              <p className="text-xs text-ink-muted">{emptyHint}</p>
            </div>
          )}
        </div>

        {hasMessages && !pinned && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-slate-200 bg-white/95 px-3 py-1.5 text-[11px] font-semibold text-slate-600 shadow-md backdrop-blur transition hover:border-slate-300 hover:text-slate-900 cursor-pointer"
          >
            <ArrowDown className="size-3.5" />
            Jump to latest
          </button>
        )}
      </div>

      <div className="shrink-0 border-t border-slate-100">
        {chat.error && (
          <p className="px-4 pt-2 text-center text-xs text-red-600" role="alert">
            {chat.error}
          </p>
        )}

        {!chat.connecting && !chat.voiceReady && !chat.voiceMismatch && !chat.notice && (
          <p className="px-4 pt-2 text-center text-xs text-amber-600">
            No cloned voice is set up yet. Activate a voice profile before starting a conversation.
          </p>
        )}

        {chat.notice && <p className="px-4 pt-2 text-center text-xs text-amber-600">{chat.notice}</p>}
        <GpuWaitDialog wait={chat.capacityWait} />
        <DismissibleNotice notice={chat.capacityBusy} />

        {/* The chip gets its own line above the composer. It used to be pinned
            out of flow beside the mic to save a row, but the composer row is
            now a full-width text field with nothing to sit beside — and at one
            row instead of the old mic hero, the panel can afford the line. It
            still steps aside once a conversation is live, which is when the
            voice has stopped being a question. */}
        <div className="px-3 pb-3 pt-2 sm:px-4">
          {chat.activeVoiceLabel && !chat.voiceActive && (
            <div className="mb-2 flex justify-center">
              <VoiceIndicator label={chat.activeVoiceLabel} compact />
            </div>
          )}

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
        </div>
      </div>

      {/* Cloned-voice playback. Driven imperatively — see useGiReplyAudio. */}
      <audio {...audioProps} />
    </div>
  );
}
