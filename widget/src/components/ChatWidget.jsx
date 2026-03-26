import React, { useState, useEffect } from 'react';
import Launcher from './Launcher';
import ChatWindow from './ChatWindow';
import { getChatbotSettings } from '../services/api';

const ChatWidget = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [settings, setSettings] = useState({
    bot_name: 'OyeChat AI',
    bot_logo: null,
    launcher_name: 'Have Questions?',
    launcher_logo: null,
    primary_color: '#3A0CA3',
    header_color: '#3A0CA3',
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

  const toggleChat = () => {
    setIsOpen(!isOpen);
  };

  return (
    <>
      {isOpen && (
        <ChatWindow 
          onClose={() => setIsOpen(false)} 
          initialSettings={settings}
        />
      )}
      <div className="fixed bottom-6 right-6 z-[9999] flex flex-col items-end gap-4">
        <Launcher 
          isOpen={isOpen} 
          toggleChat={toggleChat} 
          settings={settings}
        />
      </div>
    </>
  );
};

export default ChatWidget;
