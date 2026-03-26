import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

// Layouts component
import AdminLayout from './layouts/AdminLayout';

// Page components
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
import WhatsApp from './pages/integrations/WhatsApp';
import Email from './pages/integrations/Email';

// Superadmin Layout & Pages
import SuperadminLayout from './layouts/SuperadminLayout';
import SuperadminOverview from './pages/superadmin/Overview';
import SuperadminClients from './pages/superadmin/Clients';
import SuperadminFeedback from './pages/superadmin/Feedback';

// Protected Route Wrapper
const ProtectedRoute = ({ children }) => {
  const isAuthenticated = !!localStorage.getItem('admin_token');

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return children;
};

// Superadmin Protected Route Wrapper
const SuperadminRoute = ({ children }) => {
  const isAuthenticated = !!localStorage.getItem('admin_token');
  const isSuperadmin = localStorage.getItem('is_superadmin') === 'true';

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (!isSuperadmin) {
    return <Navigate to="/admin" replace />;
  }

  return children;
};

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public Routes */}
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />

        {/* Protected Admin Routes */}
        <Route
          path="/admin"
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
          <Route path="users" element={<Users />} />
          <Route path="feedback" element={<Feedback />} />
          <Route path="settings" element={<Settings />} />
          <Route path="integrations/whatsapp" element={<WhatsApp />} />
          <Route path="integrations/email" element={<Email />} />
        </Route>

        {/* Superadmin Routes */}
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

        {/* Catch-all redirect */}
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
