'use client';

import React, { useEffect, useRef, useState } from 'react';

const REACTIONS = ['👏', '❤️', '😂', '🎉', '👍', '🔥'];

function Icon({ name, size = 18 }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  };

  const paths = {
    mic: <><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"/></>,
    micOff: <><path d="m3 3 18 18M9 9v3a3 3 0 0 0 5.1 2.1M15 10V5a3 3 0 0 0-5.7-1.3M17.4 17.4A7 7 0 0 1 5 12v-2M19 10v2c0 .7-.1 1.4-.3 2M12 19v3M8 22h8"/></>,
    camera: <><path d="m16 10 5-3v10l-5-3"/><rect x="3" y="5" width="13" height="14" rx="2"/></>,
    cameraOff: <><path d="m3 3 18 18M10.5 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-1M16 8l5-3v10l-3-1.8"/></>,
    screen: <><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></>,
    tools: <><path d="M14.7 6.3a4 4 0 0 0-5-5L7.5 3.5l3 3 2.2-2.2a4 4 0 0 0 2 2ZM9.3 17.7a4 4 0 0 0 5 5l2.2-2.2-3-3-2.2 2.2a4 4 0 0 0-2-2Z"/><path d="m8 8 8 8"/></>,
    code: <><path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"/></>,
    board: <><path d="M4 3h16v12H4zM8 21l4-6 4 6M8 8h8M8 11h5"/></>,
    notes: <><path d="M6 3h12v18H6zM9 7h6M9 11h6M9 15h4"/></>,
    browser: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></>,
    timer: <><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5M9 2h6"/></>,
    chat: <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>,
    people: <><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6M17 11h6"/></>,
    hand: <path d="M8 11V5a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v7-3a1.5 1.5 0 0 1 3 0v4c0 5-3 8-8 8h-1c-3 0-5-2-7-5l-2-3a1.7 1.7 0 0 1 2.7-2l3.3 3"/>,
    timeline: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    follow: <><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/></>,
    share: <><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5"/></>,
    export: <><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/></>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
    leave: <><path d="M6 8c4-2 8-2 12 0l2 4-4 2-2-3H10l-2 3-4-2 2-4Z"/></>,
  };

  return <svg {...common}>{paths[name]}</svg>;
}

function DockButton({
  icon,
  label,
  displayLabel = label,
  active = false,
  danger = false,
  critical = false,
  badge,
  className = '',
  ...props
}) {
  return (
    <button
      type="button"
      className={`relative flex h-14 w-12 shrink-0 flex-col items-center justify-center gap-1 rounded-[10px] border px-1 text-[var(--on-surface)] transition-[background-color,border-color,color,transform] duration-150 disabled:cursor-not-allowed disabled:opacity-35 max-[360px]:w-10 sm:h-[3.75rem] sm:w-14 md:w-[4.5rem] ${
        critical
          ? 'border-[#ef5358] bg-[#e5484d] text-white shadow-[0_5px_16px_rgba(229,72,77,0.28)] hover:border-[#f4666b] hover:bg-[#ed555a]'
          : danger
            ? 'border-red-400/20 bg-red-500/15 text-[#ff9da1] hover:border-red-400/30 hover:bg-red-500/20'
          : active
            ? 'border-[#5689f5]/50 bg-[#315fda]/30 text-[#dce8ff]'
            : 'border-transparent text-[#d9dee7] hover:border-white/10 hover:bg-white/[0.08] hover:text-white'
      } ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      <Icon name={icon} />
      <span className="block max-w-full truncate text-[10px] font-semibold leading-none tracking-[-0.01em] sm:text-[11px] md:text-xs">
        {displayLabel}
      </span>
      {badge != null && (
        <span className="absolute right-0.5 top-0.5 grid h-[17px] min-w-[17px] place-items-center rounded-full border-2 border-[#151a22] bg-[#4f7fe8] px-0.5 text-[9px] font-bold leading-none text-white">
          {badge}
        </span>
      )}
    </button>
  );
}

export default function CallControls({
  isMuted = false,
  isCameraOff = false,
  isScreenSharing = false,
  canShareScreen = true,
  canEdit = true,
  isHost = false,
  isHandRaised = false,
  followingPresenter = false,
  unreadChatCount = 0,
  participantCount = 1,
  onToggleMic,
  onToggleCamera,
  onToggleScreenShare,
  onOpenWidget,
  canUseWidget,
  onToggleParticipants,
  onToggleChat,
  onToggleTimeline,
  onToggleFollow,
  onToggleRaiseHand,
  onSendReaction,
  onShareLink,
  onExport,
  onEndCall,
  onEndForAll,
}) {
  const [menu, setMenu] = useState(null);
  const barRef = useRef(null);

  useEffect(() => {
    if (!menu) return undefined;
    const onDown = (event) => {
      if (!barRef.current?.contains(event.target)) setMenu(null);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setMenu(null);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menu]);

  const widgets = [
    { type: 'CODE_EDITOR', icon: 'code', label: 'Code editor' },
    { type: 'WHITEBOARD', icon: 'board', label: 'Whiteboard' },
    { type: 'NOTES', icon: 'notes', label: 'Live notes' },
    { type: 'WEB_BROWSER', icon: 'browser', label: 'Shared browser' },
    { type: 'MEETING_TIMER', icon: 'timer', label: 'Meeting timer' },
  ];

  const tray = 'room-drawer absolute bottom-[4rem] z-50 p-2 text-[var(--on-surface)] sm:bottom-[4.4rem]';
  const menuRow = 'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs font-medium transition-colors hover:bg-white/[0.07]';

  return (
    <div
      ref={barRef}
      className="control-dock ftos-rise fixed bottom-3 left-1/2 z-50 flex max-w-[calc(100vw-1rem)] -translate-x-1/2 items-center gap-0.5 p-1 sm:bottom-4 sm:gap-1 sm:p-1.5"
      aria-label="Meeting controls"
    >
      <DockButton
        icon={isMuted ? 'micOff' : 'mic'}
        label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
        displayLabel={<><span className="hidden md:inline">Microphone</span><span className="md:hidden">Mic</span></>}
        danger={isMuted}
        onClick={onToggleMic}
        aria-pressed={isMuted}
      />
      <DockButton icon={isCameraOff ? 'cameraOff' : 'camera'} label={isCameraOff ? 'Start camera' : 'Stop camera'} displayLabel="Camera" danger={isCameraOff} onClick={onToggleCamera} aria-pressed={isCameraOff} />
      {onToggleScreenShare && (
        <DockButton
          icon="screen"
          label={isScreenSharing ? 'Stop sharing' : 'Share screen'}
          displayLabel="Screen"
          active={isScreenSharing}
          disabled={!canShareScreen}
          onClick={onToggleScreenShare}
          aria-pressed={isScreenSharing}
          className="max-[420px]:hidden"
        />
      )}

      <span className="mx-1 hidden h-8 w-px bg-white/10 sm:block" aria-hidden="true" />

      <div className="relative">
        <DockButton
          icon="tools"
          label="Tools"
          active={menu === 'widgets'}
          disabled={!canEdit}
          onClick={() => setMenu((value) => (value === 'widgets' ? null : 'widgets'))}
          aria-expanded={menu === 'widgets'}
        />
        {menu === 'widgets' && (
          <div className={`${tray} left-0 w-56`} role="menu" aria-label="Room tools">
            <p className="px-3 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--on-surface-muted)]">Open in the room</p>
            {widgets.map((widget) => {
              const locked = canUseWidget ? !canUseWidget(widget.type) : false;
              return (
                <button
                  key={widget.type}
                  type="button"
                  onClick={() => {
                    onOpenWidget?.(widget.type);
                    setMenu(null);
                  }}
                  className={menuRow}
                  title={locked ? `Ask the host for ${widget.label.toLowerCase()} access` : undefined}
                >
                  <Icon name={widget.icon} size={16} />
                  <span className="flex-1">{widget.label}</span>
                  {locked && (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label="Access required"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <DockButton icon="chat" label="Chat" badge={unreadChatCount > 0 ? (unreadChatCount > 9 ? '9+' : unreadChatCount) : null} onClick={onToggleChat} />
      <DockButton icon="people" label="People" badge={participantCount} onClick={onToggleParticipants} />

      <div className="relative">
        <DockButton icon="more" label="More" active={menu === 'more'} onClick={() => setMenu((value) => (value === 'more' ? null : 'more'))} aria-expanded={menu === 'more'} />
        {menu === 'more' && (
          <div className={`${tray} right-0 w-60`} role="menu" aria-label="More meeting actions">
            <div className="mb-2 grid grid-cols-6 gap-1 border-b border-[var(--surface-border)] pb-2">
              {REACTIONS.map((reaction) => (
                <button
                  key={reaction}
                  type="button"
                  onClick={() => { onSendReaction?.(reaction); setMenu(null); }}
                  className="grid h-8 place-items-center rounded-md text-base transition-colors hover:bg-[var(--bg-muted)]"
                  aria-label={`React ${reaction}`}
                >
                  {reaction}
                </button>
              ))}
            </div>
            {onToggleRaiseHand && (
              <button type="button" onClick={() => { onToggleRaiseHand(); setMenu(null); }} className={`${menuRow} ${isHandRaised ? 'text-amber-600 dark:text-amber-300' : ''}`}>
                <Icon name="hand" size={16} /><span>{isHandRaised ? 'Lower hand' : 'Raise hand'}</span>
              </button>
            )}
            {onToggleTimeline && <button type="button" onClick={() => { onToggleTimeline(); setMenu(null); }} className={menuRow}><Icon name="timeline" size={16} /><span>Session timeline</span></button>}
            {onToggleFollow && <button type="button" onClick={() => { onToggleFollow(); setMenu(null); }} className={`${menuRow} ${followingPresenter ? 'text-blue-600 dark:text-blue-300' : ''}`}><Icon name="follow" size={16} /><span>{followingPresenter ? 'Stop following' : 'Follow presenter'}</span></button>}
            {onShareLink && <button type="button" onClick={() => { onShareLink(); setMenu(null); }} className={menuRow}><Icon name="share" size={16} /><span>Copy invite link</span></button>}
            {onExport && <button type="button" onClick={() => { onExport(); setMenu(null); }} className={menuRow}><Icon name="export" size={16} /><span>Export session</span></button>}
          </div>
        )}
      </div>

      <span className="mx-1 hidden h-8 w-px bg-white/10 sm:block" aria-hidden="true" />

      <div className="relative">
        <DockButton
          icon="leave"
          label={isHost && onEndForAll ? 'Leave options' : 'Leave meeting'}
          displayLabel="Leave"
          critical
          onClick={() => {
            if (isHost && onEndForAll) {
              setMenu((value) => (value === 'end' ? null : 'end'));
              return;
            }
            onEndCall?.();
          }}
          aria-expanded={isHost && onEndForAll ? menu === 'end' : undefined}
          aria-haspopup={isHost && onEndForAll ? 'menu' : undefined}
        />
        {menu === 'end' && (
          <div className={`${tray} right-0 w-72 p-1.5`} role="menu" aria-label="Leave meeting options">
            <button
              type="button"
              onClick={() => {
                setMenu(null);
                onEndCall?.();
              }}
              className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-white/[0.07]"
              role="menuitem"
            >
              <span className="mt-0.5 text-[#d9dee7]"><Icon name="leave" size={16} /></span>
              <span>
                <span className="block text-xs font-semibold text-white">Leave meeting</span>
                <span className="mt-0.5 block text-[10px] leading-relaxed text-[var(--on-surface-muted)]">The room stays open for everyone else.</span>
              </span>
            </button>
            <div className="mx-2 h-px bg-white/10" />
            <button
              type="button"
              onClick={() => {
                setMenu(null);
                onEndForAll?.();
              }}
              className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-red-500/10"
              role="menuitem"
            >
              <span className="mt-0.5 text-[#ff8589]"><Icon name="leave" size={16} /></span>
              <span>
                <span className="block text-xs font-semibold text-[#ff8589]">End meeting for everyone</span>
                <span className="mt-0.5 block text-[10px] leading-relaxed text-[var(--on-surface-muted)]">Disconnect every participant and close the room.</span>
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
