import React, { useState, useEffect, useRef, useCallback } from 'react';
import Launcher from './Launcher';
import ChatWindow from './ChatWindow';
import { getChatbotSettings } from '../services/api';

const OPEN_DURATION = 280;  // ms — matches widgetOpen animation
const CLOSE_DURATION = 180; // ms — matches widgetClose animation

const ChatWidget = () => {
  const [isVisible, setIsVisible] = useState(false);   // controls DOM presence
  const [isAnimating, setIsAnimating] = useState(null); // null=hidden(no anim), true=open, false=close
  const closeTimer = useRef(null);
  const [settings, setSettings] = useState({
    bot_name: 'OyeChat AI',
    bot_logo: null,
    launcher_name: 'Have Questions?',
    launcher_logo: null,
    primary_color: '#2B66BC',
    header_color: '#2B66BC',
    background_color: '#ffffff'
  });

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
        />
      )}
      <div className="fixed bottom-6 right-6 z-[9999] flex flex-col items-end gap-4">
        <Launcher
          isOpen={isVisible && isAnimating !== null}
          toggleChat={toggleChat}
          settings={settings}
        />
      </div>
    </>
  );
};

export default ChatWidget;
