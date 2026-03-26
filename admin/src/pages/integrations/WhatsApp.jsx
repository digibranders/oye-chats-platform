import React from 'react';
import { WhatsAppIcon } from '../../components/Icons';

const WhatsApp = () => {
  return (
    <div className="p-6">
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900 dark:text-white flex items-center gap-3">
             <WhatsAppIcon className="w-7 h-7" />
             WhatsApp Integration
          </h1>
          <p className="text-secondary-500 dark:text-secondary-400 mt-1">
            Configure your WhatsApp integration settings here.
          </p>
        </div>
      </div>

      <div className="bg-white dark:bg-secondary-800 rounded-2xl shadow-sm border border-secondary-200 dark:border-secondary-700 p-6">
        <div className="max-w-2xl">
           <p className="text-secondary-600 dark:text-secondary-300 mb-6">
             Connect your WhatsApp Business API to allow the chatbot to interact with users directly on WhatsApp.
           </p>

           <div className="space-y-4">
               <div>
                  <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1">
                      Phone Number ID
                  </label>
                  <input
                      type="text"
                      className="w-full px-4 py-2 bg-secondary-50 dark:bg-secondary-900 border border-secondary-200 dark:border-secondary-700 rounded-lg text-secondary-900 dark:text-white"
                      placeholder="e.g. 10123456789"
                  />
               </div>
               
               <div>
                  <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1">
                      WhatsApp Business Account ID
                  </label>
                  <input
                      type="text"
                      className="w-full px-4 py-2 bg-secondary-50 dark:bg-secondary-900 border border-secondary-200 dark:border-secondary-700 rounded-lg text-secondary-900 dark:text-white"
                      placeholder="e.g. 10987654321"
                  />
               </div>

               <div>
                  <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1">
                      Access Token
                  </label>
                  <input
                      type="password"
                      className="w-full px-4 py-2 bg-secondary-50 dark:bg-secondary-900 border border-secondary-200 dark:border-secondary-700 rounded-lg text-secondary-900 dark:text-white"
                      placeholder="Permanent or Temporary Access Token"
                  />
               </div>

               <div className="pt-4">
                   <button className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition">
                       Save Connection
                   </button>
               </div>
           </div>
        </div>
      </div>
    </div>
  );
};

export default WhatsApp;
