import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ToastProvider } from './context/ToastContext';

// Layouts
import AdminLayout from './layouts/AdminLayout';

// Pages
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import KnowledgeBase from './pages/KnowledgeBase';
import Interface from './pages/Interface';
import Analytics from './pages/Analytics';
import Users from './pages/Users';
import Feedback from './pages/Feedback';
import Settings from './pages/Settings';
import Chatbot from './pages/Chatbot';
import Leads from './pages/Leads';
import LiveChat from './pages/LiveChat';
import WhatsApp from './pages/integrations/WhatsApp';
import Email from './pages/integrations/Email';

// Superadmin
import SuperadminLayout from './layouts/SuperadminLayout';
import SuperadminOverview from './pages/superadmin/Overview';
import SuperadminClients from './pages/superadmin/Clients';
import SuperadminFeedback from './pages/superadmin/Feedback';

const ProtectedRoute = ({ children }) => {
    const isAuthenticated = !!localStorage.getItem('admin_token');
    if (!isAuthenticated) return <Navigate to="/login" replace />;
    return children;
};

const SuperadminRoute = ({ children }) => {
    const isAuthenticated = !!localStorage.getItem('admin_token');
    const isSuperadmin = localStorage.getItem('is_superadmin') === 'true';
    if (!isAuthenticated) return <Navigate to="/login" replace />;
    if (!isSuperadmin) return <Navigate to="/" replace />;
    return children;
};

function App() {
    return (
        <ToastProvider>
            <BrowserRouter>
                <Routes>
                    {/* Public */}
                    <Route path="/login" element={<Login />} />
                    <Route path="/register" element={<Register />} />

                    {/* App Routes (root) */}
                    <Route
                        path="/"
                        element={
                            <ProtectedRoute>
                                <AdminLayout />
                            </ProtectedRoute>
                        }
                    >
                        <Route index element={<Dashboard />} />
                        <Route path="knowledge" element={<KnowledgeBase />} />
                        <Route path="chatbot" element={<Chatbot />} />
                        <Route path="interface" element={<Interface />} />
                        <Route path="analytics" element={<Analytics />} />
                        <Route path="leads" element={<Leads />} />
                        <Route path="live-chat" element={<LiveChat />} />
                        <Route path="users" element={<Users />} />
                        <Route path="feedback" element={<Feedback />} />
                        <Route path="settings" element={<Settings />} />
                        <Route path="integrations/whatsapp" element={<WhatsApp />} />
                        <Route path="integrations/email" element={<Email />} />
                    </Route>

                    {/* Backwards compat: /admin/* → /* */}
                    <Route path="/admin" element={<Navigate to="/" replace />} />
                    <Route path="/admin/*" element={<Navigate to="/" replace />} />

                    {/* Superadmin */}
                    <Route
                        path="/superadmin"
                        element={
                            <SuperadminRoute>
                                <SuperadminLayout />
                            </SuperadminRoute>
                        }
                    >
                        <Route path="overview" element={<SuperadminOverview />} />
                        <Route path="clients" element={<SuperadminClients />} />
                        <Route path="feedback" element={<SuperadminFeedback />} />
                    </Route>

                    <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
            </BrowserRouter>
        </ToastProvider>
    );
}

export default App;
