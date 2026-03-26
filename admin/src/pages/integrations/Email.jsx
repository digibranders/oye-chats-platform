import React from 'react';
import { EmailIcon } from '../../components/Icons';

const Email = () => {
  return (
    <div className="p-6">
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900 dark:text-white flex items-center gap-3">
             <EmailIcon className="w-7 h-7 shadow-sm rounded-sm" />
             Email Integration
          </h1>
          <p className="text-secondary-500 dark:text-secondary-400 mt-1">
            Configure your Email integration settings here.
          </p>
        </div>
      </div>

      <div className="bg-white dark:bg-secondary-800 rounded-2xl shadow-sm border border-secondary-200 dark:border-secondary-700 p-6">
        <div className="max-w-2xl">
           <p className="text-secondary-600 dark:text-secondary-300 mb-6">
             Configure SMTP or API settings to allow the system to send email notifications and engage with visitors via Email.
           </p>

           <div className="space-y-4">
               <div>
                  <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1">
                      Provider
                  </label>
                  <select className="w-full px-4 py-2 bg-secondary-50 dark:bg-secondary-900 border border-secondary-200 dark:border-secondary-700 rounded-lg text-secondary-900 dark:text-white">
                      <option value="smtp">Custom SMTP</option>
                      <option value="sendgrid">SendGrid</option>
                      <option value="mailgun">Mailgun</option>
                      <option value="aws_ses">Amazon SES</option>
                  </select>
               </div>
               
               <div>
                  <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1">
                      SMTP Host
                  </label>
                  <input
                      type="text"
                      className="w-full px-4 py-2 bg-secondary-50 dark:bg-secondary-900 border border-secondary-200 dark:border-secondary-700 rounded-lg text-secondary-900 dark:text-white"
                      placeholder="e.g. smtp.example.com"
                  />
               </div>

               <div className="grid grid-cols-2 gap-4">
                   <div>
                      <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1">
                          SMTP Port
                      </label>
                      <input
                          type="text"
                          className="w-full px-4 py-2 bg-secondary-50 dark:bg-secondary-900 border border-secondary-200 dark:border-secondary-700 rounded-lg text-secondary-900 dark:text-white"
                          placeholder="e.g. 587"
                      />
                   </div>
                   <div>
                      <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1">
                          Security
                      </label>
                      <select className="w-full px-4 py-2 bg-secondary-50 dark:bg-secondary-900 border border-secondary-200 dark:border-secondary-700 rounded-lg text-secondary-900 dark:text-white">
                          <option value="tls">TLS</option>
                          <option value="ssl">SSL</option>
                          <option value="none">None</option>
                      </select>
                   </div>
               </div>
               
               <div>
                  <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1">
                      Username
                  </label>
                  <input
                      type="text"
                      className="w-full px-4 py-2 bg-secondary-50 dark:bg-secondary-900 border border-secondary-200 dark:border-secondary-700 rounded-lg text-secondary-900 dark:text-white"
                      placeholder="SMTP Username"
                  />
               </div>
               
               <div>
                  <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1">
                      Password
                  </label>
                  <input
                      type="password"
                      className="w-full px-4 py-2 bg-secondary-50 dark:bg-secondary-900 border border-secondary-200 dark:border-secondary-700 rounded-lg text-secondary-900 dark:text-white"
                      placeholder="SMTP Password"
                  />
               </div>


               <div className="pt-4">
                   <button className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition">
                       Save Configuration
                   </button>
               </div>
           </div>
        </div>
      </div>
    </div>
  );
};

export default Email;
