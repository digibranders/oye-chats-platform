import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ToastProvider } from './context/ToastContext';

// Layouts
import AdminLayout from './layouts/AdminLayout';

// Pages
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import Dashboard from './pages/Dashboard';
import KnowledgeBase from './pages/KnowledgeBase';
import Settings from './pages/Settings';
import Chatbot from './pages/Chatbot';
import Leads from './pages/Leads';
import Insights from './pages/Insights';
import Support from './pages/Support';
import TeamManagement from './pages/TeamManagement';
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
                    <Route path="/forgot-password" element={<ForgotPassword />} />

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
                        <Route path="insights" element={<Insights />} />
                        <Route path="support" element={<Support />} />
                        <Route path="leads" element={<Leads />} />
                        <Route path="team" element={<TeamManagement />} />
                        <Route path="settings" element={<Settings />} />
                        <Route path="integrations/email" element={<Email />} />

                        {/* Redirects for old URLs */}
                        <Route path="analytics" element={<Navigate to="/insights?tab=analytics" replace />} />
                        <Route path="users" element={<Navigate to="/insights?tab=conversations" replace />} />
                        <Route path="feedback" element={<Navigate to="/insights?tab=feedback" replace />} />
                        <Route path="live-chat" element={<Navigate to="/support?tab=live-chat" replace />} />
                        <Route path="messages" element={<Navigate to="/support?tab=messages" replace />} />
                        <Route path="interface" element={<Navigate to="/chatbot?tab=appearance" replace />} />
                        <Route path="canned-responses" element={<Navigate to="/team" replace />} />
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
