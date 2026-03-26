export const themeConfigs = {
    classic: {
        container: "w-full h-full md:w-[370px] md:h-[560px] md:max-h-[calc(100vh-100px)] fixed md:right-6 md:bottom-24 right-0 bottom-0 bg-white md:rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-gray-100 animate-slide-up origin-bottom-right z-[9999]",
        header: "bg-[#3A0CA3] p-4 flex items-center justify-between text-white shrink-0 border-b border-gray-200/50",
        headerBorder: "border-2 border-[#E8A87C]",
        statusDot: "bg-green-400 border-[#3A0CA3]",
        messagesArea: "flex-1 overflow-y-auto p-4 bg-white flex flex-col gap-5",
        userBubble: "bg-[#3A0CA3] text-white rounded-2xl",
        botBubble: "bg-white text-gray-800 shadow-sm border border-gray-200 rounded-2xl",
        inputArea: "p-4 bg-white border-t border-gray-100 shrink-0",
        inputBg: "bg-gray-100 focus:bg-white border-transparent focus:border-[#3A0CA3] text-gray-900 placeholder:text-gray-500",
        sendBtn: "bg-[#3A0CA3] hover:bg-[#3A0CA3]/90"
    },
    modern: {
        container: "w-full h-full md:w-[370px] md:h-[560px] md:max-h-[calc(100vh-100px)] fixed md:right-6 md:bottom-24 right-0 bottom-0 bg-[#0F172A]/95 backdrop-blur-xl md:rounded-[2.5rem] shadow-[0_0_50px_-12px_rgba(58,12,163,0.5)] flex flex-col overflow-hidden border border-white/10 animate-slide-up origin-bottom-right z-[9999]",
        header: "bg-gradient-to-r from-[#3A0CA3] to-[#7209B7] p-6 flex items-center justify-between text-white shrink-0 border-b border-white/10",
        headerBorder: "border-2 border-white/20",
        statusDot: "bg-cyan-400 border-[#3A0CA3]",
        messagesArea: "flex-1 overflow-y-auto p-6 bg-transparent flex flex-col gap-5",
        userBubble: "bg-[#4361EE] text-white rounded-3xl rounded-tr-md shadow-lg shadow-blue-500/20",
        botBubble: "bg-white/5 backdrop-blur-md text-gray-100 border border-white/10 rounded-3xl rounded-tl-md",
        inputArea: "p-6 bg-transparent shrink-0",
        inputBg: "bg-white/5 border-white/10 focus:border-[#4361EE] text-white placeholder:text-white/40",
        sendBtn: "bg-[#4361EE] hover:bg-[#4895EF] shadow-lg shadow-blue-500/40"
    },
    minimalist: {
        container: "w-full h-full md:w-[370px] md:h-[560px] md:max-h-[calc(100vh-100px)] fixed md:right-6 md:bottom-24 right-0 bottom-0 bg-white md:rounded-3xl shadow-xl flex flex-col overflow-hidden border border-gray-200 animate-slide-up origin-bottom-right z-[9999]",
        header: "bg-white p-5 flex items-center justify-between text-gray-900 border-b border-gray-100 shrink-0",
        headerBorder: "border border-gray-200",
        statusDot: "bg-emerald-500 border-white",
        messagesArea: "flex-1 overflow-y-auto p-5 bg-white flex flex-col gap-6",
        userBubble: "bg-gray-900 text-white rounded-3xl rounded-tr-md",
        botBubble: "bg-gray-100 text-gray-700 rounded-3xl rounded-tl-md",
        inputArea: "p-5 bg-white border-t border-gray-100 shrink-0",
        inputBg: "bg-gray-100 focus:bg-white border-transparent focus:border-gray-300 rounded-2xl text-gray-900 placeholder:text-gray-500",
        sendBtn: "bg-gray-900 hover:bg-black rounded-2xl"
    }
};
