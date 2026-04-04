import React, { useState, useEffect, useRef, useCallback } from 'react';
import Launcher from './Launcher';
import ChatWindow from './ChatWindow';
import { getChatbotSettings } from '../services/api';

const OPEN_DURATION = 300;  // ms — matches widgetOpen animation (280ms + buffer)
const CLOSE_DURATION = 220; // ms — matches widgetClose animation (200ms + buffer)

/**
 * Returns true if the current time is within the bot's configured business hours.
 * Returns true (open) when business_hours is absent or disabled.
 */
function isWithinBusinessHours(businessHours) {
  if (!businessHours?.enabled) return true;

  try {
    const tz = businessHours.timezone || 'UTC';
    const now = new Date();

    // Resolve current day key (mon/tue/.../sun) in the bot's timezone
    const dayName = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' }).toLowerCase();
    const dayKey = dayName.slice(0, 3); // "mon", "tue", etc.

    const day = businessHours.days?.[dayKey];
    if (!day?.enabled) return false;

    // Resolve current HH:MM in the bot's timezone
    const timeParts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);

    const hour = timeParts.find((p) => p.type === 'hour')?.value ?? '00';
    const minute = timeParts.find((p) => p.type === 'minute')?.value ?? '00';
    const currentTime = `${hour}:${minute}`;

    return currentTime >= day.start && currentTime <= day.end;
  } catch {
    // Fallback: treat as open on any parsing error (e.g. unknown timezone)
    return true;
  }
}

const ChatWidget = () => {
  const [isVisible, setIsVisible] = useState(false);   // controls DOM presence
  const [isAnimating, setIsAnimating] = useState(null); // null=hidden(no anim), true=open, false=close
  const closeTimer = useRef(null);
  const [settings, setSettings] = useState({
    bot_name: 'OyeChats AI',
    bot_logo: null,
    launcher_name: 'Have Questions?',
    launcher_logo: null,
    primary_color: '#2B66BC',
    header_color: '#2B66BC',
    background_color: '#ffffff',
    business_hours: null,
    feature_flags: {},
  });

  // Derived: is the bot currently "online" per its business hours schedule?
  const isOnline = isWithinBusinessHours(settings.business_hours);

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const fetchedSettings = await getChatbotSettings();
        if (fetchedSettings) {
          setSettings(fetchedSettings);
        }
      } catch (error) {
        console.error("Failed to load settings in widget:", error);
      }
    };
    fetchSettings();
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  const openChat = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setIsVisible(true);
    // Allow React to paint widget-hidden state, then trigger open animation
    setTimeout(() => {
      setIsAnimating(true);
      // After open animation completes, use static class so component switches don't re-trigger animation
      setTimeout(() => setIsAnimating('done'), OPEN_DURATION);
    }, 20);
  }, []);

  const closeChat = useCallback(() => {
    setIsAnimating(false); // triggers close animation
    closeTimer.current = setTimeout(() => {
      setIsVisible(false); // unmount after animation
      closeTimer.current = null;
    }, CLOSE_DURATION);
  }, []);

  const toggleChat = useCallback(() => {
    if (isVisible && (isAnimating === true || isAnimating === 'done')) {
      closeChat();
    } else if (!isVisible) {
      openChat();
    }
  }, [isVisible, isAnimating, openChat, closeChat]);

  return (
    <>
      {isVisible && (
        <ChatWindow
          onClose={closeChat}
          initialSettings={settings}
          isAnimating={isAnimating}
          isOnline={isOnline}
        />
      )}
      {/* Launcher fades out while chat is open — LiveChat/Intercom pattern.
          Kept in DOM (not unmounted) so it can fade back in after the close animation. */}
      <div
        className="fixed bottom-6 right-6 z-[9999] flex flex-col items-end gap-4 transition-opacity duration-200"
        style={{ opacity: isVisible ? 0 : 1, pointerEvents: isVisible ? 'none' : 'auto' }}
      >
        <Launcher
          isOpen={false}
          toggleChat={toggleChat}
          settings={settings}
        />
      </div>
    </>
  );
};

export default ChatWidget;
