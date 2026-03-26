import { Code2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function TopBar() {
    const navigate = useNavigate();
    const adminName = localStorage.getItem('admin_name') || 'Admin';

    const handleLogout = () => {
        localStorage.removeItem('admin_token');
        localStorage.removeItem('admin_name');
        localStorage.removeItem('admin_client_id');
        navigate('/login');
    };

    return (
        <header className="h-16 bg-white dark:bg-secondary-800 border-b border-secondary-200 dark:border-secondary-700 px-6 flex items-center justify-between sticky top-0 z-50 shadow-sm transition-colors">
            <div className="flex items-center flex-1">
                {/* Search removed for multi-tenant admin */}
            </div>

            <div className="flex items-center gap-5">


                <div className="flex items-center gap-3">
                    <div className="hidden md:flex flex-col items-end">
                        <span className=" text-sm font-semibold text-secondary-900 dark:text-white">{adminName}</span>
                    </div>
                    {/* <span className="text-xs font-medium text-primary-600 flex items-center gap-1">
    
                        </span> */}
                </div>

                <div className="relative group">
                    <button className="flex items-center outline-none">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-primary-600 to-primary-400 text-white flex items-center justify-center font-bold text-lg shadow-sm group-hover:shadow-md transition-all">
                            {adminName.charAt(0)}
                        </div>
                    </button>

                    <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-secondary-800 border border-secondary-200 dark:border-secondary-700 rounded-xl shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all transform origin-top-right">
                        <div className="px-4 py-3 border-b border-secondary-100 dark:border-secondary-700">
                            <p className="text-sm text-secondary-900 dark:text-white font-medium">Logged in as</p>
                            <p className="mt-1 text-xs text-secondary-500 dark:text-secondary-400 truncate">{adminName}</p>
                        </div>
                        <div className="p-1">
                            <button
                                onClick={handleLogout}
                                className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors font-medium"
                            >
                                Logout
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </header>
    );
}
